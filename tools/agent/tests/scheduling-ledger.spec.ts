import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskRepository } from '../src/repository.ts'
import { classifyEngineeringTask, TaskSchedulingRepository } from '../src/scheduling.ts'
import type { DiagnosisOutput, TaskClassificationInput } from '../src/scheduling.ts'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-scheduling-ledger-'))
  roots.push(root)
  await cp(resolve('.agent'), join(root, '.agent'), { recursive: true, filter: source => !source.includes(join('.agent', 'tasks')) && !source.includes(join('.agent', 'reviews')) })
  const repository = new TaskRepository(root)
  await repository.init()
  await repository.createTask({ schemaVersion: 1, id: 'adaptive', title: 'Persist bounded capability decisions', profile: 'small-feature', dataClass: 'public', createdAt: '2026-10-08T00:00:00.000Z' })
  return { root, repository }
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const trigger = { failureKey: 'attempt:first:capability', recoveryEpoch: 0, role: 'scout-primary', reason: 'EVIDENCE_INSUFFICIENT' as const, sourceFingerprint: 'a'.repeat(64) }

describe('durable scheduling reservations', () => {
  it('applies file-count limits to cumulative scope across narrower replans', () => {
    const limits = { simpleMaxFiles: 1, standardMaxFiles: 2 }
    const input = { request: 'Write the named output file', profile: 'small-feature', baselineDirty: false }
    const first = classifyEngineeringTask({ ...input, policy: { class: 'simple', scopePaths: ['a.txt'], acceptanceCriteria: ['Exact output'] } }, limits)
    expect(first.taskClass).toBe('simple')
    const second = classifyEngineeringTask({ ...input, previous: first, policy: { class: 'simple', scopePaths: ['b.txt'], acceptanceCriteria: ['Exact output'] } }, limits)
    expect(second).toMatchObject({ taskClass: 'standard', scopePaths: ['a.txt', 'b.txt'] })
    const third = classifyEngineeringTask({ ...input, previous: second, policy: { class: 'simple', scopePaths: ['c.txt'], acceptanceCriteria: ['Exact output'] } }, limits)
    expect(third).toMatchObject({ taskClass: 'complex', scopePaths: ['a.txt', 'b.txt', 'c.txt'] })
  })

  it('preserves an explicit low-risk complex policy without adding challenge and retains prior or high-risk challenge', async () => {
    const limits = { simpleMaxFiles: 2, standardMaxFiles: 8 }
    const input: TaskClassificationInput = { request: 'Write the named output file', profile: 'small-feature', baselineDirty: false, policy: { class: 'complex', scopePaths: ['a.txt'], acceptanceCriteria: ['Exact output'], needsInvestigation: false, needsChallenge: false } }
    const lowRisk = classifyEngineeringTask(input, limits)
    expect(lowRisk).toMatchObject({ taskClass: 'complex', needsChallenge: false })
    const { root } = await fixture()
    const store = new TaskSchedulingRepository(root, 'adaptive', 'development', { maxEscalations: 1 })
    await store.initializeNew()
    expect(await store.recordClassification(lowRisk)).toMatchObject({ taskClass: 'complex', needsChallenge: false })
    const highRisk = classifyEngineeringTask({ ...input, policy: { ...input.policy, risks: ['concurrency'] } }, limits)
    expect(highRisk).toMatchObject({ taskClass: 'complex', needsChallenge: true })
    await store.recordClassification(highRisk)
    expect(await store.recordClassification(lowRisk)).toMatchObject({ taskClass: 'complex', needsChallenge: true, risks: expect.arrayContaining(['concurrency']) })
    expect(classifyEngineeringTask({ ...input, previous: highRisk }, limits).needsChallenge).toBe(true)
    expect(classifyEngineeringTask({ request: 'Inspect source', profile: 'small-feature', baselineDirty: false }, limits).needsChallenge).toBe(true)
  })

  it('promotes an IR semantics request despite a bounded non-IR file scope', () => {
    expect(classifyEngineeringTask({ request: 'Change IR semantics', profile: 'small-feature', baselineDirty: false, policy: { class: 'simple', scopePaths: ['answer.txt'], acceptanceCriteria: ['Exact output'] } }, { simpleMaxFiles: 2, standardMaxFiles: 8 })).toMatchObject({ taskClass: 'complex', needsChallenge: true })
  })

  it('does not let a selected pending diagnosis bypass another task writer', async () => {
    const { root, repository } = await fixture()
    const store = new TaskSchedulingRepository(root, 'adaptive', 'development', { maxEscalations: 1 })
    await store.initializeNew()
    await store.recordDiagnosisObligation({ failureKey: 'writer:pending', writerRevision: 0, planDigest: 'b'.repeat(64), sourceFingerprint: trigger.sourceFingerprint })
    await expect(repository.assertDispatchAdmission('adaptive', undefined, false, true)).resolves.toBeUndefined()
    const other = await repository.createTask({ schemaVersion: 1, id: 'other', title: 'Own an interrupted writer', profile: 'small-feature', dataClass: 'public', createdAt: '2026-10-08T00:00:00.000Z' })
    await writeFile(join(root, '.agent/tasks/other/STATE.json'), `${JSON.stringify({ ...other, state: 'IMPLEMENTING', writer: { role: 'implementer', token: 'other-writer-token', baseRevision: 0 } })}\n`)
    await expect(repository.assertDispatchAdmission('adaptive', undefined, false, true)).rejects.toThrow(/other.*writer|interrupted writer/i)
  })

  it('charges distinct repair failures separately while repeated observation reuses one reservation', async () => {
    const { root } = await fixture()
    const store = new TaskSchedulingRepository(root, 'adaptive', 'development', { maxEscalations: 2 })
    await store.initializeNew()
    const first = await store.reserveEscalation({ ...trigger, failureKey: 'verification:work-3:attempt-1:digest-a', reason: 'REPAIR_FAILED' })
    expect((await store.reserveEscalation({ ...trigger, failureKey: 'verification:work-3:attempt-1:digest-a', reason: 'REPAIR_FAILED' })).id).toBe(first.id)
    const second = await store.reserveEscalation({ ...trigger, failureKey: 'verification:work-3:attempt-2:digest-b', reason: 'REPAIR_FAILED' })
    expect(second.id).not.toBe(first.id)
    expect((await store.read()).escalations).toHaveLength(2)
    await store.recover({ confirmedStopped: true })
    await expect(store.reserveEscalation({ ...trigger, recoveryEpoch: 1, failureKey: 'verification:work-3:attempt-3:digest-c', reason: 'REPAIR_FAILED' })).rejects.toThrow(/budget|escalation|cap/i)
  })

  it('classifies reproducibly and preserves the entire task risk floor across policy changes', async () => {
    const limits = { simpleMaxFiles: 2, standardMaxFiles: 8 }
    const input: TaskClassificationInput = { request: 'Write answer.txt containing 42', profile: 'small-feature', baselineDirty: false, policy: { class: 'simple', scopePaths: ['answer.txt'], acceptanceCriteria: ['answer.txt contains 42'], risks: [], needsInvestigation: false, needsChallenge: false } }
    const first = classifyEngineeringTask(input, limits)
    expect(first).toMatchObject({ taskClass: 'simple', scopePaths: ['answer.txt'], needsInvestigation: false, needsChallenge: false })
    expect(classifyEngineeringTask(input, limits)).toEqual(first)
    const risky = classifyEngineeringTask({ ...input, request: 'Repair concurrent cancellation', policy: { ...input.policy, risks: ['concurrency'] } }, limits)
    expect(risky).toMatchObject({ taskClass: 'complex', needsChallenge: true, risks: expect.arrayContaining(['concurrency']) })
    const narrowed = classifyEngineeringTask({ ...input, request: 'Only change answer.txt now', previous: risky }, { simpleMaxFiles: 100, standardMaxFiles: 1000 })
    expect(narrowed).toMatchObject({ taskClass: 'complex', risks: expect.arrayContaining(['concurrency']) })
    expect(narrowed.reasons.length).toBeGreaterThan(0)
  })

  it('promotes a repeated classification input without lowering its persisted class', async () => {
    const { root } = await fixture()
    const store = new TaskSchedulingRepository(root, 'adaptive', 'development', { maxEscalations: 1 })
    await store.initializeNew()
    const simple = { taskClass: 'simple' as const, reasons: [], risks: [], inputDigest: 'd'.repeat(64), scopePaths: ['answer.txt'], needsInvestigation: false, needsChallenge: false }
    const promoted = { ...simple, taskClass: 'complex' as const, risks: ['runtime'], needsInvestigation: true, needsChallenge: true }
    expect(await store.recordClassification(simple)).toMatchObject({ taskClass: 'simple' })
    expect(await store.recordClassification(promoted)).toMatchObject({ taskClass: 'complex', risks: ['runtime'] })
    expect(await store.recordClassification(simple)).toMatchObject({ taskClass: 'complex', risks: ['runtime'] })
    expect((await store.read()).classifications).toHaveLength(1)
  })

  it.each(['needsInvestigation', 'needsChallenge'] as const)('promotes requested simple tasks that require %s', field => {
    const result = classifyEngineeringTask({ request: 'Write answer.txt', profile: 'small-feature', baselineDirty: false,
      policy: { class: 'simple', scopePaths: ['answer.txt'], acceptanceCriteria: ['Exact output'], [field]: true },
    }, { simpleMaxFiles: 2, standardMaxFiles: 8 })
    expect(result.taskClass).toBe('standard')
  })

  it('promotes explicit standard scope above the configured file limit', () => {
    const result = classifyEngineeringTask({ request: 'Update declared text files', profile: 'small-feature', baselineDirty: false,
      policy: { class: 'standard', scopePaths: ['a.txt', 'b.txt', 'c.txt'], acceptanceCriteria: ['Exact output'] },
    }, { simpleMaxFiles: 1, standardMaxFiles: 2 })
    expect(result.taskClass).toBe('complex')
  })

  it.each(['compiler', 'ir', 'directory', 'glob', 'dirty', 'missing-criteria', 'metadata', 'bilingual-risk'] as const)('does not authorize simple for %s facts', async scenario => {
    const input: TaskClassificationInput = { request: scenario === 'bilingual-risk' ? '修复并发取消时的生命周期竞态' : 'Change the bounded source', profile: scenario === 'compiler' ? 'compiler' : 'small-feature', baselineDirty: scenario === 'dirty', policy: { class: 'simple', scopePaths: [scenario === 'ir' ? 'src/pass.mlir' : scenario === 'directory' ? 'src/' : scenario === 'glob' ? 'src/*' : scenario === 'metadata' ? '.agent/config/project.yaml' : 'answer.txt'], acceptanceCriteria: scenario === 'missing-criteria' ? [] : ['The exact output passes unit checks'], risks: [], needsInvestigation: false, needsChallenge: false } }
    const classify = () => classifyEngineeringTask(input, { simpleMaxFiles: 2, standardMaxFiles: 8 })
    expect(classify().taskClass).not.toBe('simple')
  })

  it('charges reserve once and admits exactly one dispatch across concurrent facades', async () => {
    const { root, repository } = await fixture()
    const store = new TaskSchedulingRepository(root, 'adaptive', 'development', { maxEscalations: 2 })
    await store.initializeNew()
    const first = await store.reserveEscalation(trigger)
    const second = await store.reserveEscalation(trigger)
    expect(second.id).toBe(first.id)
    const reopened = new TaskSchedulingRepository(root, 'adaptive', 'development', { maxEscalations: 2 })
    const contenders = await Promise.allSettled([store.beginDispatch(first.id, 'attempt-strong-1'), reopened.beginDispatch(first.id, 'attempt-strong-2')])
    expect(contenders.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(contenders.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await reopened.read()).escalations).toHaveLength(1)
    await expect(repository.assertDispatchAdmission('adaptive')).rejects.toThrow(/dispatch|uncertain|escalation|stop/i)
    await expect(reopened.recover({ confirmedStopped: false })).rejects.toThrow(/stop|uncertain|confirm/i)
    await reopened.recover({ confirmedStopped: true })
    const retry = await reopened.reserveEscalation({ ...trigger, recoveryEpoch: 1 })
    expect(retry.id).not.toBe(first.id)
    await expect(reopened.reserveEscalation({ ...trigger, recoveryEpoch: 1, failureKey: 'attempt:third:capability' })).rejects.toThrow(/budget|escalation|cap/i)
    expect((await reopened.read()).escalations).toHaveLength(2)
  })

  it('keeps a pending or completed-but-unapplied diagnosis blocking writer admission across recovery', async () => {
    const { root, repository } = await fixture()
    const store = new TaskSchedulingRepository(root, 'adaptive', 'development', { maxEscalations: 2 })
    await store.initializeNew()
    await store.recordDiagnosisObligation({ failureKey: 'writer:attempt-1', writerRevision: 5, planDigest: 'b'.repeat(64), sourceFingerprint: 'a'.repeat(64) })
    await expect(repository.assertDispatchAdmission('adaptive')).rejects.toThrow(/diagnos|pending|obligation/i)
    await store.recover({ confirmedStopped: true })
    await expect(repository.assertDispatchAdmission('adaptive')).rejects.toThrow(/diagnos|pending|obligation/i)
    await store.completeDiagnosis('writer:attempt-1', { summary: 'Keep the frozen scope', observations: ['Existing source bytes inspected'], recommendation: 'REPAIR_WITHIN_PLAN', repairConstraints: ['Only answer.txt'], unresolvedQuestions: [] }, 'a'.repeat(64))
    await expect(repository.assertDispatchAdmission('adaptive')).rejects.toThrow(/diagnos|appl|obligation/i)
    expect((await store.read()).diagnoses).toEqual(expect.arrayContaining([expect.objectContaining({ failureKey: 'writer:attempt-1', status: 'COMPLETE' })]))
    await expect(store.applyDiagnosis('writer:attempt-1', 99)).rejects.toThrow(/revision|plan|state|appl|intent/i)
    await expect(repository.assertDispatchAdmission('adaptive')).rejects.toThrow(/diagnos|appl|obligation/i)
  })

  it('resumes a reserved crash checkpoint without a second charge and binds completion to its source fingerprint', async () => {
    const { root } = await fixture()
    const store = new TaskSchedulingRepository(root, 'adaptive', 'development', { maxEscalations: 1 })
    await store.initializeNew()
    const reserved = await store.reserveEscalation(trigger)
    const reopened = new TaskSchedulingRepository(root, 'adaptive', 'development', { maxEscalations: 1 })
    const resumed = await reopened.reserveEscalation(trigger)
    expect(resumed.id).toBe(reserved.id)
    await reopened.beginDispatch(resumed.id, 'attempt-bound')
    await expect(reopened.completeEscalation(resumed.id, { summary: 'Source changed during diagnosis' }, 'b'.repeat(64))).rejects.toThrow(/source|fingerprint|mismatch/i)
    await reopened.completeEscalation(resumed.id, { summary: 'Acquired bounded stronger analysis' }, trigger.sourceFingerprint)
    const durable = new TaskSchedulingRepository(root, 'adaptive', 'development', { maxEscalations: 1 })
    expect((await durable.read()).escalations).toEqual([expect.objectContaining({ id: resumed.id, status: 'COMPLETE', output: { summary: 'Acquired bounded stronger analysis' } })])
    await expect(durable.beginDispatch(resumed.id, 'duplicate-after-complete')).rejects.toThrow(/dispatch|complete|state|status/i)
    await expect(durable.reserveEscalation({ ...trigger, failureKey: 'distinct-repair-in-same-revision' })).rejects.toThrow(/budget|escalation|cap/i)
  })

  it('replays a durable diagnosis application after interruption before APPLIED without admitting a writer early', async () => {
    const { root, repository } = await fixture()
    let tick = 0
    const options = { maxEscalations: 1, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString() }
    const store = new TaskSchedulingRepository(root, 'adaptive', 'development', options)
    await store.initializeNew()
    const failureKey = 'writer:stopped-attempt'
    const planDigest = 'b'.repeat(64)
    const output: DiagnosisOutput = { summary: 'Replan before another writer', observations: ['The frozen scope does not include the required source'], recommendation: 'REPLAN', repairConstraints: ['Keep all existing source changes'], unresolvedQuestions: [] }
    await store.recordDiagnosisObligation({ failureKey, writerRevision: 0, planDigest, sourceFingerprint: trigger.sourceFingerprint })
    await store.completeDiagnosis(failureKey, output, trigger.sourceFingerprint)
    const state = await repository.readState('adaptive')
    const appliedState = { ...state, state: 'REPLAN', revision: state.revision + 1 }
    await writeFile(join(root, '.agent/tasks/adaptive/STATE.json'), `${JSON.stringify(appliedState)}\n`)
    await writeFile(join(root, '.agent/tasks/adaptive/PLAN.json'), `${JSON.stringify({ schemaVersion: 2, taskId: 'adaptive', intentDigest: planDigest })}\n`)
    const application = { stateRevision: appliedState.revision, planDigest, recommendation: 'REPLAN' as const, repairConstraints: output.repairConstraints }
    const firstApplication = await store.recordDiagnosisApplication(failureKey, application)
    expect(await store.recordDiagnosisApplication(failureKey, application)).toEqual(firstApplication)
    await expect(repository.assertDispatchAdmission('adaptive')).rejects.toThrow(/diagnos|appl|obligation/i)
    const reopened = new TaskSchedulingRepository(root, 'adaptive', 'development', options)
    expect((await reopened.read()).diagnoses).toEqual([expect.objectContaining({ failureKey, status: 'COMPLETE', output })])
    await reopened.applyDiagnosis(failureKey, appliedState.revision)
    await reopened.applyDiagnosis(failureKey, appliedState.revision)
    expect((await reopened.read()).diagnoses).toEqual([expect.objectContaining({ failureKey, status: 'APPLIED', output })])
    await expect(repository.assertDispatchAdmission('adaptive')).resolves.toBeUndefined()
  })

  it('keeps a diagnosis pending when its read-only execution reports a changed source fingerprint', async () => {
    const { root, repository } = await fixture()
    const store = new TaskSchedulingRepository(root, 'adaptive', 'development', { maxEscalations: 1 })
    await store.initializeNew()
    await store.recordDiagnosisObligation({ failureKey: 'writer:source-bound', writerRevision: 0, planDigest: 'b'.repeat(64), sourceFingerprint: trigger.sourceFingerprint })
    const output: DiagnosisOutput = { summary: 'Require a fresh plan', observations: [], recommendation: 'REPLAN', repairConstraints: ['Preserve existing changes'], unresolvedQuestions: [] }
    await expect(store.completeDiagnosis('writer:source-bound', output, 'c'.repeat(64))).rejects.toThrow(/source|fingerprint|mismatch/i)
    expect((await store.read()).diagnoses).toEqual([expect.objectContaining({ status: 'PENDING' })])
    await expect(repository.assertDispatchAdmission('adaptive')).rejects.toThrow(/diagnos|pending|obligation/i)
  })

  it.each(['missing', 'torn', 'identity'] as const)('does not reset escalation consumption from %s scheduling history', async corrupt => {
    const { root } = await fixture()
    const store = new TaskSchedulingRepository(root, 'adaptive', 'development', { maxEscalations: 1 })
    await store.initializeNew()
    await store.reserveEscalation(trigger)
    const path = join(root, '.agent/tasks/adaptive/SCHEDULING.json')
    if (corrupt === 'missing') await rm(path)
    if (corrupt === 'torn') await writeFile(path, '{"schemaVersion":')
    if (corrupt === 'identity') {
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      await writeFile(path, `${JSON.stringify({ ...value, taskId: 'other-task' })}\n`)
    }
    const reopened = new TaskSchedulingRepository(root, 'adaptive', 'development', { maxEscalations: 1 })
    await expect(reopened.reserveEscalation({ ...trigger, failureKey: 'new-attempt' })).rejects.toThrow()
    await expect(reopened.initializeNew()).rejects.toThrow()
  })
})
