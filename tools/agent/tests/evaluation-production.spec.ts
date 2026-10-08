/** Production evaluation bindings: real repository, lifecycle, and review persistence. */
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEngineeringEvaluationCases,
  engineeringEvaluationOracle,
  evaluationReviewTarget,
  prepareEngineeringEvaluationRepository,
} from '../src/evaluation-fixtures.ts'
import { EngineeringRoleFailure, recoverEngineeringTask, runEngineeringTask } from '../src/automatic.ts'
import { createDirectEngineeringInvoker } from '../src/benchmark-direct.ts'
import { createProductionEngineeringBindings } from '../src/benchmark.ts'
import { engineeringFirstImplementationOracle } from '../src/evaluation-fixtures.ts'
import { runEngineeringReview } from '../src/review-only.ts'
import { loadHarnessConfig } from '../src/config.ts'
import { TaskRepository } from '../src/repository.ts'
import type { RoleExecutor, RoleInvocation } from '../src/automatic.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function prepared(id: string) {
  const testCase = (await createEngineeringEvaluationCases(process.cwd())).find(item => item.id === id)
  if (testCase === undefined) throw new Error(`missing evaluation case ${id}`)
  const root = await mkdtemp(join(tmpdir(), `dsh-production-${id}-`)); roots.push(root)
  await testCase.run(root)
  await prepareEngineeringEvaluationRepository(testCase, root, process.cwd())
  for (const name of await readdir(join(process.cwd(), '.agent/config'))) {
    if (name !== 'project.yaml' && name.endsWith('.yaml')) await cp(join(process.cwd(), '.agent/config', name), join(root, '.agent/config', name))
  }
  return { testCase, root, deployment: await loadHarnessConfig(root, { env: {} }) }
}

function developmentExecutor(root: string, options: { failImplementer?: boolean } = {}): RoleExecutor {
  let failed = false
  return async (input: RoleInvocation): Promise<unknown> => {
    const control = input.executionControl
    if (control !== undefined) {
      const requestId = `evaluation-${control.invocationId}`
      await control.lifecycle.reserveProviderRequest(control.attemptId, requestId, { provider: input.route.provider, model: input.route.model, routeId: input.route.routeId, purpose: 'agent' })
      await control.lifecycle.settleProviderRequest(requestId, { startedAt: control.startedAt, endedAt: new Date().toISOString(), outcome: 'SUCCESS', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
    }
    switch (input.role) {
      case 'scout-primary':
      case 'scout-secondary': return { findings: ['answer.txt is the requested output'], hypotheses: [{ statement: 'Write the requested value', evidence: ['request'] }], unresolvedAssumptions: [] }
      case 'architect': return { problemStatement: 'Write answer.txt', hypotheses: ['A text file satisfies the request'], selectedApproach: 'Write 42', rejectedAlternatives: ['Skip the file'], invariants: ['Only answer.txt changes'], expectedComponents: ['answer.txt'], implementationScope: ['answer.txt'], falsificationTests: ['Check exact file content'], acceptanceGates: ['evaluation-oracle'], unresolvedAssumptions: [] }
      case 'challenger': return { decision: 'ACCEPT', summary: 'The source oracle checks the requested value.', findings: [] }
      case 'implementer':
        if (options.failImplementer && !failed) { failed = true; throw new EngineeringRoleFailure('injected first implementer failure') }
        input.markMutationStarted?.()
        await writeFile(join(root, 'answer.txt'), '42\n')
        return { summary: 'Wrote answer.txt' }
      case 'reviewer': return { decision: 'ACCEPT', summary: 'The implementation satisfies the pinned request.', findings: [] }
    }
  }
}

describe('production evaluation lifecycle bindings', () => {
  it('invokes a fresh direct implementer binding with durable provider usage', async () => {
    const { testCase, root, deployment } = await prepared('recovery-latch')
    const direct = createDirectEngineeringInvoker({ deployment, executeRole: developmentExecutor(root), verify: engineeringFirstImplementationOracle, reviewTarget: evaluationReviewTarget })
    const receipt = await direct.invoke({ routeId: 'worker', role: 'implementer', request: testCase.request, root, readOnly: false, testCase })
    expect(receipt).toMatchObject({ stage: 'SINGLE', outcome: 'SUCCESS' })
    expect(receipt.requestIds.length).toBeGreaterThan(0)
    expect(await engineeringEvaluationOracle(testCase, root, [])).toMatchObject({ accepted: true })
    const report = await direct.report?.('B_CHEAP', testCase, root, [receipt])
    expect(report?.usageReport).not.toBe('UNKNOWN')
    if (report?.usageReport === undefined) throw new Error('direct usage report missing')
    expect(report.usageReport.requests.length).toBeGreaterThan(0)
    expect(report.usageReport.counts.providerRequests).toBeGreaterThan(0)
  })

  it('runs D_ADAPTIVE through production bindings with one task and cumulative receipts', async () => {
    const { testCase, root, deployment } = await prepared('recovery-latch')
    const roleExecutorForCase = () => developmentExecutor(root, { failImplementer: true })
    const direct = createDirectEngineeringInvoker({ deployment, executeRole: developmentExecutor(root), verify: engineeringFirstImplementationOracle, reviewTarget: evaluationReviewTarget })
    const bindings = createProductionEngineeringBindings({
      deployment, strongRouteId: 'architecture', cheapRouteId: 'worker', roleExecutorForCase, direct,
      verifySingle: async () => ({ stage: 'VERIFICATION', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), outcome: 'SUCCESS', requestIds: [] }),
      firstImplementationOracle: engineeringFirstImplementationOracle, reviewTarget: evaluationReviewTarget,
    })
    const receipts = await bindings.run('D_ADAPTIVE', testCase, root, { seed: 0, repetition: 1 })
    expect(receipts.some(receipt => receipt.outcome === 'FAILED')).toBe(true)
    expect(receipts.some(receipt => receipt.outcome === 'SUCCESS')).toBe(true)
    const report = await bindings.report?.('D_ADAPTIVE', testCase, root, receipts, { seed: 0, repetition: 1 })
    expect(report?.usageReport).not.toBe('UNKNOWN')
    if (report?.usageReport === undefined) throw new Error('production usage report missing')
    expect(report.usageReport.counts.providerRequests).toBeGreaterThan(0)
    expect((await readdir(join(root, '.agent/tasks'), { withFileTypes: true })).filter(entry => entry.isDirectory())).toHaveLength(1)
  })


  it('runs the recovery production binding through a real repository and settles lifecycle usage', async () => {
    const { testCase, root, deployment } = await prepared('recovery-latch')
    const result = await runEngineeringTask({ root, deployment, request: testCase.request, executeRole: developmentExecutor(root) })
    expect(result.status).toBe('ACCEPTED')
    expect(await engineeringEvaluationOracle(testCase, root, [])).toMatchObject({ accepted: true })
    const task = await new TaskRepository(root).readState(result.taskId)
    expect(task.state).toBe('ACCEPTED')
    const lifecycle = await new TaskRepository(root).lifecycle(result.taskId, 'development', deployment.workflow.lifecycleBudget)
    const document = await lifecycle.read()
    expect(document.counts.logicalInvocations).toBeGreaterThan(0)
    expect(document.counts.modelAttempts).toBeGreaterThan(0)
    expect(document.counts.providerRequests).toBeGreaterThan(0)
    expect(document.counts.totalTokens).toBeGreaterThan(0)
  })

  it('reviews the pinned commit only after collecting real Git evidence and persists cited receipts', async () => {
    const { testCase, root, deployment } = await prepared('review-overflow')
    const result = await runEngineeringReview({
      root, deployment, target: evaluationReviewTarget(testCase), executeRole: async input => {
        if (input.role === 'scout-primary' || input.role === 'scout-secondary') {
          return { findings: ['add.mjs changes signed arithmetic'], hypotheses: [{ statement: 'The target commit introduces overflow', evidence: ['pinned diff'] }], unresolvedAssumptions: [] }
        }
        if (input.role !== 'reviewer') throw new Error(`unexpected review role ${input.role}`)
        const evidence = input.reviewEvidence
        if (evidence === undefined) throw new Error('review evidence owner missing')
        const page = await evidence.show({ path: 'add.mjs' }, input.signal)
        const diff = await evidence.diff({ path: 'add.mjs' }, input.signal)
        return {
          summary: 'The pinned addition wraps signed arithmetic.',
          findings: [{ severity: 'high', description: 'Signed overflow is introduced.', path: 'add.mjs', commit: evidence.snapshot.targetCommit, startLine: 2, endLine: 2, failureCondition: 'add(2147483647, 1) wraps to a negative signed integer', changeRelation: 'The commit adds signed 32-bit coercion to the addition result.', evidenceIds: [page.evidenceId, diff.evidenceId] }],
          inspectedEvidenceIds: [page.evidenceId, diff.evidenceId], unresolvedQuestions: [],
        }
      },
    })
    expect(result.status).toBe('REVIEW_COMPLETE')
    expect(result.findings[0]).toMatchObject({ path: 'add.mjs', commit: testCase.seedSha, startLine: 2, endLine: 2 })
    expect(result.evidence.length).toBeGreaterThanOrEqual(2)
    expect(new Set(result.evidence.map(receipt => receipt.id)).size).toBe(result.evidence.length)
    expect(result.evidence.every(receipt => receipt.snapshotId === result.snapshot.id)).toBe(true)
  })

  it('latches the first implementer failure and resumes the same task after recovery', async () => {
    const { testCase, root, deployment } = await prepared('recovery-latch')
    const first = await runEngineeringTask({ root, deployment, request: testCase.request, executeRole: developmentExecutor(root, { failImplementer: true }) })
    expect(first.status).toBe('BLOCKED')
    const repository = new TaskRepository(root)
    expect((await repository.readState(first.taskId)).state).toBe('BLOCKED')
    await expect(runEngineeringTask({ root, deployment, taskId: first.taskId, request: testCase.request, executeRole: developmentExecutor(root) })).resolves.toMatchObject({ status: 'BLOCKED' })
    const recovered = await recoverEngineeringTask(root, first.taskId, false)
    expect(recovered.state).toBe('REPLAN')
    const resumed = await runEngineeringTask({ root, deployment, taskId: first.taskId, request: testCase.request, executeRole: developmentExecutor(root) })
    expect(resumed.status).toBe('ACCEPTED')
    expect(await readFile(join(root, 'answer.txt'), 'utf8')).toBe('42\n')
    expect((await repository.readState(first.taskId)).revision).toBeGreaterThan(3)
  })
})
