import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ArtifactValidationError } from '../src/schemas.ts'
import { StaleRevisionError, TaskRepository } from '../src/repository.ts'
import type { AtomicWriter } from '../src/repository.ts'
import { resolveVerificationCommand, verificationCommandIdentity } from '../src/verification.ts'
import { identityDigest } from '../src/identity.ts'

const temporaryRoots: string[] = []
const schemaRoot = resolve('.agent/schemas')

async function repository(options: ConstructorParameters<typeof TaskRepository>[2] = {}): Promise<TaskRepository> {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-'))
  temporaryRoots.push(root)
  const store = new TaskRepository(root, schemaRoot, {
    now: () => '2026-10-04T00:00:00.000Z',
    writerToken: () => 'writer-token',
    ...options,
  })
  await store.init()
  await cp(resolve('.agent/profiles'), join(root, '.agent/profiles'), { recursive: true })
  await writeFile(join(root, '.agent/profiles/webapp.yaml'), JSON.stringify({
    schemaVersion: 1, id: 'webapp', checks: [{ name: 'unit', category: 'unit', required: true, timeoutMs: 30000 }],
  }))
  await mkdir(join(root, '.agent/config'), { recursive: true })
  await mkdir(join(root, '.agent/adapters'), { recursive: true })
  await writeFile(join(root, '.agent/config/project.yaml'), JSON.stringify({ schemaVersion: 1, profile: 'webapp', adapter: '.agent/adapters/local.yaml', commandTimeoutMs: 30000 }))
  await writeFile(join(root, '.agent/adapters/local.yaml'), JSON.stringify({ adapters: { unit: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } } }))
  await store.createTask({
    schemaVersion: 1,
    id: 'sample-task',
    title: 'Sample task',
    profile: 'webapp',
    dataClass: 'internal',
    createdAt: '2026-10-04T00:00:00.000Z',
  })
  return store
}

const baseline = { repositoryHead: 'dsh-v0.2.1-alpha.1', dirty: false, summary: 'Clean baseline' }
const investigation = {
  findings: ['Observed the failing behavior'],
  hypotheses: [{ statement: 'The state transition is missing', evidence: ['fixture output'] }],
  unresolvedAssumptions: [],
}
const plan = {
  problemStatement: 'Implement the requested behavior',
  hypotheses: ['The repository protocol is sufficient'],
  selectedApproach: 'Use explicit transitions',
  rejectedAlternatives: ['Model-owned state'],
  invariants: ['Acceptance is deterministic'],
  expectedComponents: ['state engine'],
  implementationScope: ['tools/agent'],
  falsificationTests: ['reject stale revisions'],
  acceptanceGates: ['focused tests pass'],
  unresolvedAssumptions: [],
}
const verification = (status: 'PASS' | 'FAIL' | 'NOT_RUN' | 'INCOMPLETE', checkStatus = status) => ({
  status,
  checks: [{ name: 'unit', category: 'unit', scope: {}, required: true, status: checkStatus, evidenceIds: ['unit-1'] }],
  scope: { profile: 'webapp' },
})
const review = (decision: 'ACCEPT' | 'FIX_BOUNDED' | 'REPLAN' | 'BLOCKED') => ({
  decision,
  summary: 'Independent review',
  findings: [],
  ...decision === 'BLOCKED' ? { blocker: 'External dependency unavailable' } : {},
})

async function frozen(store: TaskRepository): Promise<number> {
  await store.baseline('sample-task', 0, baseline)
  await store.investigate('sample-task', 1, investigation)
  const state = await store.freezePlan('sample-task', 2, plan)
  return state.revision
}

async function frozenWithBlockingAssumption(store: TaskRepository): Promise<number> {
  await store.baseline('sample-task', 0, baseline)
  await store.investigate('sample-task', 1, investigation)
  const state = await store.freezePlan('sample-task', 2, {
    ...plan,
    unresolvedAssumptions: [{ statement: 'Confirm the supported product scope', acceptanceBlocking: true }],
  })
  return state.revision
}

async function completeVerification(store: TaskRepository, expectedRevision: number, writerToken: string, input: object) {
  const state = await store.beginVerification('sample-task', expectedRevision, writerToken)
  const root = temporaryRoots.at(-1)
  if (root === undefined) throw new Error('repository fixture missing')
  const invocation = resolveVerificationCommand(root, { executable: process.execPath, args: ['-e', 'process.exit(0)'] })
  const identity = await store.verificationIdentity('sample-task')
  await store.appendEvidence('sample-task', state.workRevision, [{
    id: 'unit-1', kind: 'command', status: 'PASS', timestamp: '2026-10-04T00:00:00.000Z', summary: 'Unit command passed',
    scope: { name: 'unit', category: 'unit', verificationScope: {}, quiescence: 'CONFIRMED', commandIdentity: verificationCommandIdentity(invocation), identity },
    command: { executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root, exitCode: 0, timedOut: false },
  }], state.revision)
  return store.finishVerification('sample-task', state.revision, { ...input, identity })
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('task repository', () => {
  async function freezeOther(store: TaskRepository): Promise<number> {
    await store.createTask({ schemaVersion: 1, id: 'other-task', title: 'Other task', profile: 'webapp', dataClass: 'internal', createdAt: '2026-10-04T00:00:00.000Z' })
    await store.baseline('other-task', 0, baseline)
    await store.investigate('other-task', 1, investigation)
    return (await store.freezePlan('other-task', 2, plan)).revision
  }

  it('admits at most one direct writer when two frozen tasks start concurrently', async () => {
    const store = await repository()
    const firstRevision = await frozen(store)
    const secondRevision = await freezeOther(store)
    const root = temporaryRoots.at(-1)
    if (root === undefined) throw new Error('repository fixture missing')
    const competingStore = new TaskRepository(root, schemaRoot)
    const outcomes = await Promise.allSettled([
      store.startImplementation('sample-task', firstRevision),
      competingStore.startImplementation('other-task', secondRevision),
    ])
    const states = await Promise.all(['sample-task', 'other-task'].map(id => store.readState(id)))
    expect(states.filter(state => state.writer !== null)).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
    expect(states.filter(state => state.writer === null)[0]).toMatchObject({ state: 'PLAN_FROZEN', revision: 3 })
  })

  it('rejects direct implementation while another task has a durable writer', async () => {
    const store = await repository()
    const first = await store.startImplementation('sample-task', await frozen(store))
    const secondRevision = await freezeOther(store)
    await expect(store.startImplementation('other-task', secondRevision)).rejects.toThrow()
    expect(await store.readState('sample-task')).toEqual(first)
    expect(await store.readState('other-task')).toMatchObject({ state: 'PLAN_FROZEN', revision: secondRevision, writer: null })
  })

  it('rejects direct implementation while another writer termination is uncertain', async () => {
    const store = await repository()
    const firstRevision = await frozen(store)
    const secondRevision = await freezeOther(store)
    const blocked = await store.block('sample-task', firstRevision, 'Writer termination is uncertain. Confirm that all command writes have stopped before explicitly replanning this task.')
    expect(blocked).toMatchObject({ state: 'BLOCKED', writer: null })
    await expect(store.startImplementation('other-task', secondRevision)).rejects.toThrow()
    expect(await store.readState('sample-task')).toEqual(blocked)
    expect(await store.readState('other-task')).toMatchObject({ state: 'PLAN_FROZEN', revision: secondRevision, writer: null })
  })

  it('preserves uncertain-termination quarantine when direct replanning lacks stop confirmation', async () => {
    const store = await repository()
    const revision = await frozen(store)
    const blocked = await store.block('sample-task', revision, 'Writer termination is uncertain. Confirm that all command writes have stopped before explicitly replanning this task.')
    expect(blocked).toMatchObject({ state: 'BLOCKED', writer: null })
    await expect(store.replan('sample-task', blocked.revision)).rejects.toThrow(/confirm.*work has stopped/)
    expect(await store.readState('sample-task')).toEqual(blocked)
  })

  it.each(['replan', 'block'] as const)('rejects repository %s while the writer lease is active', async action => {
    const store = await repository()
    const implementing = await store.startImplementation('sample-task', await frozen(store))
    const pending = action === 'replan'
      ? store.replan('sample-task', implementing.revision)
      : store.block('sample-task', implementing.revision, 'External dependency unavailable')
    await expect(pending).rejects.toThrow()
    expect(await store.readState('sample-task')).toEqual(implementing)
  })

  it('permits repository replanning after explicit writer release', async () => {
    const store = await repository()
    const implementing = await store.startImplementation('sample-task', await frozen(store))
    const released = await store.releaseImplementation('sample-task', implementing.revision, implementing.writer?.token ?? '')
    expect(await store.replan('sample-task', released.revision)).toMatchObject({ state: 'REPLAN', writer: null, revision: released.revision + 1 })
  })

  it('captures resolved commands, gates, arguments and the seal for one verification attempt', async () => {
    const store = await repository()
    let state = await store.startImplementation('sample-task', await frozen(store))
    state = await store.beginVerification('sample-task', state.revision, state.writer?.token ?? '')
    const snapshot = await store.verificationExecutionContext('sample-task')
    expect(snapshot.config.adapters.unit).toMatchObject({ executable: process.execPath, args: ['-e', 'process.exit(0)'] })
    expect(snapshot.gates).toEqual(await store.verificationGates('sample-task'))
    expect(snapshot.arguments).toEqual(await store.verificationArguments('sample-task'))
    expect(snapshot.identity).toEqual(await store.verificationIdentity('sample-task'))
    await expect(store.assertVerificationExecutionContext('sample-task', snapshot)).resolves.toBeUndefined()
    snapshot.config.adapters.unit!.args = ['-e', 'process.exit(1)']
    await expect(store.assertVerificationExecutionContext('sample-task', snapshot)).rejects.toThrow('execution identity changed')
    expect((await store.readState('sample-task')).revision).toBe(state.revision)
  })

  it('refuses a previous command result on a new source attempt even with a fresh evidence ID', async () => {
    const store = await repository()
    let state = await store.startImplementation('sample-task', await frozen(store))
    state = await completeVerification(store, state.revision, state.writer?.token ?? '', verification('FAIL'))
    const root = temporaryRoots.at(-1)
    if (root === undefined) throw new Error('repository fixture missing')
    const old = JSON.parse((await readFile(join(root, '.agent/tasks/sample-task/EVIDENCE.jsonl'), 'utf8')).trim())
    state = await store.startImplementation('sample-task', state.revision)
    await writeFile(join(root, 'changed.cpp'), 'new source\n')
    state = await store.beginVerification('sample-task', state.revision, state.writer?.token ?? '')
    await expect(store.appendEvidence('sample-task', state.workRevision, [{ ...old, id: 'replayed-with-fresh-id' }], state.revision))
      .rejects.toThrow('attempt identity changed')
    await expect(store.finishVerification('sample-task', state.revision, { ...verification('PASS'), identity: old.scope.identity }))
      .rejects.toThrow('attempt identity changed')
    expect((await store.readState('sample-task')).state).toBe('VERIFYING')
  })

  it('rejects advertised attempt rollback even after the triggering source is restored', async () => {
    const store = await repository()
    let state = await store.startImplementation('sample-task', await frozen(store))
    state = await completeVerification(store, state.revision, state.writer?.token ?? '', verification('FAIL'))
    const root = temporaryRoots.at(-1)
    if (root === undefined) throw new Error('repository fixture missing')
    const path = join(root, '.agent/tasks/sample-task/PLAN.json')
    const first = JSON.parse(await readFile(path, 'utf8'))
    state = await store.startImplementation('sample-task', state.revision)
    state = await completeVerification(store, state.revision, state.writer?.token ?? '', verification('PASS'))
    state = await store.review('sample-task', state.revision, review('ACCEPT'))
    await writeFile(path, JSON.stringify(first))
    await expect(store.accept('sample-task', state.revision)).rejects.toThrow('attempt identity changed')
  })

  it('rejects command evidence while a writer still owns an unsealed attempt', async () => {
    const store = await repository()
    await store.startImplementation('sample-task', await frozen(store))
    await expect(store.appendEvidence('sample-task', 1, [{
      id: 'early-command', kind: 'command', status: 'PASS', timestamp: '2026-10-04T00:00:00.000Z', summary: 'Unsealed command', scope: {},
    }])).rejects.toThrow('seal and verify again')
  })

  it.each(['source', 'plan-intent', 'plan-intent-redigested', 'baseline', 'preset-receipt', 'attempt-evidence'])(
    'rejects %s tampering after independent approval', async invalid => {
      const store = await repository()
      let state = await store.startImplementation('sample-task', await frozen(store))
      state = await completeVerification(store, state.revision, state.writer?.token ?? '', verification('PASS'))
      state = await store.review('sample-task', state.revision, review('ACCEPT'))
      const root = temporaryRoots.at(-1)
      if (root === undefined) throw new Error('repository fixture missing')
      const directory = join(root, '.agent/tasks/sample-task')
      if (invalid === 'source') await writeFile(join(root, 'new-source.cpp'), 'modified source\n')
      if (invalid.startsWith('plan-intent')) {
        const source = JSON.parse(await readFile(join(directory, 'PLAN.json'), 'utf8'))
        source.selectedApproach = 'Different approach'
        if (invalid === 'plan-intent-redigested') source.intentDigest = identityDigest(Object.fromEntries(Object.entries(source).filter(([key]) => !['schemaVersion', 'taskId', 'taskRevision', 'workRevision', 'binding', 'intentDigest'].includes(key))) as Parameters<typeof identityDigest>[0])
        await writeFile(join(directory, 'PLAN.json'), JSON.stringify(source))
      }
      if (invalid === 'baseline') {
        const source = JSON.parse(await readFile(join(directory, 'SOURCE_BASELINE.1.json'), 'utf8'))
        source.head = 'different-baseline'
        await writeFile(join(directory, 'SOURCE_BASELINE.1.json'), JSON.stringify(source))
      }
      if (invalid === 'preset-receipt') await writeFile(join(directory, 'TASK_PRESET.json'), JSON.stringify({ schemaVersion: 1, preset: { id: 'changed', version: '1', digest: '0'.repeat(64) } }))
      if (invalid === 'attempt-evidence') {
        const source = JSON.parse((await readFile(join(directory, 'EVIDENCE.jsonl'), 'utf8')).trim())
        source.scope.identity.attempt += 1
        await writeFile(join(directory, 'EVIDENCE.jsonl'), JSON.stringify(source) + '\n')
      }
      await expect(store.accept('sample-task', state.revision)).rejects.toThrow(/identity changed|intent changed/)
      await expect(readFile(join(directory, 'DECISION.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it.skipIf(process.platform === 'win32')('rejects same-content source symlink retargeting', async () => {
    const store = await repository()
    const root = temporaryRoots.at(-1)
    if (root === undefined) throw new Error('repository fixture missing')
    await writeFile(join(root, 'first.cpp'), 'same bytes\n')
    await writeFile(join(root, 'second.cpp'), 'same bytes\n')
    await symlink('first.cpp', join(root, 'selected.cpp'))
    let state = await store.startImplementation('sample-task', await frozen(store))
    state = await completeVerification(store, state.revision, state.writer?.token ?? '', verification('PASS'))
    state = await store.review('sample-task', state.revision, review('ACCEPT'))
    await unlink(join(root, 'selected.cpp'))
    await symlink('second.cpp', join(root, 'selected.cpp'))
    await expect(store.accept('sample-task', state.revision)).rejects.toThrow('identity changed')
  })

  it('accepts fresh scoped evidence without reusing unreferenced duplicate legacy CLI records', async () => {
    const store = await repository()
    let state = await store.startImplementation('sample-task', await frozen(store))
    state = await completeVerification(store, state.revision, state.writer?.token ?? '', verification('PASS'))
    state = await store.review('sample-task', state.revision, review('ACCEPT'))
    const root = temporaryRoots.at(-1)
    if (root === undefined) throw new Error('repository fixture missing')
    const path = join(root, '.agent/tasks/sample-task/EVIDENCE.jsonl')
    const current = await readFile(path, 'utf8')
    const legacy = { ...JSON.parse(current.trim()), id: 'command:unit:1', scope: {} }
    const oldRecords = `${JSON.stringify(legacy)}\n${JSON.stringify(legacy)}\n`
    await writeFile(path, oldRecords + current)
    expect((await store.accept('sample-task', state.revision)).state).toBe('ACCEPTED')
    expect(await readFile(path, 'utf8')).toBe(oldRecords + current)
  })

  it.each(['missing', 'other-scope', 'other-category', 'other-task', 'stale', 'failed', 'timeout', 'duplicate', 'other-command', 'uncertain'])(
    'rejects %s command evidence through the public acceptance API', async invalid => {
      const store = await repository()
      let state = await store.startImplementation('sample-task', await frozen(store))
      state = await completeVerification(store, state.revision, state.writer?.token ?? '', verification('PASS'))
      state = await store.review('sample-task', state.revision, review('ACCEPT'))
      const root = temporaryRoots.at(-1)
      if (root === undefined) throw new Error('repository fixture missing')
      const path = join(root, '.agent/tasks/sample-task/EVIDENCE.jsonl')
      const evidence = JSON.parse((await readFile(path, 'utf8')).trim())
      if (invalid === 'missing') evidence.id = 'unreferenced'
      if (invalid === 'other-scope') evidence.scope.verificationScope = { backend: 'other' }
      if (invalid === 'other-category') evidence.scope.category = 'other'
      if (invalid === 'other-task') evidence.taskId = 'other-task'
      if (invalid === 'stale') evidence.workRevision = 2
      if (invalid === 'failed') evidence.command.exitCode = 7
      if (invalid === 'timeout') evidence.command.timedOut = true
      if (invalid === 'other-command') evidence.command.args = ['-e', 'process.exit(0);console.log("different")']
      if (invalid === 'uncertain') evidence.scope.quiescence = 'UNCERTAIN'
      await writeFile(path, `${JSON.stringify(evidence)}\n${invalid === 'duplicate' ? JSON.stringify(evidence) + '\n' : ''}`)
      await expect(store.accept('sample-task', state.revision)).rejects.toThrow(/evidence|command/)
      await expect(readFile(join(root, '.agent/tasks/sample-task/DECISION.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it.each([
    ['command arguments', 'acceptance command identity changed'],
    ['bound plan identity', 'cumulative requirements or attempt identity changed'],
  ])('rejects invalid %s before the unresolved-assumption blocker at acceptance', async (invalid, expectedError) => {
    const store = await repository()
    let state = await store.startImplementation('sample-task', await frozenWithBlockingAssumption(store))
    state = await completeVerification(store, state.revision, state.writer?.token ?? '', verification('PASS'))
    state = await store.review('sample-task', state.revision, review('ACCEPT'))
    const root = temporaryRoots.at(-1)
    if (root === undefined) throw new Error('repository fixture missing')
    const directory = join(root, '.agent/tasks/sample-task')
    if (invalid === 'command arguments') {
      const path = join(directory, 'EVIDENCE.jsonl')
      const evidence = JSON.parse((await readFile(path, 'utf8')).trim())
      evidence.command.args = ['-e', 'process.exit(1)']
      await writeFile(path, `${JSON.stringify(evidence)}\n`)
    } else {
      const path = join(directory, 'PLAN.json')
      const source = JSON.parse(await readFile(path, 'utf8'))
      source.binding.seal.attempt += 1
      await writeFile(path, JSON.stringify(source))
    }

    await expect(store.accept('sample-task', state.revision)).rejects.toThrow(expectedError)
    expect(await store.readState('sample-task')).toMatchObject({ state: 'REVIEWED', revision: state.revision })
    await expect(readFile(join(directory, 'DECISION.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['missing', 'wrong-scope', 'wrong-category', 'optional', 'no-evidence', 'legacy'])(
    'rejects %s verification even after an ACCEPT review', async invalid => {
      const store = await repository()
      let state = await store.startImplementation('sample-task', await frozen(store))
      state = await completeVerification(store, state.revision, state.writer?.token ?? '', verification('PASS'))
      state = await store.review('sample-task', state.revision, review('ACCEPT'))
      const root = temporaryRoots.at(-1)
      if (root === undefined) throw new Error('repository fixture missing')
      const path = join(root, '.agent/tasks/sample-task/VERIFY.json')
      const source = JSON.parse(await readFile(path, 'utf8'))
      if (invalid === 'missing') source.checks[0].name = 'unrelated'
      if (invalid === 'wrong-scope') source.checks[0].scope = { backend: 'unverified' }
      if (invalid === 'wrong-category') source.checks[0].category = 'unrelated'
      if (invalid === 'optional') source.checks[0].required = false
      if (invalid === 'no-evidence') source.checks[0].evidenceIds = []
      if (invalid === 'legacy') {
        source.schemaVersion = 1
        delete source.identity
        delete source.checks[0].category
        delete source.checks[0].scope
      }
      await writeFile(path, JSON.stringify(source))
      await expect(store.accept('sample-task', state.revision)).rejects.toThrow(/required instance|identity-bearing artifacts/)
      await expect(readFile(join(root, '.agent/tasks/sample-task/DECISION.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('rejects a task whose declared profile is not registered in its repository before writing task state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentctl-missing-profile-'))
    temporaryRoots.push(root)
    const store = new TaskRepository(root, schemaRoot)
    await store.init()
    await expect(store.createTask({
      schemaVersion: 1, id: 'unregistered-task', title: 'Missing repository profile',
      profile: 'compiler', dataClass: 'public', createdAt: '2026-10-04T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, '.agent/tasks/unregistered-task/STATE.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('completes the legal path and rejects double acceptance', async () => {
    const store = await repository()
    const planRevision = await frozen(store)
    const implementing = await store.startImplementation('sample-task', planRevision)
    const verified = await completeVerification(store, implementing.revision, implementing.writer?.token ?? '', verification('PASS'))
    const reviewed = await store.review('sample-task', verified.revision, review('ACCEPT'))
    const accepted = await store.accept('sample-task', reviewed.revision)

    expect(accepted).toMatchObject({ state: 'ACCEPTED', revision: 9, workRevision: 1 })
    await expect(store.accept('sample-task', accepted.revision)).rejects.toThrow('requires REVIEWED state')
  })

  it('rejects stale revisions before changing artifacts', async () => {
    const store = await repository()
    await store.baseline('sample-task', 0, baseline)
    await expect(store.investigate('sample-task', 0, investigation)).rejects.toBeInstanceOf(StaleRevisionError)
    expect(await store.readState('sample-task')).toMatchObject({ state: 'BASELINED', revision: 1 })
  })

  it('forces replan after two failed verification rounds', async () => {
    const store = await repository()
    let state = await store.startImplementation('sample-task', await frozen(store))
    state = await completeVerification(store, state.revision, state.writer?.token ?? '', verification('FAIL'))
    expect(state).toMatchObject({ state: 'IMPLEMENTING', fixAttempts: 1 })
    state = await store.startImplementation('sample-task', state.revision)
    state = await completeVerification(store, state.revision, state.writer?.token ?? '', verification('NOT_RUN'))
    expect(state).toMatchObject({ state: 'REPLAN', fixAttempts: 2 })
  })

  it('counts bounded reviewer fixes against the same limit', async () => {
    const store = await repository()
    let state = await store.startImplementation('sample-task', await frozen(store))
    state = await completeVerification(store, state.revision, state.writer?.token ?? '', verification('PASS'))
    state = await store.review('sample-task', state.revision, review('FIX_BOUNDED'))
    expect(state).toMatchObject({ state: 'IMPLEMENTING', fixAttempts: 1 })
    state = await store.startImplementation('sample-task', state.revision)
    state = await completeVerification(store, state.revision, state.writer?.token ?? '', verification('PASS'))
    state = await store.review('sample-task', state.revision, review('FIX_BOUNDED'))
    expect(state).toMatchObject({ state: 'REPLAN', fixAttempts: 2 })
  })

  it('does not let an ACCEPT review override a failed required check', async () => {
    const store = await repository()
    let state = await store.startImplementation('sample-task', await frozen(store))
    state = await completeVerification(store, state.revision, state.writer?.token ?? '', verification('PASS', 'FAIL'))
    state = await store.review('sample-task', state.revision, review('ACCEPT'))
    await expect(store.accept('sample-task', state.revision)).rejects.toThrow('every required verification check to pass')
  })

  it('fails closed when an acceptance artifact is corrupted', async () => {
    const store = await repository()
    let state = await store.startImplementation('sample-task', await frozen(store))
    state = await completeVerification(store, state.revision, state.writer?.token ?? '', verification('PASS'))
    state = await store.review('sample-task', state.revision, review('ACCEPT'))
    const verifyPath = join(temporaryRoots.at(-1) ?? '', '.agent', 'tasks', 'sample-task', 'VERIFY.json')
    await writeFile(verifyPath, '{"status":"PASS"}\n')

    await expect(store.accept('sample-task', state.revision)).rejects.toBeInstanceOf(ArtifactValidationError)
  })

  it('fails closed when an acceptance artifact is missing', async () => {
    const store = await repository()
    let state = await store.startImplementation('sample-task', await frozen(store))
    state = await completeVerification(store, state.revision, state.writer?.token ?? '', verification('PASS'))
    state = await store.review('sample-task', state.revision, review('ACCEPT'))
    await unlink(join(temporaryRoots.at(-1) ?? '', '.agent', 'tasks', 'sample-task', 'VERIFY.json'))

    await expect(store.accept('sample-task', state.revision)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the last complete state when the state commit is interrupted', async () => {
    let failStateWrite = false
    const interruptedWriter: AtomicWriter = async (filename, content, options) => {
      if (failStateWrite && filename.endsWith('STATE.json')) throw new Error('injected state commit failure')
      await writeFileAtomic(filename, content, options)
    }
    const store = await repository({ writeAtomic: interruptedWriter })
    failStateWrite = true
    await expect(store.baseline('sample-task', 0, baseline)).rejects.toThrow('injected state commit failure')
    failStateWrite = false

    expect(await store.readState('sample-task')).toMatchObject({ state: 'NEW', revision: 0 })
    const artifact = JSON.parse(await readFile(join(temporaryRoots.at(-1) ?? '', '.agent', 'tasks', 'sample-task', 'BASELINE.json'), 'utf8'))
    expect(artifact).toMatchObject({ taskRevision: 1 })
  })

  it('rejects malformed artifacts through their committed schemas', async () => {
    const store = await repository()
    await expect(store.baseline('sample-task', 0, { dirty: false })).rejects.toBeInstanceOf(ArtifactValidationError)
    expect(await store.readState('sample-task')).toMatchObject({ state: 'NEW', revision: 0 })
  })

  it('appends evidence only for the current work revision', async () => {
    const store = await repository()
    await frozen(store)
    const implementing = await store.startImplementation('sample-task', 3)
    const verifying = await store.beginVerification('sample-task', implementing.revision, implementing.writer?.token ?? '')
    const records = await store.appendEvidence('sample-task', 1, [{
      id: 'command:unit:1',
      kind: 'command',
      status: 'PASS',
      timestamp: '2026-10-04T00:00:00.000Z',
      summary: 'unit passed',
      scope: { identity: await store.verificationIdentity('sample-task') },
    }], verifying.revision)
    expect(records).toHaveLength(1)
    await expect(store.appendEvidence('sample-task', 0, [])).rejects.toThrow('stale work revision')
  })
})
