import { createHash } from 'node:crypto'
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
import { BudgetExhaustedError } from '../src/lifecycle.ts'
import { TaskRepository } from '../src/repository.ts'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-investigation-checkpoint-'))
  roots.push(root)
  await cp(resolve('.agent'), join(root, '.agent'), { recursive: true, filter: source => !source.includes(join('.agent', 'tasks')) && !source.includes(join('.agent', 'reviews')) })
  const units = [
    { id: 'scout-a', role: 'scout-primary', question: 'What value does A export?', allowedPaths: ['src/a'] },
    { id: 'scout-b', role: 'scout-secondary', question: 'What value does B export?', allowedPaths: ['src/b'] },
  ]
  await writeFile(join(root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 40, maxRoleCalls: 30, commandTimeoutMs: 30_000, investigationUnits: units }))
  await writeFile(join(root, '.agent/adapters/test.yaml'), dump({ adapters: Object.fromEntries(['unit', 'typecheck', 'build'].map(name => [name, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }])) }))
  for (const name of ['a', 'b']) {
    await mkdir(join(root, 'src', name), { recursive: true })
    await writeFile(join(root, 'src', name, 'value.ts'), `export const value = '${name}'\n`)
  }
  await writeFile(join(root, 'unrelated.txt'), 'Original unrelated content\n')
  await execa('git', ['init', '-q'], { cwd: root })
  await execa('git', ['add', 'src', 'unrelated.txt'], { cwd: root })
  await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root })
  return { root, deployment: await loadHarnessConfig(root, { env: {} }) }
}

async function inspect(input: RoleInvocation) {
  const name = input.role === 'scout-primary' ? 'a' : 'b'
  const path = `src/${name}/value.ts`
  const content = await readFile(join(input.root, path), 'utf8')
  if (input.executionControl === undefined) throw new Error('Missing trusted inspection callback')
  expect(input.workUnit?.allowedPaths).toEqual([`src/${name}`])
  const executionId = `${input.executionControl.attemptId}:${path}`
  await input.executionControl.reserveToolCall(executionId)
  await input.executionControl.recordInspection({ executionId, path, contentHash: createHash('sha256').update(content).digest('hex'), toolName: 'read' })
  return { findings: [`${path}: ${content.trim()}`], hypotheses: [{ statement: `${name} exports its declared value`, evidence: [path] }], unresolvedAssumptions: [] }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('incremental investigation recovery', () => {
  it('starts Scouts in declared order when secondary preparation finishes before primary preparation', async () => {
    const options = await fixture()
    const read = TaskRepository.prototype.readInvestigationCheckpoint
    const controller = new AbortController()
    let secondaryCheckpointRead = false
    let secondaryPrepared = false
    let releasePrimary!: () => void
    let releaseScouts!: () => void
    const primaryReady = new Promise<void>(resolve => { releasePrimary = resolve })
    const bothStarted = new Promise<void>(resolve => { releaseScouts = resolve })
    const starts: string[] = []
    const bounds = options.deployment.workflow.roleBounds['scout-secondary']
    const roleBounds = { ...options.deployment.workflow.roleBounds }
    Object.defineProperty(roleBounds, 'scout-secondary', { enumerable: true, get() {
      if (secondaryCheckpointRead) { secondaryPrepared = true; releasePrimary() }
      return bounds
    } })
    const deployment = { ...options.deployment, workflow: { ...options.deployment.workflow, roleBounds } }
    const preparation = vi.spyOn(TaskRepository.prototype, 'readInvestigationCheckpoint').mockImplementation(async function (this: TaskRepository, taskId, workflow, unitId) {
      if (unitId === 'scout-a' && !secondaryPrepared) await primaryReady
      const checkpoint = await read.call(this, taskId, workflow, unitId)
      if (unitId === 'scout-b') secondaryCheckpointRead = true
      return checkpoint
    })
    const pending = runEngineeringTask({ ...options, deployment, signal: controller.signal, request: 'Inspect the scoped exports concurrently', executeRole: async input => {
      if (input.role.startsWith('scout-')) {
        starts.push(input.role)
        if (starts.length === 2) releaseScouts()
        await bothStarted
        return inspect(input)
      }
      throw new RoleInvocationError('Stop after ordered concurrent investigation', 'NON_FALLBACKABLE', false)
    } })
    try {
      const result = await pending
      expect(result.status).toBe('BLOCKED')
      expect(secondaryPrepared).toBe(true)
      expect(starts).toEqual(['scout-primary', 'scout-secondary'])
    } finally {
      controller.abort(); releasePrimary(); releaseScouts()
      await Promise.allSettled([pending])
      preparation.mockRestore()
    }
  })

  it.each(['ordinary', 'budget'] as const)('prioritizes uncertain parallel Scout shutdown over an %s failure', async failure => {
    const options = await fixture()
    const roles: string[] = []
    const result = await runEngineeringTask({ ...options, request: 'Inspect the scoped exports', executeRole: async input => {
      roles.push(input.role)
      if (input.role === 'scout-primary') throw failure === 'budget' ? new BudgetExhaustedError('toolCalls') : new RoleInvocationError('Provider failed safely', 'NON_FALLBACKABLE', false)
      throw new RoleQuiescenceError('Secondary Scout background command termination is uncertain')
    } })
    expect(roles).toEqual(['scout-primary', 'scout-secondary'])
    expect(result).toMatchObject({ status: 'BLOCKED', requiresStopConfirmation: true, state: { writer: null, blocker: expect.stringMatching(/termination is uncertain/i) } })
    await expect(recoverEngineeringTask(options.root, result.taskId, false)).rejects.toThrow(/confirmation/)
    const dispatch = vi.fn(async () => { throw new Error('Uncertain background work allowed another dispatch') })
    await expect(runEngineeringTask({ ...options, taskId: result.taskId, request: '', executeRole: dispatch })).rejects.toThrow(/confirmation/)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('refuses acceptance when the final reviewer crosses the cumulative elapsed ceiling', async () => {
    const options = await fixture()
    let now = Date.now()
    const repository = new TaskRepository(options.root, undefined, { now: () => new Date(now).toISOString() })
    const initialize = TaskRepository.prototype.initializeLifecycle
    const open = TaskRepository.prototype.lifecycle
    const initialization = vi.spyOn(TaskRepository.prototype, 'initializeLifecycle').mockImplementation((id, workflow, limits) => initialize.call(repository, id, workflow, limits))
    const clock = vi.spyOn(TaskRepository.prototype, 'lifecycle').mockImplementation((id, workflow, limits) => open.call(repository, id, workflow, limits))
    const deployment = { ...options.deployment, workflow: { ...options.deployment.workflow, lifecycleBudget: { ...options.deployment.workflow.lifecycleBudget, maxElapsedMs: 1000 } } }
    const roles: string[] = []
    try {
      const result = await runEngineeringTask({ ...options, deployment, request: 'Inspect and verify the source', executeRole: async input => {
        roles.push(input.role)
        if (input.role.startsWith('scout-')) return inspect(input)
        if (input.role === 'architect') return { problemStatement: 'Inspect the source', hypotheses: ['The source is valid'], selectedApproach: 'Keep the valid source', rejectedAlternatives: ['Change unrelated source'], invariants: ['Preserve source bytes'], expectedComponents: ['src/a/value.ts'], implementationScope: ['src/a/value.ts'], falsificationTests: ['Reject invalid source'], acceptanceGates: ['unit'], unresolvedAssumptions: [] }
        if (input.role === 'implementer') return { summary: 'Kept the inspected source unchanged' }
        if (input.role === 'reviewer') now += 1001
        return { decision: 'ACCEPT', summary: 'Inspected source and verification evidence', findings: [] }
      } })
      expect(roles).toContain('reviewer')
      expect(result).toMatchObject({ status: 'BUDGET_EXHAUSTED', state: { state: 'BUDGET_EXHAUSTED', writer: null } })
      expect(result.summary).toMatch(/elapsed/i)
    } finally { clock.mockRestore(); initialization.mockRestore() }
  })

  it('serializes pending soft checkpoint saves before completing the investigation', async () => {
    const options = await fixture()
    const save = TaskRepository.prototype.saveInvestigationCheckpoint
    let hold = false
    let saves = 0
    let entered!: () => void
    let release!: () => void
    const firstEntered = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const pendingSaves: Promise<void>[] = []
    const observer = vi.spyOn(TaskRepository.prototype, 'saveInvestigationCheckpoint').mockImplementation(async function (this: TaskRepository, checkpoint) {
      if (hold && checkpoint.unitId === 'scout-a' && checkpoint.status === 'PARTIAL') {
        saves++
        if (saves === 1) { entered(); await released }
      }
      await save.call(this, checkpoint)
    })
    try {
      const result = await runEngineeringTask({ ...options, request: 'Inspect the scoped exports', executeRole: async input => {
        if (input.role === 'scout-primary') {
          const output = await inspect(input)
          if (input.executionControl === undefined) throw new Error('Missing checkpoint control')
          hold = true
          pendingSaves.push(input.executionControl.checkpoint())
          await firstEntered
          pendingSaves.push(input.executionControl.checkpoint())
          try { expect(saves).toBe(1) }
          finally { release(); await Promise.allSettled(pendingSaves) }
          return output
        }
        if (input.role === 'scout-secondary') return inspect(input)
        throw new RoleInvocationError('Stop after ordered checkpoint completion', 'NON_FALLBACKABLE', false)
      } })
      const checkpoint = await new TaskRepository(options.root).readInvestigationCheckpoint(result.taskId, 'development', 'scout-a')
      expect(checkpoint).toMatchObject({ status: 'COMPLETE', output: { findings: ["src/a/value.ts: export const value = 'a'"] } })
    } finally { release(); await Promise.allSettled(pendingSaves); observer.mockRestore() }
  })

  it('preserves the original inspection owners from partial recovery through later completed reuse', async () => {
    const options = await fixture()
    let acquired: Awaited<ReturnType<typeof inspect>> | undefined
    const first = await runEngineeringTask({ ...options, request: 'Inspect the scoped exports', executeRole: async input => {
      if (input.role === 'scout-primary') {
        acquired = await inspect(input)
        throw new RoleInvocationError('Stop after actual partial evidence', 'NON_FALLBACKABLE', false)
      }
      if (input.role === 'scout-secondary') return inspect(input)
      throw new Error('Partial investigation reached architecture')
    } })
    const repository = new TaskRepository(options.root)
    const partial = await repository.readInvestigationCheckpoint(first.taskId, 'development', 'scout-a')
    if (partial === undefined || acquired === undefined) throw new Error('Missing acquired partial evidence')
    expect(partial.status).toBe('PARTIAL')
    expect(partial.evidence).toHaveLength(1)
    await recoverEngineeringTask(options.root, first.taskId, false)
    const recoveredRoles: string[] = []
    const resumed = await runEngineeringTask({ ...options, taskId: first.taskId, request: '', executeRole: async input => {
      recoveredRoles.push(input.role)
      if (input.role === 'scout-primary') {
        expect(input.context.partialInvestigationEvidence).toEqual(partial.evidence)
        return acquired
      }
      throw new RoleInvocationError('Stop after completing the recovered investigation', 'NON_FALLBACKABLE', false)
    } })
    expect(resumed.status).toBe('BLOCKED')
    expect(recoveredRoles).toEqual(['scout-primary', 'architect'])
    const complete = await repository.readInvestigationCheckpoint(first.taskId, 'development', 'scout-a')
    expect(complete).toMatchObject({ status: 'COMPLETE', evidence: partial.evidence })
    expect(complete?.attemptIds).toEqual(expect.arrayContaining(partial.attemptIds))
    await recoverEngineeringTask(options.root, first.taskId, false)
    const finalRoles: string[] = []
    const final = await runEngineeringTask({ ...options, taskId: first.taskId, request: '', executeRole: async input => {
      finalRoles.push(input.role)
      throw new RoleInvocationError('Stop after verifying completed checkpoint reuse', 'NON_FALLBACKABLE', false)
    } })
    expect(final.status).toBe('BLOCKED')
    expect(finalRoles).toEqual(['architect'])
  })

  it('rejects an unowned partial inspection before sending any evidence handoff', async () => {
    const options = await fixture()
    const first = await runEngineeringTask({ ...options, request: 'Inspect the scoped exports', executeRole: async input => {
      if (input.role.startsWith('scout-')) await inspect(input)
      throw new RoleInvocationError('Stop with partial observations', 'NON_FALLBACKABLE', false)
    } })
    const repository = new TaskRepository(options.root)
    const partial = await repository.readInvestigationCheckpoint(first.taskId, 'development', 'scout-a')
    if (partial === undefined || partial.status !== 'PARTIAL') throw new Error('Missing partial checkpoint')
    await writeFile(join(options.root, '.agent/tasks', first.taskId, 'checkpoints/scout-a.json'), `${JSON.stringify({ ...partial, evidence: partial.evidence.map(receipt => ({ ...receipt, executionId: 'unowned-partial-inspection' })) })}\n`)
    await recoverEngineeringTask(options.root, first.taskId, false)
    const dispatched: string[] = []
    await expect(runEngineeringTask({ ...options, taskId: first.taskId, request: '', executeRole: async input => {
      dispatched.push(input.role)
      throw new Error('Invalid partial evidence was handed to a role')
    } })).rejects.toThrow(/checkpoint inspection.*durable task attempt/i)
    expect(dispatched).not.toContain('scout-primary')
  })

  it.each(['contentHash', 'executionId', 'scope'] as const)('refuses to reuse a completed checkpoint with corrupted %s', async field => {
    const options = await fixture()
    const first = await runEngineeringTask({ ...options, request: 'Inspect the scoped exports', executeRole: async input => {
      if (input.role === 'scout-primary') return inspect(input)
      throw new RoleInvocationError('Stop after A checkpoint', 'NON_FALLBACKABLE', false)
    } })
    const repository = new TaskRepository(options.root)
    const checkpoint = await repository.readInvestigationCheckpoint(first.taskId, 'development', 'scout-a')
    if (checkpoint === undefined || checkpoint.status !== 'COMPLETE') throw new Error('Missing completed checkpoint')
    const corrupted = { ...checkpoint, ...field === 'scope' ? { allowedPaths: ['src/b'] } : { evidence: checkpoint.evidence.map(receipt => ({ ...receipt, [field]: field === 'contentHash' ? '0'.repeat(64) : 'invented-execution' })) } }
    await writeFile(join(options.root, '.agent/tasks', first.taskId, 'checkpoints/scout-a.json'), `${JSON.stringify(corrupted)}\n`)
    await recoverEngineeringTask(options.root, first.taskId, false)
    const resumedRoles: string[] = []
    const resumed = await runEngineeringTask({ ...options, taskId: first.taskId, request: '', executeRole: async input => {
      resumedRoles.push(input.role)
      if (input.role.startsWith('scout-')) return inspect(input)
      throw new RoleInvocationError('Stop after fresh investigation', 'NON_FALLBACKABLE', false)
    } }).then(result => ({ result }), error => ({ error }))
    if ('error' in resumed) {
      if (!(resumed.error instanceof Error)) throw resumed.error
      expect(resumed.error.message).toMatch(/checkpoint|inspection|receipt|evidence|scope/i)
    } else expect(resumedRoles).toContain('scout-primary')
  })

  it('gives fallback the actual partial receipts without repeating the completed Scout', async () => {
    const options = await fixture()
    const calls: string[] = []
    const result = await runEngineeringTask({ ...options, request: 'Inspect the scoped exports', executeRole: async input => {
      calls.push(input.role)
      if (input.role === 'scout-primary') return inspect(input)
      if (input.role === 'scout-secondary') {
        if (input.attemptIndex === 1) {
          await inspect(input)
          throw new RoleInvocationError('Provider timed out after acquiring source evidence', 'ROLE_TIMEOUT_QUIESCENT', true)
        }
        expect(input.context.partialInvestigationEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'src/b/value.ts', toolName: 'read' })]))
        return inspect(input)
      }
      throw new RoleInvocationError('Stop after investigation acceptance', 'NON_FALLBACKABLE', false)
    } })
    expect(result.status).toBe('BLOCKED')
    expect(calls.filter(role => role === 'scout-primary')).toHaveLength(1)
    expect(calls.filter(role => role === 'scout-secondary')).toHaveLength(2)
  })

  it('sends bounded references instead of repeating complete historical artifacts', async () => {
    const options = await fixture()
    const deployment = { ...options.deployment, workflow: { ...options.deployment.workflow, maxRoleContextBytes: 2048 } }
    const marker = 'Full-source-background-'.repeat(4000)
    let checked = false
    const result = await runEngineeringTask({ ...options, deployment, request: marker, executeRole: async input => {
      if (input.role.startsWith('scout-')) {
        const serialized = JSON.stringify(input.context)
        expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(2048)
        expect(serialized).not.toContain(marker)
        const reference = input.context.contextReference as { path: string; sha256: string; bytes: number }
        const artifact = await readFile(reference.path, 'utf8')
        expect(createHash('sha256').update(artifact.trimEnd()).digest('hex')).toBe(reference.sha256)
        expect(artifact).toContain(marker)
        checked = true
        return inspect(input)
      }
      throw new RoleInvocationError('Stop after bounded context acceptance', 'NON_FALLBACKABLE', false)
    } })
    expect(result.status).toBe('BLOCKED')
    expect(checked).toBe(true)
  })

  it('rejects a claimed receipt whose bytes differ from the actual scoped source', async () => {
    const options = await fixture()
    const result = await runEngineeringTask({ ...options, request: 'Inspect the scoped exports', executeRole: async input => {
      if (!input.role.startsWith('scout-')) throw new Error('Invalid evidence reached a later role')
      if (input.executionControl === undefined) throw new Error('Missing trusted inspection callback')
      await expect(input.executionControl.recordInspection({ executionId: `forged-${input.role}`, path: input.role === 'scout-primary' ? 'src/a/value.ts' : 'src/b/value.ts', contentHash: '0'.repeat(64), toolName: 'read' })).rejects.toThrow(/hash|content|receipt|evidence/i)
      throw new RoleInvocationError('Invalid receipt was rejected', 'NON_FALLBACKABLE', false)
    } })
    expect(result.status).toBe('BLOCKED')
    const repository = new TaskRepository(options.root)
    const checkpoint = await repository.readInvestigationCheckpoint(result.taskId, 'development', 'scout-a')
    expect(checkpoint?.status).not.toBe('COMPLETE')
  })

  it.each(['unchanged', 'unrelated', 'b-content', 'a-content', 'a-membership', 'scope-request'] as const)('reuses only valid completed investigation after %s changes', async change => {
    const options = await fixture()
    const calls: string[] = []
    let primaryFinished!: () => void
    const primary = new Promise<void>(resolve => { primaryFinished = resolve })
    const first = await runEngineeringTask({ ...options, request: 'Inspect A and B exports', executeRole: async input => {
      calls.push(input.role)
      if (input.role === 'scout-primary') {
        try { return await inspect(input) }
        finally { primaryFinished() }
      }
      if (input.role === 'scout-secondary') {
        await primary
        throw new RoleInvocationError('Scout B deadline after confirmed cleanup', 'ROLE_TIMEOUT_QUIESCENT', false)
      }
      throw new Error(`Unexpected role ${input.role}`)
    } })
    expect(first.status).toBe('BLOCKED')
    const repository = new TaskRepository(options.root)
    const checkpoint = await repository.readInvestigationCheckpoint(first.taskId, 'development', 'scout-a')
    expect(checkpoint).toMatchObject({ taskId: first.taskId, unitId: 'scout-a', status: 'COMPLETE' })
    expect(checkpoint?.output).toMatchObject({ findings: ["src/a/value.ts: export const value = 'a'"] })
    if (change === 'unrelated') await writeFile(join(options.root, 'unrelated.txt'), 'Changed unrelated content\n')
    if (change === 'a-content' || change === 'b-content') await writeFile(join(options.root, 'src', change[0]!, 'value.ts'), 'export const value = 2\n')
    if (change === 'a-membership') {
      await writeFile(join(options.root, 'src/a/new.ts'), 'export const added = 1\n')
      await execa('git', ['add', 'src/a/new.ts'], { cwd: options.root })
    }
    await recoverEngineeringTask(options.root, first.taskId, false)
    const resumed = await runEngineeringTask({ ...options, taskId: first.taskId, request: change === 'scope-request' ? 'Inspect A and B exports and compatibility' : '', executeRole: async input => {
      calls.push(input.role)
      if (input.role.startsWith('scout-')) return inspect(input)
      throw new RoleInvocationError('Stop at architecture after checkpoint acceptance', 'NON_FALLBACKABLE', false)
    } })
    expect(resumed.status).toBe('BLOCKED')
    expect(calls.filter(role => role === 'scout-primary')).toHaveLength(['a-content', 'a-membership', 'scope-request'].includes(change) ? 2 : 1)
    expect(calls.filter(role => role === 'scout-secondary')).toHaveLength(2)
    expect(calls.filter(role => role === 'implementer')).toEqual([])
  })
})
