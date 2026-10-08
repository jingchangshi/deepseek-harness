import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { dump } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recoverEngineeringTask, runEngineeringTask } from '../src/automatic.ts'
import type { RoleInvocation } from '../src/automatic.ts'
import { loadHarnessConfig } from '../src/config.ts'
import { RoleInvocationError, RoleQuiescenceError } from '../src/role-execution.ts'
import { runEngineeringReview } from '../src/review-only.ts'
import { TaskRepository } from '../src/repository.ts'
import { TaskSchedulingRepository } from '../src/scheduling.ts'

const roots: string[] = []
type Policy = { class: 'auto' | 'simple' | 'standard' | 'complex'; scopePaths: string[]; acceptanceCriteria: string[]; risks: string[]; needsInvestigation: boolean; needsChallenge: boolean }

async function fixture(policy: Policy, dirty = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-adaptive-scheduling-'))
  roots.push(root)
  await cp(resolve('.agent'), join(root, '.agent'), { recursive: true, filter: source => !source.includes(join('.agent', 'tasks')) && !source.includes(join('.agent', 'reviews')) })
  await writeFile(join(root, 'answer.txt'), '0')
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/module.mlir'), 'module {}\n')
  await writeFile(join(root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 40, maxRoleCalls: 30, commandTimeoutMs: 30_000, scheduling: policy }))
  await writeFile(join(root, '.agent/adapters/test.yaml'), dump({ adapters: Object.fromEntries(['unit', 'typecheck', 'build'].map(name => [name, { executable: process.execPath, args: ['-e', "if(require('fs').readFileSync('answer.txt','utf8')!=='42')process.exit(1)"] }])) }))
  await execa('git', ['init', '-q'], { cwd: root })
  await execa('git', ['add', '.'], { cwd: root })
  await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root })
  if (dirty) await writeFile(join(root, 'answer.txt'), 'Uncommitted baseline')
  return { root, deployment: await loadHarnessConfig(root, { env: {} }) }
}

const simple: Policy = { class: 'simple', scopePaths: ['answer.txt'], acceptanceCriteria: ['answer.txt contains exactly 42'], risks: [], needsInvestigation: false, needsChallenge: false }

async function success(input: RoleInvocation) {
  if (input.role.startsWith('scout-')) return { findings: ['answer.txt is a fixture output'], hypotheses: [{ statement: 'The acceptance command checks the exact output', evidence: ['Fixture adapter'] }], unresolvedAssumptions: [] }
  if (input.role === 'architect') return { problemStatement: 'Write the requested answer', hypotheses: ['The answer is 42'], selectedApproach: 'Write answer.txt', rejectedAlternatives: ['Change unrelated source'], invariants: ['Preserve unrelated files'], expectedComponents: ['answer.txt'], implementationScope: ['answer.txt'], falsificationTests: ['Reject another value'], acceptanceGates: ['unit'], unresolvedAssumptions: [] }
  if (input.role === 'implementer') { await writeFile(join(input.root, 'answer.txt'), '42'); return { summary: 'Wrote the requested answer' } }
  return { decision: 'ACCEPT', summary: 'Checked exact acceptance and source scope', findings: [] }
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('adaptive development scheduling', () => {
  it('persists original scheduling scope before freezing the plan and resumes its interrupted freeze', async () => {
    const options = await fixture(simple)
    let taskId = ''
    const observer = vi.spyOn(TaskRepository.prototype, 'freezePlan').mockImplementationOnce(async function (this: TaskRepository, id) {
      taskId = id
      const state = await this.readState(id)
      const frozen = JSON.parse(await readFile(join(options.root, '.agent/tasks', id, `PLAN-SCHEDULING-${state.workRevision + 1}.json`), 'utf8'))
      expect(frozen).toMatchObject({ taskId: id, workRevision: state.workRevision + 1, classification: { taskClass: 'simple', scopePaths: ['answer.txt'] } })
      throw new Error('Fixture interruption before plan state persistence')
    })
    try {
      await runEngineeringTask({ ...options, request: 'Write answer.txt containing exactly 42', executeRole: success }).catch(() => undefined)
      expect(observer).toHaveBeenCalledOnce()
    } finally { observer.mockRestore() }
    expect(await new TaskRepository(options.root).readState(taskId)).toMatchObject({ state: 'INVESTIGATED', workRevision: 0, writer: null })
    const resumed = await runEngineeringTask({ ...options, taskId, request: '', executeRole: success })
    expect(resumed.status).toBe('ACCEPTED')
  }, 30_000)

  it.each(['simple', 'standard'] as const)('uses only the required stages for explicit %s low-risk scope', async taskClass => {
    const options = await fixture({ ...simple, class: taskClass })
    const roles: string[] = []
    const result = await runEngineeringTask({ ...options, request: 'Write answer.txt containing exactly 42', executeRole: async input => { roles.push(input.role); return success(input) } })
    expect(result.status).toBe('ACCEPTED')
    expect(roles).toEqual(taskClass === 'simple' ? ['implementer', 'reviewer'] : ['architect', 'implementer', 'reviewer'])
    expect(await readFile(join(options.root, 'answer.txt'), 'utf8')).toBe('42')
    const evidence = await readFile(join(options.root, '.agent/tasks', result.taskId, 'EVIDENCE.jsonl'), 'utf8')
    expect(evidence.trim().split('\n')).toHaveLength(3)
    const scheduling = JSON.parse(await readFile(join(options.root, '.agent/tasks', result.taskId, 'SCHEDULING.json'), 'utf8')) as { classifications: Array<{ taskClass: string }> }
    expect(scheduling.classifications.at(-1)?.taskClass).toBe(taskClass)
  }, 30_000)

  it.each(['concurrency', 'security', 'compiler-ir', 'directory', 'glob', 'dirty'] as const)('promotes unsafe %s facts despite requested simple mode', async risk => {
    const scopePaths = risk === 'directory' ? ['src'] : risk === 'glob' ? ['src/*'] : risk === 'compiler-ir' ? ['src/module.mlir'] : simple.scopePaths
    const options = await fixture({ ...simple, scopePaths, risks: ['concurrency', 'security', 'compiler-ir'].includes(risk) ? [risk] : [] }, risk === 'dirty')
    const roles: string[] = []
    const result = await runEngineeringTask({ ...options, request: 'Update the requested scoped source', executeRole: async input => { roles.push(input.role); return success(input) } })
    expect(result.status).toBe('ACCEPTED')
    expect(roles).toContain('architect')
    if (!['directory', 'glob'].includes(risk)) expect(roles).toContain('challenger')
  }, 30_000)

  it('stops acceptance and requires explicit scope replan after an out-of-scope simple write', async () => {
    const options = await fixture(simple)
    const result = await runEngineeringTask({ ...options, request: 'Write answer.txt containing exactly 42', executeRole: async input => {
      if (input.role === 'implementer') await writeFile(join(options.root, 'unexpected.txt'), 'Unrequested source modification')
      return success(input)
    } })
    expect(result.status).not.toBe('ACCEPTED')
    expect(result.nextAction).toBe('REPLAN_WITH_SCOPE')
    expect(await readFile(join(options.root, 'unexpected.txt'), 'utf8')).toBe('Unrequested source modification')
    await recoverEngineeringTask(options.root, result.taskId, false)
    await execa('git', ['add', 'answer.txt', 'unexpected.txt'], { cwd: options.root })
    await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'retain stopped implementation'], { cwd: options.root })
    const roles: string[] = []
    await runEngineeringTask({ ...options, taskId: result.taskId, request: 'Write only answer.txt containing exactly 42', executeRole: async input => { roles.push(input.role); return success(input) } })
    expect(roles).toContain('architect')
    expect(roles).toContain('challenger')
    const record = await new TaskSchedulingRepository(options.root, result.taskId, 'development', { maxEscalations: 2 }).read()
    expect(record.taskClassFloor).toBe('complex')
    expect(record.classifications.at(-1)).toMatchObject({ taskClass: 'complex' })
    expect(record.classifications).toEqual(expect.arrayContaining([expect.objectContaining({ reasons: expect.arrayContaining(['OUT_OF_SCOPE_WRITE']) })]))
  }, 30_000)

  it.each(['reviewed-interruption', 'committed-unexpected'] as const)('keeps original simple scope authoritative after %s', async scenario => {
    const options = await fixture(simple)
    const finishReview = TaskRepository.prototype.review
    let interrupted = false
    const observer = vi.spyOn(TaskRepository.prototype, 'review').mockImplementation(async function (this: TaskRepository, taskId, revision, input) {
      const state = await finishReview.call(this, taskId, revision, input)
      if (state.state === 'REVIEWED') await writeFile(join(options.root, 'unexpected.txt'), 'Preserve unexpected source')
      if (scenario === 'reviewed-interruption' && state.state === 'REVIEWED') {
        interrupted = true
        throw new Error('Fixture interruption after durable REVIEWED transition')
      }
      if (scenario === 'committed-unexpected' && state.state === 'REVIEWED') {
        await execa('git', ['add', 'answer.txt', 'unexpected.txt'], { cwd: options.root })
        await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'unexpected implementation commit'], { cwd: options.root })
      }
      return state
    })
    let taskId = ''
    let runError: unknown
    try {
      const result = await runEngineeringTask({ ...options, request: 'Write answer.txt containing exactly 42', executeRole: async input => {
        taskId = input.taskId
        const output = await success(input)
        return output
      } }).catch(error => { runError = error; return undefined })
      taskId = result?.taskId ?? taskId
      if (scenario === 'committed-unexpected') {
        expect(result?.status).not.toBe('ACCEPTED')
        expect(result?.nextAction).toBe('REPLAN_WITH_SCOPE')
      }
    } finally { observer.mockRestore() }
    if (scenario === 'reviewed-interruption') {
      expect(interrupted, String(runError)).toBe(true)
      const resumed = await runEngineeringTask({ ...options, taskId, request: '', executeRole: success })
      expect(resumed.status).not.toBe('ACCEPTED')
      expect(resumed.nextAction).toBe('REPLAN_WITH_SCOPE')
    }
    expect(await readFile(join(options.root, 'unexpected.txt'), 'utf8')).toBe('Preserve unexpected source')
  }, 30_000)

  it('does not downgrade cumulative risk after recovery and a narrower changed request or policy', async () => {
    const options = await fixture({ ...simple, class: 'complex', risks: ['concurrency'] })
    const first = await runEngineeringTask({ ...options, request: 'Modify concurrent lifecycle handling', executeRole: async input => {
      if (input.role.startsWith('scout-')) return success(input)
      throw new RoleInvocationError('Stop before architecture completion', 'NON_FALLBACKABLE', false)
    } })
    await recoverEngineeringTask(options.root, first.taskId, false)
    await writeFile(join(options.root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 40, maxRoleCalls: 30, commandTimeoutMs: 30_000, scheduling: simple }))
    const roles: string[] = []
    const resumed = await runEngineeringTask({ ...options, taskId: first.taskId, request: 'Write only answer.txt containing exactly 42', executeRole: async input => { roles.push(input.role); return success(input) } })
    expect(resumed.status).toBe('ACCEPTED')
    expect(roles).toContain('architect')
    expect(roles).toContain('challenger')
    const record = JSON.parse(await readFile(join(options.root, '.agent/tasks', first.taskId, 'SCHEDULING.json'), 'utf8')) as { classifications: Array<{ taskClass: string; risks: string[] }> }
    expect(record.classifications.at(-1)).toMatchObject({ taskClass: 'complex', risks: expect.arrayContaining(['concurrency']) })
  }, 30_000)

  it('keeps Review-only free of writer roles under simple development policy', async () => {
    const options = await fixture(simple)
    await writeFile(join(options.root, 'answer.txt'), '42')
    await execa('git', ['add', 'answer.txt'], { cwd: options.root })
    await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'review target'], { cwd: options.root })
    const before = await readFile(join(options.root, 'answer.txt'), 'utf8')
    const roles: string[] = []
    const result = await runEngineeringReview({ ...options, target: { kind: 'commit', target: 'HEAD' }, executeRole: async input => {
      roles.push(input.role)
      const evidence = input.reviewEvidence
      if (evidence === undefined) throw new Error('Missing trusted review evidence')
      const files = await evidence.changedFiles({})
      for (const file of files.files) { await evidence.show({ path: file.path }); await evidence.diff({ path: file.path }) }
      return { summary: 'Reviewed the pinned fixture', findings: [], inspectedEvidenceIds: evidence.observedEvidence().map(receipt => receipt.id), unresolvedQuestions: [] }
    } })
    expect(result.status).toBe('REVIEW_COMPLETE')
    expect(roles).not.toContain('implementer')
    expect(await readFile(join(options.root, 'answer.txt'), 'utf8')).toBe(before)
  }, 30_000)

  it('recovers interrupted Review-only escalation in a new durable scheduling epoch', async () => {
    const options = await fixture(simple)
    await writeFile(join(options.root, 'answer.txt'), '42')
    await execa('git', ['add', 'answer.txt'], { cwd: options.root })
    await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'review target'], { cwd: options.root })
    const result = await runEngineeringReview({ ...options, target: { kind: 'commit', target: 'HEAD' }, executeRole: async () => { throw new RoleQuiescenceError('Fixture review child stop remains uncertain') } })
    expect(result.status).toBe('BLOCKED')
    const store = new TaskSchedulingRepository(options.root, result.taskId, 'review-only', { maxEscalations: 2 })
    const reservation = await store.reserveEscalation({ failureKey: 'review:interrupted-stronger-child', recoveryEpoch: 0, role: 'reviewer', reason: 'EVIDENCE_INSUFFICIENT', sourceFingerprint: 'a'.repeat(64) })
    await store.beginDispatch(reservation.id, 'review-stronger-attempt')
    await expect(recoverEngineeringTask(options.root, result.taskId, false)).rejects.toThrow(/stop|confirm/i)
    await recoverEngineeringTask(options.root, result.taskId, true)
    expect(await store.read()).toMatchObject({ recoveryEpoch: 1, escalations: [expect.objectContaining({ id: reservation.id, status: 'FAILED' })] })
    const retry = await store.reserveEscalation({ failureKey: reservation.failureKey, recoveryEpoch: 1, role: 'reviewer', reason: 'EVIDENCE_INSUFFICIENT', sourceFingerprint: 'a'.repeat(64) })
    expect(retry.id).not.toBe(reservation.id)
    expect((await store.read()).escalations).toHaveLength(2)
  }, 30_000)
})
