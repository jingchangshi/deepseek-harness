import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { dump, load } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recoverEngineeringTask, runEngineeringTask } from '../src/automatic.ts'
import type { RoleInvocation } from '../src/automatic.ts'
import { loadHarnessConfig, resolveRoleAttempts, resolveRoleEscalations } from '../src/config.ts'
import { CapabilityInsufficientError, RoleInvocationError, RoleQuiescenceError, runRoleAttempts } from '../src/role-execution.ts'
import { TaskRepository } from '../src/repository.ts'
import { TaskSchedulingRepository } from '../src/scheduling.ts'
import { runEngineeringReview } from '../src/review-only.ts'

const roots: string[] = []
const insufficient = { response: { status: 'escalate', reason: 'EVIDENCE_INSUFFICIENT', details: 'The bounded source evidence needs stronger interpretation', partial: { observations: ['The source contains a lifecycle transition'], unresolvedQuestions: ['Does the transition preserve ownership?'] } } }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capability-dispatch-'))
  roots.push(root)
  await cp(resolve('.agent'), join(root, '.agent'), { recursive: true, filter: source => !source.includes(join('.agent', 'tasks')) && !source.includes(join('.agent', 'reviews')) })
  await writeFile(join(root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 40, maxRoleCalls: 30, commandTimeoutMs: 30_000 }))
  await writeFile(join(root, '.agent/adapters/test.yaml'), dump({ adapters: Object.fromEntries(['unit', 'typecheck', 'build'].map(name => [name, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }])) }))
  const modelsPath = join(root, '.agent/config/models.yaml')
  const models = load(await readFile(modelsPath, 'utf8')) as { routes: Record<string, Record<string, unknown>> }
  for (const [id, route] of Object.entries(models.routes)) route.capabilityLevel = id === 'architecture' ? 1 : 0
  models.routes['architecture-fallback'] = { ...models.routes.architecture, displayName: 'Stronger analysis fallback', model: 'configured-stronger-fallback-model', capabilityLevel: 1 }
  await writeFile(modelsPath, dump(models))
  const rolesPath = join(root, '.agent/config/roles.yaml')
  const roles = load(await readFile(rolesPath, 'utf8')) as { roles: Record<string, Record<string, unknown>> }
  for (const role of ['scout-secondary', 'implementer']) roles.roles[role] = { ...roles.roles[role], escalationRoutes: ['architecture'], escalationFallbackRoutes: ['architecture-fallback'], allowPremium: true }
  await writeFile(rolesPath, dump(roles))
  const workflowPath = join(root, '.agent/config/workflow.yaml')
  const workflow = load(await readFile(workflowPath, 'utf8')) as Record<string, unknown>
  await writeFile(workflowPath, dump({ ...workflow, maxCapabilityEscalations: 1, repairEscalationThreshold: 2 }))
  await execa('git', ['init', '-q'], { cwd: root })
  await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root })
  return { root, deployment: await loadHarnessConfig(root, { env: {} }) }
}

async function success(input: RoleInvocation) {
  if (input.role.startsWith('scout-')) return { findings: ['Fixture source scope identified'], hypotheses: [{ statement: 'The verification commands constrain the implementation', evidence: ['Fixture adapter'] }], unresolvedAssumptions: [] }
  if (input.role === 'architect') return { problemStatement: 'Keep fixture scope', hypotheses: ['No source changes are required'], selectedApproach: 'Verify existing source', rejectedAlternatives: ['Change unrelated source'], invariants: ['Keep unrelated files intact'], expectedComponents: ['answer.txt'], implementationScope: ['answer.txt'], falsificationTests: ['Reject invalid output'], acceptanceGates: ['unit'], unresolvedAssumptions: [] }
  if (input.role === 'implementer') return { summary: 'Kept the source unchanged' }
  return { decision: 'ACCEPT', summary: 'Checked source and deterministic commands', findings: [] }
}

const diagnosis = { summary: 'Replan before another writer', observations: ['Stopped implementation requires revised intent'], recommendation: 'REPLAN', repairConstraints: ['Preserve all retained source'], unresolvedQuestions: [] }

function isDiagnosis(input: RoleInvocation): boolean { return input.context.diagnosisObligation !== undefined }

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('separate provider fallback and capability escalation', () => {
  it('recovers a writer interrupted after pending diagnosis persistence but before lease release', async () => {
    const options = await fixture()
    let taskId = ''
    let diagnosisCalls = 0
    let writerCalls = 0
    const controller = new AbortController()
    const executeRole = async (input: RoleInvocation) => {
      taskId = input.taskId
      if (isDiagnosis(input)) { diagnosisCalls++; expect(input.route.writable).toBe(false); return diagnosis }
      if (input.role === 'implementer') { writerCalls++; return insufficient }
      return success(input)
    }
    const release = vi.spyOn(TaskRepository.prototype, 'releaseImplementation').mockRejectedValueOnce(new Error('Fixture interruption before writer lease release'))
    try {
      await runEngineeringTask({ ...options, request: 'Implement the bounded source', executeRole }).catch(() => undefined)
      expect(release).toHaveBeenCalledOnce()
    } finally { release.mockRestore() }
    const repository = new TaskRepository(options.root)
    const store = new TaskSchedulingRepository(options.root, taskId, 'development', { maxEscalations: 1 })
    expect((await repository.readState(taskId)).writer).not.toBeNull()
    expect((await store.read()).diagnoses).toEqual([expect.objectContaining({ status: 'PENDING' })])
    expect(diagnosisCalls).toBe(0)
    await expect(recoverEngineeringTask(options.root, taskId, false)).rejects.toThrow(/stop|confirm|writer/i)
    await recoverEngineeringTask(options.root, taskId, true)
    const apply = TaskSchedulingRepository.prototype.applyDiagnosis
    const stop = vi.spyOn(TaskSchedulingRepository.prototype, 'applyDiagnosis').mockImplementationOnce(async function (this: TaskSchedulingRepository, failureKey, revision) {
      const result = await apply.call(this, failureKey, revision)
      controller.abort(new Error('Fixture stops after durable diagnosis application'))
      return result
    })
    try { await runEngineeringTask({ ...options, taskId, request: '', signal: controller.signal, executeRole }).catch(() => undefined) }
    finally { stop.mockRestore() }
    expect(writerCalls).toBe(1)
    expect(diagnosisCalls).toBe(1)
    expect(await repository.readState(taskId)).toMatchObject({ state: 'REPLAN', writer: null })
    expect((await store.read()).diagnoses).toEqual([expect.objectContaining({ status: 'APPLIED', output: diagnosis })])
    expect((await store.read()).escalations).toEqual([expect.objectContaining({ status: 'COMPLETE', output: diagnosis })])
    await expect(repository.assertDispatchAdmission(taskId)).resolves.toBeUndefined()
  }, 30_000)

  it('reuses completed diagnosis and its durable application across both workflow interruption gaps', async () => {
    const options = await fixture()
    let taskId = ''
    let diagnosisCalls = 0
    let writerCalls = 0
    const executeRole = async (input: RoleInvocation) => {
      taskId = input.taskId
      if (isDiagnosis(input)) { diagnosisCalls++; return diagnosis }
      if (input.role === 'implementer') { writerCalls++; return insufficient }
      return success(input)
    }
    const complete = TaskSchedulingRepository.prototype.completeDiagnosis
    const completeCrash = vi.spyOn(TaskSchedulingRepository.prototype, 'completeDiagnosis').mockImplementationOnce(async function (this: TaskSchedulingRepository, failureKey, output, fingerprint) {
      await complete.call(this, failureKey, output, fingerprint)
      throw new Error('Fixture interruption after COMPLETE before application')
    })
    try { await runEngineeringTask({ ...options, request: 'Implement the bounded source', executeRole }).catch(() => undefined) }
    finally { completeCrash.mockRestore() }
    const repository = new TaskRepository(options.root)
    const store = new TaskSchedulingRepository(options.root, taskId, 'development', { maxEscalations: 1 })
    expect((await store.read()).diagnoses).toEqual([expect.objectContaining({ status: 'COMPLETE', output: diagnosis })])
    expect((await store.read()).escalations).toEqual([expect.objectContaining({ status: 'COMPLETE', output: diagnosis })])
    await expect(repository.assertDispatchAdmission(taskId)).rejects.toThrow(/diagnos|appl|obligation/i)
    const record = TaskSchedulingRepository.prototype.recordDiagnosisApplication
    const applicationCrash = vi.spyOn(TaskSchedulingRepository.prototype, 'recordDiagnosisApplication').mockImplementationOnce(async function (this: TaskSchedulingRepository, failureKey, application) {
      await record.call(this, failureKey, application)
      throw new Error('Fixture interruption after application journal before APPLIED')
    })
    try {
      await runEngineeringTask({ ...options, taskId, request: '', executeRole }).catch(() => undefined)
      expect(applicationCrash).toHaveBeenCalledOnce()
    }
    finally { applicationCrash.mockRestore() }
    expect(await repository.readState(taskId)).toMatchObject({ state: 'REPLAN', writer: null })
    expect((await store.read()).diagnoses[0]?.status).toBe('COMPLETE')
    await expect(repository.assertDispatchAdmission(taskId)).rejects.toThrow(/diagnos|appl|obligation/i)
    const controller = new AbortController()
    const apply = TaskSchedulingRepository.prototype.applyDiagnosis
    const stop = vi.spyOn(TaskSchedulingRepository.prototype, 'applyDiagnosis').mockImplementationOnce(async function (this: TaskSchedulingRepository, failureKey, revision) {
      const result = await apply.call(this, failureKey, revision)
      controller.abort(new Error('Fixture stops before another writer'))
      return result
    })
    try { await runEngineeringTask({ ...options, taskId, request: '', signal: controller.signal, executeRole }).catch(() => undefined) }
    finally { stop.mockRestore() }
    expect(diagnosisCalls).toBe(1)
    expect(writerCalls).toBe(1)
    expect((await store.read()).diagnoses).toEqual([expect.objectContaining({ status: 'APPLIED', output: diagnosis })])
    expect((await store.read()).escalations).toEqual([expect.objectContaining({ status: 'COMPLETE', output: diagnosis })])
    await expect(repository.assertDispatchAdmission(taskId)).resolves.toBeUndefined()
  }, 30_000)

  it('quarantines a read-only diagnosis that changes source before failing', async () => {
    const options = await fixture()
    let taskId = ''
    let diagnosisCalls = 0
    let writerCalls = 0
    const result = await runEngineeringTask({ ...options, request: 'Implement the bounded source', executeRole: async input => {
      taskId = input.taskId
      if (isDiagnosis(input)) {
        diagnosisCalls++
        await writeFile(join(options.root, 'unexpected.txt'), 'Retain unsafe diagnosis output')
        throw new RoleInvocationError('Diagnosis failed after source write', 'NON_FALLBACKABLE', false)
      }
      if (input.role === 'implementer') { writerCalls++; return insufficient }
      return success(input)
    } }).then(value => ({ value }), error => ({ error }))
    if ('value' in result) expect(result.value).toMatchObject({ status: 'BLOCKED', requiresStopConfirmation: true })
    else expect(result.error).toBeInstanceOf(RoleQuiescenceError)
    expect(diagnosisCalls).toBe(1)
    expect(writerCalls).toBe(1)
    const store = new TaskSchedulingRepository(options.root, taskId, 'development', { maxEscalations: 1 })
    expect((await store.read()).diagnoses[0]?.status).toBe('PENDING')
    expect((await store.read()).escalations[0]?.status).toBe('UNCERTAIN')
    await expect(recoverEngineeringTask(options.root, taskId, false)).rejects.toThrow(/stop|confirm|uncertain/i)
    expect(await readFile(join(options.root, 'unexpected.txt'), 'utf8')).toBe('Retain unsafe diagnosis output')
  }, 30_000)

  it.each(['settlement', 'audit'] as const)('retains stronger-child uncertainty when %s persistence also fails', async failure => {
    const options = await fixture()
    const repository = new TaskRepository(options.root)
    await repository.init()
    await repository.createTask({ schemaVersion: 1, id: 'uncertain', title: 'Keep uncertainty authoritative', profile: 'small-feature', dataClass: 'public', createdAt: '2026-10-08T00:00:00.000Z' })
    const store = new TaskSchedulingRepository(options.root, 'uncertain', 'development', { maxEscalations: 1 })
    await store.initializeNew()
    const primary = resolveRoleAttempts(options.deployment, 'scout-secondary')[0]!
    const stronger = resolveRoleEscalations(options.deployment, 'scout-secondary', primary.routeId)
    const reservation = await store.reserveEscalation({ failureKey: 'stronger:uncertain', recoveryEpoch: 0, role: 'scout-secondary', reason: 'EVIDENCE_INSUFFICIENT', sourceFingerprint: 'a'.repeat(64) })
    const routes: string[] = []
    await expect(runRoleAttempts({ role: 'scout-secondary', attempts: [primary], signal: new AbortController().signal,
      escalationCandidates: stronger.candidates, escalationFallbackCandidates: stronger.fallbackCandidates,
      onEscalate: async () => ({ escalationId: reservation.id }),
      executeAttempt: async route => {
        routes.push(route.routeId)
        if (route.routeId === primary.routeId) throw new CapabilityInsufficientError('EVIDENCE_INSUFFICIENT', 'Need stronger analysis', { observations: [], unresolvedQuestions: [] })
        await store.beginDispatch(reservation.id, 'stronger-child')
        throw new RoleQuiescenceError('Stronger child termination remains uncertain')
      },
      validateOutput: value => value,
      onEscalationSettled: async () => {
        if (failure === 'settlement') throw new Error('Fixture settlement write failure')
        await store.failEscalation(reservation.id, true)
      },
      persistAttempts: async () => { if (failure === 'audit') throw new Error('Fixture attempt audit write failure') },
    })).rejects.toBeInstanceOf(RoleQuiescenceError)
    expect(routes).toEqual([primary.routeId, 'architecture'])
    expect((await store.read()).escalations[0]?.status).toBe(failure === 'settlement' ? 'DISPATCHING' : 'UNCERTAIN')
    await expect(repository.assertDispatchAdmission('uncertain')).rejects.toThrow(/escalation|stop|uncertain/i)
    await expect(store.recover({ confirmedStopped: false })).rejects.toThrow(/stop|confirm|uncertain/i)
  })

  it('never escalates a read-only role after it marks a mutation and requests capability', async () => {
    const options = await fixture()
    const routes: string[] = []
    const result = await runEngineeringTask({ ...options, request: 'Inspect the bounded source', executeRole: async input => {
      if (input.role === 'scout-secondary') {
        routes.push(input.route.routeId)
        input.markMutationStarted?.()
        return insufficient
      }
      return success(input)
    } })
    expect(result.status).toBe('BLOCKED')
    expect(routes).toEqual(['worker-secondary'])
    const ledger = await new TaskSchedulingRepository(options.root, result.taskId, 'development', { maxEscalations: 1 }).read()
    expect(ledger.escalations).toEqual([])
  }, 30_000)

  it('persists repeated verification failure diagnosis before committing the failed transition', async () => {
    const options = await fixture()
    await writeFile(join(options.root, '.agent/adapters/test.yaml'), dump({ adapters: Object.fromEntries(['unit', 'typecheck', 'build'].map(name => [name, { executable: process.execPath, args: ['-e', 'process.exit(1)'] }])) }))
    const finish = TaskRepository.prototype.finishVerification
    let observed = false
    let taskId = ''
    const observer = vi.spyOn(TaskRepository.prototype, 'finishVerification').mockImplementation(async function (this: TaskRepository, id, revision, input) {
      const state = await this.readState(id)
      if (state.fixAttempts + 1 >= 2) {
        const ledger = await new TaskSchedulingRepository(options.root, id, 'development', { maxEscalations: 1 }).read()
        expect(ledger.diagnoses).toEqual([expect.objectContaining({ status: 'PENDING', failureKey: expect.stringMatching(/^verification:/) })])
        observed = true
        throw new Error('Fixture interruption before failed verification transition')
      }
      return finish.call(this, id, revision, input)
    })
    try {
      await runEngineeringTask({ ...options, request: 'Implement the bounded source', executeRole: async input => { taskId = input.taskId; return success(input) } }).catch(() => undefined)
      expect(observed).toBe(true)
      expect(await new TaskRepository(options.root).readState(taskId)).toMatchObject({ state: 'VERIFYING', fixAttempts: 1 })
      await expect(new TaskRepository(options.root).assertDispatchAdmission(taskId)).rejects.toThrow(/diagnos|pending|obligation/i)
    } finally { observer.mockRestore() }
  }, 30_000)

  it('resumes a Development reservation interrupted before stronger dispatch without repeating the failed role', async () => {
    const options = await fixture()
    const routes: string[] = []
    let taskId = ''
    const executeRole = async (input: RoleInvocation) => {
      taskId = input.taskId
      if (input.role === 'scout-secondary') {
        routes.push(input.route.routeId)
        if (input.route.routeId === 'worker-secondary') return insufficient
      }
      return success(input)
    }
    const reserve = TaskSchedulingRepository.prototype.reserveEscalation
    const observer = vi.spyOn(TaskSchedulingRepository.prototype, 'reserveEscalation').mockImplementationOnce(async function (this: TaskSchedulingRepository, input) {
      await reserve.call(this, input)
      throw new Error('Fixture crash after reservation, before dispatch CAS')
    })
    try {
      await runEngineeringTask({ ...options, request: 'Inspect the bounded source', executeRole }).catch(() => undefined)
      expect(observer).toHaveBeenCalledOnce()
    } finally { observer.mockRestore() }
    expect(routes).toEqual(['worker-secondary'])
    const store = new TaskSchedulingRepository(options.root, taskId, 'development', { maxEscalations: 1 })
    expect((await store.read()).escalations).toEqual([expect.objectContaining({ status: 'RESERVED' })])
    const resumed = await runEngineeringTask({ ...options, taskId, request: '', executeRole })
    expect(resumed.status).toBe('ACCEPTED')
    expect(routes).toEqual(['worker-secondary', 'architecture'])
    expect((await store.read()).escalations).toEqual([expect.objectContaining({ status: 'COMPLETE', output: expect.any(Object) })])
  }, 30_000)

  it('resumes a Review-only reservation interrupted before stronger dispatch without repeating its primary reviewer', async () => {
    const options = await fixture()
    await writeFile(join(options.root, 'reviewed.txt'), 'Pinned source\n')
    await execa('git', ['add', 'reviewed.txt'], { cwd: options.root })
    await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'review target'], { cwd: options.root })
    const modelsPath = join(options.root, '.agent/config/models.yaml')
    const models = load(await readFile(modelsPath, 'utf8')) as { routes: Record<string, Record<string, unknown>> }
    models.routes['architecture-fallback']!.capabilityLevel = 2
    await writeFile(modelsPath, dump(models))
    const rolesPath = join(options.root, '.agent/config/roles.yaml')
    const roles = load(await readFile(rolesPath, 'utf8')) as { roles: Record<string, Record<string, unknown>> }
    roles.roles.reviewer!.escalationRoutes = ['architecture-fallback']
    await writeFile(rolesPath, dump(roles))
    const deployment = await loadHarnessConfig(options.root, { env: {} })
    const routes: string[] = []
    let taskId = ''
    const executeRole = async (input: RoleInvocation) => {
      taskId = input.taskId
      routes.push(input.route.routeId)
      if (input.route.routeId === 'architecture') return insufficient
      const evidence = input.reviewEvidence!
      for (const file of (await evidence.changedFiles({})).files) { await evidence.show({ path: file.path }); await evidence.diff({ path: file.path }) }
      return { summary: 'Reviewed pinned source', findings: [], inspectedEvidenceIds: evidence.observedEvidence().map(item => item.id), unresolvedQuestions: [] }
    }
    const reserve = TaskSchedulingRepository.prototype.reserveEscalation
    const observer = vi.spyOn(TaskSchedulingRepository.prototype, 'reserveEscalation').mockImplementationOnce(async function (this: TaskSchedulingRepository, input) {
      await reserve.call(this, input)
      throw new Error('Fixture interruption after charged review reservation')
    })
    const terminal = vi.spyOn(TaskRepository.prototype, 'completeReviewOnly').mockRejectedValue(new Error('Fixture process stops before terminal failure persistence'))
    try {
      await runEngineeringReview({ root: options.root, deployment, target: { kind: 'commit', target: 'HEAD' }, executeRole }).catch(() => undefined)
      expect(observer).toHaveBeenCalledOnce()
    } finally { observer.mockRestore(); terminal.mockRestore() }
    const store = new TaskSchedulingRepository(options.root, taskId, 'review-only', { maxEscalations: 1 })
    expect((await store.read()).escalations).toEqual([expect.objectContaining({ status: 'RESERVED' })])
    const resumed = await runEngineeringReview({ root: options.root, deployment, taskId, target: { kind: 'commit', target: 'HEAD' }, executeRole })
    expect(resumed.status).toBe('REVIEW_COMPLETE')
    expect(routes).toEqual(['architecture', 'architecture-fallback'])
    expect((await store.read()).escalations).toEqual([expect.objectContaining({ status: 'COMPLETE', output: expect.any(Object) })])
  }, 30_000)

  it('uses only qualified stronger fallback routes under the same finite escalation reservation', async () => {
    const options = await fixture()
    const routes: string[] = []
    const result = await runEngineeringTask({ ...options, request: 'Inspect the lifecycle with a bounded stronger fallback', executeRole: async input => {
      if (input.role === 'scout-secondary') {
        routes.push(input.route.routeId)
        if (input.route.routeId === 'worker-secondary') return insufficient
        if (input.route.routeId === 'architecture') throw new RoleInvocationError('Stronger provider unavailable', 'PROVIDER_REQUEST_FAILURE', true)
        expect(input.route.routeId).toBe('architecture-fallback')
        expect(input.route.writable).toBe(false)
      }
      return success(input)
    } })
    expect(result.status).toBe('ACCEPTED')
    expect(routes).toEqual(['worker-secondary', 'architecture', 'architecture-fallback'])
    const audit = (await readFile(join(options.root, '.agent/tasks', result.taskId, 'ROUTE_ATTEMPTS.scout-secondary.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { mode: string; escalationId?: string })
    expect(audit.map(attempt => attempt.mode)).toEqual(['PRIMARY', 'ESCALATE', 'FALLBACK'])
    expect(audit[1]?.escalationId).toBeTruthy()
    expect(audit[2]?.escalationId).toBe(audit[1]?.escalationId)
    const ledger = JSON.parse(await readFile(join(options.root, '.agent/tasks', result.taskId, 'SCHEDULING.json'), 'utf8')) as { escalations: unknown[] }
    expect(ledger.escalations).toHaveLength(1)
  }, 30_000)

  it.each(['scout-secondary', 'implementer'] as const)('never escalates after %s termination becomes uncertain', async role => {
    const options = await fixture()
    const routes: string[] = []
    const result = await runEngineeringTask({ ...options, request: 'Inspect and implement the bounded lifecycle change', executeRole: async input => {
      if (input.role === role) {
        routes.push(input.route.routeId)
        throw new RoleQuiescenceError('Role result settled but its background writes have not stopped')
      }
      return success(input)
    } }).then(value => ({ value }), error => ({ error }))
    expect(routes).toEqual([role === 'implementer' ? 'worker' : 'worker-secondary'])
    if ('value' in result) expect(result.value).toMatchObject({ status: 'BLOCKED', requiresStopConfirmation: true })
    else expect(result.error).toBeInstanceOf(RoleQuiescenceError)
    const root = join(options.root, '.agent/tasks')
    const entries = await import('node:fs/promises').then(fs => fs.readdir(root))
    const taskId = entries[0]
    if (taskId === undefined) throw new Error('Missing quarantined task')
    await expect(recoverEngineeringTask(options.root, taskId, false)).rejects.toThrow(/confirmation|writer|stop/i)
  }, 30_000)

  it('uses provider fallback first and escalates only an explicit capability response', async () => {
    const options = await fixture()
    const routes: string[] = []
    const result = await runEngineeringTask({ ...options, request: 'Inspect the bounded lifecycle transition', executeRole: async input => {
      if (input.role === 'scout-secondary') {
        routes.push(input.route.routeId)
        if (input.route.routeId === 'worker-secondary') throw new RoleInvocationError('Provider unavailable', 'PROVIDER_REQUEST_FAILURE', true)
        if (input.route.routeId === 'worker-secondary-fallback') return insufficient
        expect(input.route.writable).toBe(false)
      }
      return success(input)
    } })
    expect(result.status).toBe('ACCEPTED')
    expect(routes).toEqual(['worker-secondary', 'worker-secondary-fallback', 'architecture'])
    const audit = (await readFile(join(options.root, '.agent/tasks', result.taskId, 'ROUTE_ATTEMPTS.scout-secondary.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { mode: string })
    expect(audit.map(attempt => attempt.mode)).toEqual(['PRIMARY', 'FALLBACK', 'ESCALATE'])
  }, 30_000)

  it('accepts the success envelope and rejects mixed escalation/success branches', async () => {
    const options = await fixture()
    const accepted = await runEngineeringTask({ ...options, request: 'Verify the fixture', executeRole: async input => ({ response: { status: 'success', output: await success(input) } }) })
    expect(accepted.status).toBe('ACCEPTED')
    const second = await fixture()
    const routes: string[] = []
    const mixed = await runEngineeringTask({ ...second, request: 'Inspect the lifecycle', executeRole: async input => {
      if (input.role === 'scout-secondary') {
        routes.push(input.route.routeId)
        return { ...await success(input), response: { ...insufficient.response, output: await success(input) } }
      }
      return success(input)
    } })
    expect(mixed.status).toBe('BLOCKED')
    expect(routes).not.toContain('architecture')
  }, 30_000)

  it('does not renew the finite capability allowance through recovery', async () => {
    const options = await fixture()
    const routes: string[] = []
    const executeRole = async (input: RoleInvocation) => {
      if (input.role === 'scout-secondary') {
        routes.push(input.route.routeId)
        if (input.route.routeId !== 'architecture') return insufficient
        throw new RoleInvocationError('Stronger analysis remains blocked', 'NON_FALLBACKABLE', false)
      }
      return success(input)
    }
    const first = await runEngineeringTask({ ...options, request: 'Inspect the lifecycle', executeRole })
    expect(routes).toEqual(['worker-secondary', 'architecture'])
    await recoverEngineeringTask(options.root, first.taskId, false)
    const before = routes.length
    const resumed = await runEngineeringTask({ ...options, taskId: first.taskId, request: '', executeRole })
    expect(resumed.status).toBe('BUDGET_EXHAUSTED')
    expect(routes.slice(before)).not.toContain('architecture')
    const scheduling = JSON.parse(await readFile(join(options.root, '.agent/tasks', first.taskId, 'SCHEDULING.json'), 'utf8')) as { escalations: unknown[] }
    expect(scheduling.escalations).toHaveLength(1)
  }, 30_000)

  it('persists the diagnosis obligation before releasing a stopped capability-limited writer', async () => {
    const options = await fixture()
    const release = TaskRepository.prototype.releaseImplementation
    let observed = false
    const observer = vi.spyOn(TaskRepository.prototype, 'releaseImplementation').mockImplementation(async function (this: TaskRepository, taskId, revision, token) {
      const state = await this.readState(taskId)
      expect(state.writer).not.toBeNull()
      const ledger = JSON.parse(await readFile(join(options.root, '.agent/tasks', taskId, 'SCHEDULING.json'), 'utf8')) as { diagnoses: Array<{ status: string }> }
      expect(ledger.diagnoses).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'PENDING' })]))
      observed = true
      return release.call(this, taskId, revision, token)
    })
    try {
      await runEngineeringTask({ ...options, request: 'Implement within the frozen scope', executeRole: async input => input.role === 'implementer' ? insufficient : success(input) })
      expect(observed).toBe(true)
    } finally { observer.mockRestore() }
  }, 30_000)

  it('retains the writer lease when persisting its diagnosis obligation fails', async () => {
    const options = await fixture()
    const persistenceFailure = new Error('Fixture diagnosis persistence failure')
    const observer = vi.spyOn(TaskSchedulingRepository.prototype, 'recordDiagnosisObligation').mockRejectedValue(persistenceFailure)
    let writerFinished = false
    const subsequentRoles: string[] = []
    try {
      await runEngineeringTask({ ...options, request: 'Implement within the frozen scope', executeRole: async input => {
        if (writerFinished) subsequentRoles.push(input.role)
        if (input.role === 'implementer') {
          writerFinished = true
          return insufficient
        }
        return success(input)
      } }).catch(() => undefined)
      expect(observer).toHaveBeenCalledOnce()
      expect(subsequentRoles).toEqual([])
      const taskIds = await readdir(join(options.root, '.agent/tasks'))
      expect(taskIds).toHaveLength(1)
      const state = await new TaskRepository(options.root).readState(taskIds[0]!)
      expect(state.writer).not.toBeNull()
      await expect(recoverEngineeringTask(options.root, taskIds[0]!, false)).rejects.toThrow(/confirmation|writer|stop/i)
    } finally { observer.mockRestore() }
  }, 30_000)
})
