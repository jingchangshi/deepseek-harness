/** Supported-profile adapter for the fixed engineering evaluation registry. */

import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runEngineeringBenchmark, createProductionEngineeringBindings } from '../src/benchmark.ts'
import { createDirectEngineeringInvoker } from '../src/benchmark-direct.ts'
import { createEngineeringEvaluationCases, engineeringEvaluationOracle, engineeringFirstImplementationOracle, evaluationReviewTarget, prepareEngineeringEvaluationRepository } from '../src/evaluation-fixtures.ts'
import type { RoleExecutor } from '../src/automatic.ts'
import type { HarnessConfig } from '../src/config.ts'

/** Run all four strategies through this profile's actual child executor.
 * @param options - validated routes, immutable fixture selection, and profile-owned executor.
 * @returns sanitized summary and a standalone report file.
 */
export async function runProfileEngineeringEvaluation(options: {
  checkout: string
  deployment: HarnessConfig
  strongRouteId: string
  cheapRouteId: string
  caseId: string
  executeRole: RoleExecutor
}) {
  const cases = (await createEngineeringEvaluationCases(options.checkout)).filter(item => item.id === options.caseId)
  if (cases.length !== 1) throw new Error('Evaluation requires one registered immutable case')
  const initialized = new Set<string>()
  const failures = new Set<string>()
  const executeRole: RoleExecutor = async invocation => {
    if (!initialized.has(invocation.root)) {
      await prepareEngineeringEvaluationRepository(cases[0]!, invocation.root, options.checkout)
      initialized.add(invocation.root)
    }
    if (options.caseId === 'recovery-latch' && invocation.role === 'implementer' && !failures.has(invocation.root)) {
      failures.add(invocation.root)
      throw new Error('Deterministic fixture failure before implementation mutation')
    }
    return options.executeRole(invocation)
  }
  const verify = engineeringFirstImplementationOracle
  const direct = createDirectEngineeringInvoker({ deployment: options.deployment, executeRole, verify, reviewTarget: evaluationReviewTarget })
  const bound = createProductionEngineeringBindings({
    deployment: options.deployment, strongRouteId: options.strongRouteId, cheapRouteId: options.cheapRouteId,
    roleExecutorForCase: () => executeRole, direct, reviewTarget: evaluationReviewTarget,
    firstImplementationOracle: verify,
    verifySingle: async (testCase, root) => {
      const startedAt = new Date().toISOString()
      const passed = await verify(testCase, root)
      return { stage: 'VERIFICATION', startedAt, endedAt: new Date().toISOString(), outcome: passed ? 'SUCCESS' : 'FAILED', requestIds: [] }
    },
  })
  const report = await runEngineeringBenchmark({
    cases, strategies: [{ id: 'A_STRONG' }, { id: 'B_CHEAP' }, { id: 'C_FIXED' }, { id: 'D_ADAPTIVE' }],
    mode: 'LIVE_PROVIDER', oracle: engineeringEvaluationOracle,
    executor: {
      run: async (strategy, testCase, root, context) => {
        await prepareEngineeringEvaluationRepository(testCase, root, options.checkout)
        initialized.add(root)
        return bound.run(strategy, testCase, root, context)
      },
      report: (...args) => bound.report!(...args),
    },
    conditions: {
      toolchain: { node: process.versions.node },
      routes: Object.fromEntries(Object.entries(options.deployment.routes).map(([id, route]) => [id, { provider: route.provider, model: route.model, capabilityLevel: route.capabilityLevel }])),
      classificationPolicy: { workflow: options.deployment.workflow },
    },
  })
  const reportPath = join(tmpdir(), `dsh-engineering-comparison-${randomUUID()}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return { mode: report.mode, reportPath, results: report.results.map(({ strategy, status, usageReport }) => ({ strategy, status, totalTokens: usageReport === 'UNKNOWN' ? 'UNKNOWN' : usageReport.totalTokens })), aggregates: report.aggregates }
}
