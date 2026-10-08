import { cp, mkdtemp, readdir, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEngineeringEvaluationCases,
  prepareEngineeringEvaluationRepository,
  evaluationReviewTarget,
} from '../src/evaluation-fixtures.ts'
import { createDirectEngineeringInvoker } from '../src/benchmark-direct.ts'
import { createProductionEngineeringBindings } from '../src/benchmark.ts'
import { loadHarnessConfig } from '../src/config.ts'
import type { EngineeringStageReceipt } from '../src/benchmark.ts'
import type { RoleExecutor } from '../src/automatic.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function prepared(id: string) {
  const testCase = (await createEngineeringEvaluationCases(process.cwd())).find(item => item.id === id)
  if (testCase === undefined) throw new Error(`missing evaluation case ${id}`)
  const root = await mkdtemp(join(tmpdir(), `dsh-evaluation-acceptance-${id}-`))
  roots.push(root)
  await testCase.run(root)
  await prepareEngineeringEvaluationRepository(testCase, root, process.cwd())
  for (const name of await readdir(join(process.cwd(), '.agent/config'))) {
    if (name !== 'project.yaml' && name.endsWith('.yaml')) await cp(join(process.cwd(), '.agent/config', name), join(root, '.agent/config', name))
  }
  return { root, testCase, deployment: await loadHarnessConfig(root, { env: {} }) }
}

function receipt(stage: EngineeringStageReceipt['stage'], outcome: EngineeringStageReceipt['outcome'] = 'SUCCESS'): EngineeringStageReceipt {
  const now = new Date().toISOString()
  return { stage, startedAt: now, endedAt: now, outcome, requestIds: [] }
}

describe('independent acceptance review regressions', () => {
  it('rejects a direct Reviewer REPLAN result instead of reporting SUCCESS', async () => {
    const { root, testCase, deployment } = await prepared('recovery-latch')
    const calls: string[] = []
    const executor: RoleExecutor = async input => {
      calls.push(input.role)
      if (input.role === 'reviewer') return { summary: 'Reviewer requests replanning', decision: 'REPLAN', findings: [] }
      if (input.role === 'implementer') return { summary: 'writer must not run' }
      if (input.role === 'architect') return { problemStatement: 'write answer', hypotheses: ['one'], selectedApproach: 'write answer', rejectedAlternatives: ['skip'], invariants: ['answer only'], expectedComponents: ['answer.txt'], implementationScope: ['answer.txt'], falsificationTests: ['read answer'], acceptanceGates: ['oracle'], unresolvedAssumptions: [] }
      if (input.role === 'challenger') return { summary: 'accept', decision: 'ACCEPT', findings: [] }
      return { findings: ['answer'], hypotheses: [{ statement: 'one', evidence: ['source'] }], unresolvedAssumptions: [] }
    }
    const direct = createDirectEngineeringInvoker({
      deployment, executeRole: executor, verify: async () => true,
      reviewTarget: testCase => ({ kind: 'commit', target: testCase.seedSha }),
    })
    const result = await direct.invoke({ routeId: deployment.roles.reviewer!.route, role: 'reviewer', request: 'review', root, readOnly: true, testCase })
    expect(result.outcome).toBe('FAILED')
    expect(calls).toEqual(['reviewer'])
  })

  it('stops C_FIXED before the writer when Challenger returns REVISE', async () => {
    const { root, testCase, deployment } = await prepared('recovery-latch')
    const calls: string[] = []
    const roleExecutor: RoleExecutor = async input => {
      calls.push(input.role)
      if (input.role === 'challenger') return { summary: 'The plan needs revision.', decision: 'REVISE', findings: ['The acceptance test does not check the requested behavior.'] }
      if (input.role === 'implementer') { await import('node:fs/promises').then(fs => fs.writeFile(join(root, 'answer.txt'), '42\n')); return { summary: 'Wrote answer.' } }
      if (input.role === 'architect') return { problemStatement: 'Write answer.txt', hypotheses: ['A text file satisfies the request'], selectedApproach: 'Write 42', rejectedAlternatives: ['Skip the file'], invariants: ['Only answer.txt changes'], expectedComponents: ['answer.txt'], implementationScope: ['answer.txt'], falsificationTests: ['Check exact file content'], acceptanceGates: ['evaluation-oracle'], unresolvedAssumptions: [] }
      if (input.role === 'reviewer') return { decision: 'ACCEPT', summary: 'The implementation satisfies the request.', findings: [] }
      return { findings: ['answer.txt is the requested output'], hypotheses: [{ statement: 'Write the requested value', evidence: ['request'] }], unresolvedAssumptions: [] }
    }
    const direct = createDirectEngineeringInvoker({ deployment, executeRole: roleExecutor, verify: async () => true,
      reviewTarget: testCase => ({ kind: 'commit', target: testCase.seedSha }) })
    const executor = createProductionEngineeringBindings({
      deployment, strongRouteId: deployment.roles.architect!.route, cheapRouteId: deployment.roles['scout-secondary']!.route,
      roleExecutorForCase: () => roleExecutor, direct,
      firstImplementationOracle: async () => true, verifySingle: async () => receipt('VERIFICATION'),
      reviewTarget: testCase => evaluationReviewTarget(testCase),
    })
    await executor.run('C_FIXED', testCase, root)
    expect(calls).toEqual(['scout-primary', 'architect', 'challenger'])
  })

  it('reports UNKNOWN route-attempt counts when the durable audit is missing or truncated', async () => {
    const { root, testCase, deployment } = await prepared('recovery-latch')
    const roleExecutor: RoleExecutor = async input => {
      if (input.role === 'implementer') { await import('node:fs/promises').then(fs => fs.writeFile(join(root, 'answer.txt'), '42\n')); return { summary: 'write answer' } }
      if (input.role === 'architect') return { problemStatement: 'write answer', hypotheses: ['one'], selectedApproach: 'write answer', rejectedAlternatives: ['skip'], invariants: ['answer only'], expectedComponents: ['answer.txt'], implementationScope: ['answer.txt'], falsificationTests: ['read answer'], acceptanceGates: ['oracle'], unresolvedAssumptions: [] }
      if (input.role === 'challenger') return { summary: 'accept', decision: 'ACCEPT', findings: [] }
      if (input.role === 'reviewer') return { summary: 'accepted', decision: 'ACCEPT', findings: [] }
      return { findings: ['answer'], hypotheses: [{ statement: 'one', evidence: ['source'] }], unresolvedAssumptions: [] }
    }
    const direct = { invoke: async () => receipt('SINGLE'), invokeFixedStage: async (input: { stage: EngineeringStageReceipt['stage'] }) => receipt(input.stage), report: async () => ({ confirmedStopped: true }) }
    const executor = createProductionEngineeringBindings({
      deployment, strongRouteId: deployment.roles.architect!.route, cheapRouteId: deployment.roles['scout-secondary']!.route,
      roleExecutorForCase: () => roleExecutor, direct,
      firstImplementationOracle: async () => true, verifySingle: async () => receipt('VERIFICATION'),
      reviewTarget: testCase => evaluationReviewTarget(testCase),
    })
    const receipts = await executor.run('D_ADAPTIVE', testCase, root)
    const reportBefore = await executor.report?.('D_ADAPTIVE', testCase, root, receipts)
    expect(reportBefore?.usageReport).toBeDefined()
    expect(reportBefore?.fallbackCount).toBe(0)
    const taskId = (await readdir(join(root, '.agent/tasks')))[0]
    if (taskId === undefined) throw new Error('production binding did not persist its task')
    const implementationAudit = join(root, '.agent/tasks', taskId, 'ROUTE_ATTEMPTS.implementer.jsonl')
    await unlink(implementationAudit)
    const reportAfter = await executor.report?.('D_ADAPTIVE', testCase, root, receipts)
    expect(reportAfter?.fallbackCount).toBeUndefined()
  })
})
