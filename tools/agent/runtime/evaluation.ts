/** Supported-profile adapter for the fixed engineering evaluation registry. */

import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
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
  deploymentRoot: string
  roleTimeoutMs: number
  deployment: HarnessConfig
  strongRouteId: string
  cheapRouteId: string
  caseId: string
  signal?: AbortSignal
  executeRole: RoleExecutor
  /** Own the fixture parent Session until all strategy work and disposal finish. */
  withFixture: <T>(root: string, operation: () => Promise<T>) => Promise<T>
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
    const testCase = cases[0]!
    return options.executeRole({ ...invocation, context: { ...invocation.context,
      benchmark: { caseId: testCase.id, kind: testCase.kind, criteria: testCase.criteria, allowedPaths: testCase.allowedPaths,
        commandProfile: testCase.commandProfile, failureInjection: testCase.failureInjection },
    } })
  }
  const verify = engineeringFirstImplementationOracle
  const direct = createDirectEngineeringInvoker({ deployment: options.deployment, executeRole, verify, reviewTarget: evaluationReviewTarget,
    ...(options.signal === undefined ? {} : { signal: options.signal }) })
  const bound = createProductionEngineeringBindings({
    deployment: options.deployment, strongRouteId: options.strongRouteId, cheapRouteId: options.cheapRouteId,
    roleExecutorForCase: () => executeRole, direct, reviewTarget: evaluationReviewTarget,
    firstImplementationOracle: verify,
    verifySingle: (testCase, root) => direct.invokeFixedStage({ stage: 'VERIFICATION', request: testCase.request, root, readOnly: true, testCase }),
  })
  const roles = Object.fromEntries(await Promise.all(Object.entries(options.deployment.roles).map(async ([id, role]) => {
    const personaSha256 = createHash('sha256').update(await readFile(resolve(options.deploymentRoot, role.personaFile))).digest('hex')
    const reviewPersonaSha256 = role.reviewPersonaFile === undefined ? undefined
      : createHash('sha256').update(await readFile(resolve(options.deploymentRoot, role.reviewPersonaFile))).digest('hex')
    return [id, { route: role.route, reasoningEffort: role.reasoningEffort, routeReasoningEfforts: role.routeReasoningEfforts,
      maxTokens: role.maxTokens, personaSha256, ...(reviewPersonaSha256 === undefined ? {} : { reviewPersonaSha256 }) }]
  })))
  const freezeManifestSha256 = createHash('sha256').update(await readFile(join(options.deploymentRoot, '.agent/FREEZE.json'))).digest('hex')
  const report = await runEngineeringBenchmark({
    cases, strategies: [{ id: 'A_STRONG' }, { id: 'B_CHEAP' }, { id: 'C_FIXED' }, { id: 'D_ADAPTIVE' }],
    mode: 'LIVE_PROVIDER', oracle: engineeringEvaluationOracle,
    executor: {
      run: async (strategy, testCase, root, context) => {
        await prepareEngineeringEvaluationRepository(testCase, root, options.checkout)
        initialized.add(root)
        return options.withFixture(root, () => bound.run(strategy, testCase, root, context))
      },
      report: (...args) => bound.report!(...args),
    },
    conditions: {
      toolchain: { node: process.versions.node },
      routes: Object.fromEntries(Object.entries(options.deployment.routes).map(([id, route]) => [id, { provider: route.provider, model: route.model, capabilityLevel: route.capabilityLevel, reasoningEfforts: route.reasoningEfforts }])),
      deploymentSnapshot: { roles, runtime: { roleTimeoutMs: options.roleTimeoutMs }, freezeManifestSha256 },
      classificationPolicy: { workflow: options.deployment.workflow },
    },
  })
  const reportPath = join(tmpdir(), `dsh-engineering-comparison-${randomUUID()}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return { mode: report.mode, reportPath, results: report.results.map(({ strategy, status, usageReport }) => ({ strategy, status, totalTokens: usageReport === 'UNKNOWN' ? 'UNKNOWN' : usageReport.totalTokens })), aggregates: report.aggregates }
}
