/** Reproducible engineering evaluations with oracle-owned acceptance. */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEngineeringTask, recoverEngineeringTask, getEngineeringStatus, type RoleExecutor } from './automatic.ts'
import type { HarnessConfig } from './config.ts'
import { runEngineeringReview } from './review-only.ts'
import type { GitReviewTarget } from './git-evidence.ts'
import type { TaskUsageReport } from './usage.ts'
import { TaskRepository } from './repository.ts'
import { RoleQuiescenceError } from './role-execution.ts'

/** Strategies supported by the evaluation harness. */
export type EngineeringStrategyId = 'A_STRONG' | 'B_CHEAP' | 'C_FIXED' | 'D_ADAPTIVE'

/** One role receipt; request IDs may be empty for offline scripted runs. */
export interface EngineeringStageReceipt {
  stage: 'SCOUT' | 'ARCHITECT' | 'CHALLENGER' | 'IMPLEMENTER' | 'VERIFICATION' | 'REVIEWER' | 'SINGLE' | 'UNKNOWN'
  startedAt: string
  endedAt: string
  outcome: 'SUCCESS' | 'FAILED' | 'UNKNOWN'
  requestIds: string[]
}

/** Fixture data required by a strategy executor. */
export interface EngineeringBenchmarkCase {
  id: string
  request: string
  criteria: string
  seedSha: string
  sourceDigest: string
  requestDigest: string
  criteriaDigest: string
  kind: 'compiler' | 'mlir' | 'review' | 'recovery'
  allowedPaths: readonly string[]
  commandProfile: string
  failureInjection?: unknown
  [key: string]: unknown
  run(cwd: string, context?: EngineeringBenchmarkRunContext): Promise<void>
}

/** Reproducibility identity supplied to every strategy repetition. */
export interface EngineeringBenchmarkRunContext {
  seed: number
  repetition: number
  routeSnapshot?: unknown
  deploymentSnapshot?: unknown
  classificationPolicy?: unknown
  toolchain?: unknown
}

/** Executor implementation; it cannot declare oracle acceptance. */
export interface EngineeringBenchmarkExecutor {
  /** Execute a strategy in the isolated fixture checkout.
   * @param strategy - configured comparison strategy. @param testCase - immutable fixture metadata. @param cwd - isolated fixture checkout.
   * @returns settled stage receipts.
   */
  run(strategy: EngineeringStrategyId, testCase: EngineeringBenchmarkCase, cwd: string, context?: EngineeringBenchmarkRunContext): Promise<EngineeringStageReceipt[]>
  /** Return durable usage and intervention observations when the runner records them.
   * @param strategy - configured comparison strategy. @param testCase - immutable fixture metadata.
   * @param cwd - isolated fixture checkout. @param receipts - stages returned by `run`.
   * @returns durable evidence, or no report when the runner cannot observe it.
   */
  report?(strategy: EngineeringStrategyId, testCase: EngineeringBenchmarkCase, cwd: string, receipts: readonly EngineeringStageReceipt[], context?: EngineeringBenchmarkRunContext): Promise<EngineeringRunEvidence>
}

/** Durable measurements and receipts associated with one strategy run. */
export interface EngineeringRunEvidence {
  usageReport?: TaskUsageReport
  firstImplementationPass?: boolean | 'UNKNOWN'
  fallbackCount?: number
  escalationCount?: number
  humanInterventionCount?: number
  workflowStatus?: 'ACCEPTED' | 'REVIEW_COMPLETE' | 'BLOCKED' | 'PARTIAL' | 'BUDGET_EXHAUSTED' | 'UNCERTAIN'
  confirmedStopped: boolean
}

/** Independent acceptance result for one case. */
export interface EngineeringOracleResult {
  accepted: boolean
  evidence: unknown
}

/** Persisted observations for one strategy and fixture. */
export interface EngineeringBenchmarkResult {
  caseId: string
  caseKind: EngineeringBenchmarkCase['kind']
  seed: number
  repetition: number
  strategy: EngineeringStrategyId
  status: 'ACCEPTED' | 'REJECTED' | 'BLOCKED' | 'BUDGET_EXHAUSTED' | 'UNCERTAIN' | 'NOT_RUN'
  firstImplementationPass: boolean | 'UNKNOWN'
  wallTimeMs: number | 'UNKNOWN'
  usageReport: TaskUsageReport | 'UNKNOWN'
  providerFailureRate: { knownFailures: number; knownDispatched: number; unknownDispatchCount: number } | 'UNKNOWN'
  fallbackCount: number | 'UNKNOWN'
  escalationCount: number | 'UNKNOWN'
  humanInterventionCount: number | 'UNKNOWN'
  oracle: EngineeringOracleResult | { accepted: false; evidence: { error: string } } | 'UNKNOWN'
  fixturePath?: string
}

/** Comparison report; offline results are synthetic and never imply provider savings. */
export interface EngineeringBenchmarkReport {
  mode: 'OFFLINE_SYNTHETIC' | 'LIVE_PROVIDER'
  conditions: Record<string, unknown>
  caseDigest: string
  strategies: EngineeringStrategyId[]
  results: EngineeringBenchmarkResult[]
  evidenceStatus: 'VERIFIED' | 'UNKNOWN'
  aggregates: {
    comparisonStatus: 'COMPLETE' | 'UNKNOWN'
    tokensPerSuccess: 'UNKNOWN'
    costPerSuccess: 'UNKNOWN'
    byStrategy: Record<EngineeringStrategyId, {
      acceptedCount: number
      rejectedCount: number
      acceptanceUnknownCount: number
      acceptanceKnownCount: number
      acceptanceDenominator: number
      firstPassCount: number
      firstPassFailureCount: number
      firstPassUnknownCount: number
      firstPassDenominator: number
      tokensPerSuccess: number | 'UNKNOWN'
      estimatedCostUsdPerSuccess: number | 'UNKNOWN'
      evidenceStatus: 'VERIFIED' | 'UNKNOWN'
    }>
  }
}

/**
 * Run every requested strategy against each immutable fixture, then apply the caller-owned oracle.
 * Fixture identity is checked before execution, each strategy gets a fresh temporary checkout,
 * and incomplete usage or intervention evidence remains UNKNOWN.
 * @param options - cases, strategy executor, independent oracle and optional clock.
 * @returns per-run outcomes and only those aggregate metrics supported by complete evidence.
 */
export async function runEngineeringBenchmark(options: {
  cases: readonly EngineeringBenchmarkCase[]
  strategies: readonly { id: EngineeringStrategyId }[]
  mode: 'OFFLINE_SYNTHETIC' | 'LIVE_PROVIDER'
  executor: EngineeringBenchmarkExecutor
  oracle(testCase: EngineeringBenchmarkCase, cwd: string, receipts: readonly EngineeringStageReceipt[]): Promise<EngineeringOracleResult>
  seed?: number
  repetitions?: number
  conditions?: {
    routes?: unknown
    routeSnapshot?: unknown
    deploymentSnapshot?: unknown
    classificationPolicy?: unknown
    toolchain?: unknown
  }
  now?: () => number
}): Promise<EngineeringBenchmarkReport> {
  const now = options.now ?? Date.now
  const seed = options.seed ?? 0
  const repetitions = options.repetitions ?? 1
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('benchmark seed must be a non-negative safe integer')
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error('benchmark repetitions must be a positive safe integer')
  const results: EngineeringBenchmarkResult[] = []
  for (const testCase of options.cases) {
    for (const { id } of options.strategies) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const runRoot = await benchmarkTempRoot(testCase.id)
      const runContext: EngineeringBenchmarkRunContext = { seed, repetition, ...options.conditions }
      let evidence: EngineeringRunEvidence = { confirmedStopped: false }
      try {
      const started = now()
      let receipts: EngineeringStageReceipt[] = []
      let oracle: EngineeringBenchmarkResult['oracle'] = 'UNKNOWN'
      let status: EngineeringBenchmarkResult['status'] = 'BLOCKED'
      let fixtureReady = false
      let executionStarted = false
      let executorSettled = false
      try {
        await testCase.run(runRoot, runContext)
        await assertFixtureIdentity(testCase, runRoot)
        fixtureReady = true
        executionStarted = true
        receipts = await options.executor.run(id, testCase, runRoot, runContext)
        executorSettled = true
        evidence = await options.executor.report?.(id, testCase, runRoot, receipts, runContext) ?? { confirmedStopped: true }
        oracle = await options.oracle(testCase, runRoot, receipts)
        status = classifyOutcome(oracle, receipts, evidence)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        oracle = { accepted: false, evidence: { error: message } }
        const reported = await options.executor.report?.(id, testCase, runRoot, receipts, runContext).catch(() => undefined)
        evidence = reported ?? { confirmedStopped: !executionStarted || executorSettled && !(error instanceof RoleQuiescenceError) }
        status = error instanceof RoleQuiescenceError ? 'UNCERTAIN' : /budget/i.test(message) ? 'BUDGET_EXHAUSTED' : 'BLOCKED'
      }
      const elapsed = now() - started
      const usageReport = evidence.usageReport
      results.push({
        caseId: testCase.id, caseKind: testCase.kind, strategy: id, status, seed, repetition,
        firstImplementationPass: fixtureReady ? evidence.firstImplementationPass ?? 'UNKNOWN' : 'UNKNOWN',
        wallTimeMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 'UNKNOWN',
        usageReport: usageReport ?? 'UNKNOWN',
        providerFailureRate: usageReport?.providerFailures ?? 'UNKNOWN',
        fallbackCount: evidence.fallbackCount ?? 'UNKNOWN', escalationCount: evidence.escalationCount ?? 'UNKNOWN',
        humanInterventionCount: evidence.humanInterventionCount ?? 'UNKNOWN', oracle,
        ...(evidence.confirmedStopped ? {} : { fixturePath: runRoot }),
      })
      } finally {
        if (evidence.confirmedStopped) await removeBenchmarkTempRoot(runRoot)
      }
      }
    }
  }
  const expected = options.cases.length * options.strategies.length * repetitions
  const uniqueStrategies = [...new Set(options.strategies.map(strategy => strategy.id))]
  const uniqueCases = new Set(options.cases.map(testCase => testCase.id))
  const completeComparison = options.cases.length > 0 && uniqueCases.size === options.cases.length && uniqueStrategies.length === 4
    && uniqueStrategies.every(strategy => options.strategies.some(item => item.id === strategy))
    && results.length === options.cases.length * 4 * repetitions
  const byStrategy = Object.fromEntries((['A_STRONG', 'B_CHEAP', 'C_FIXED', 'D_ADAPTIVE'] as const).map(strategy => {
    const selected = results.filter(result => result.strategy === strategy)
    const acceptedRuns = selected.filter(result => result.status === 'ACCEPTED')
    const usage = acceptedRuns.map(result => result.usageReport)
    const tokens = acceptedRuns.length > 0 && usage.every(report => report !== 'UNKNOWN' && report.totalTokens.status === 'KNOWN')
      ? usage.reduce((sum, report) => sum + (report === 'UNKNOWN' ? 0 : report.totalTokens.knownSubtotal), 0) / acceptedRuns.length
      : 'UNKNOWN'
    const costs = acceptedRuns.length > 0 && usage.every(report => report !== 'UNKNOWN' && report.estimatedCostUsd.status === 'KNOWN')
      ? usage.reduce((sum, report) => sum + (report === 'UNKNOWN' ? 0 : report.estimatedCostUsd.knownSubtotal), 0) / acceptedRuns.length
      : 'UNKNOWN'
    const firstPassKnown = selected.filter(result => result.firstImplementationPass !== 'UNKNOWN')
    return [strategy, {
      acceptedCount: acceptedRuns.length,
      rejectedCount: selected.filter(result => result.status === 'REJECTED').length,
      acceptanceUnknownCount: selected.filter(result => !['ACCEPTED', 'REJECTED'].includes(result.status)).length,
      acceptanceKnownCount: selected.filter(result => ['ACCEPTED', 'REJECTED'].includes(result.status)).length,
      acceptanceDenominator: selected.length,
      firstPassCount: firstPassKnown.filter(result => result.caseKind !== 'review' && result.firstImplementationPass === true).length,
      firstPassFailureCount: firstPassKnown.filter(result => result.caseKind !== 'review' && result.firstImplementationPass === false).length,
      firstPassUnknownCount: selected.filter(result => result.caseKind !== 'review' && result.firstImplementationPass === 'UNKNOWN').length,
      firstPassDenominator: selected.filter(result => result.caseKind !== 'review').length,
      tokensPerSuccess: tokens,
      estimatedCostUsdPerSuccess: costs,
      evidenceStatus: options.mode === 'LIVE_PROVIDER' && selected.some(result => hasActualDispatch(result.usageReport)) ? 'VERIFIED' as const : 'UNKNOWN' as const,
    }]
  })) as EngineeringBenchmarkReport['aggregates']['byStrategy']
  const liveEvidence = options.mode === 'LIVE_PROVIDER' && results.some(result => hasActualDispatch(result.usageReport))
  return {
    mode: options.mode,
    conditions: { ...options.conditions, seed, repetitions, evidence: options.mode === 'OFFLINE_SYNTHETIC' ? 'scripted roles; measured usage is synthetic' : 'provider evidence requires durable dispatched usage', failureInjection: 'same case manifest passed to every strategy' },
    caseDigest: createHash('sha256').update(JSON.stringify({ cases: options.cases.map(testCase => ({ id: testCase.id, seedSha: testCase.seedSha, sourceDigest: testCase.sourceDigest, requestDigest: testCase.requestDigest, criteriaDigest: testCase.criteriaDigest, failureInjection: testCase.failureInjection, toolchain: testCase.pinnedMlir })), conditions: options.conditions, seed, repetitions })).digest('hex'),
    strategies: options.strategies.map(strategy => strategy.id), results,
    evidenceStatus: options.mode === 'LIVE_PROVIDER' && !liveEvidence ? 'UNKNOWN' : liveEvidence ? 'VERIFIED' : 'UNKNOWN',
    aggregates: { comparisonStatus: completeComparison && expected === results.length ? 'COMPLETE' : 'UNKNOWN', tokensPerSuccess: 'UNKNOWN', costPerSuccess: 'UNKNOWN', byStrategy },
  }
}

/** Run registered fixtures with the repository-owned oracle registry.
 * @param options - benchmark inputs excluding oracle ownership.
 * @returns the reproducibility and result report from the immutable registry.
 */
export async function runRegisteredEngineeringBenchmark(options: Omit<Parameters<typeof runEngineeringBenchmark>[0], 'oracle'>): Promise<EngineeringBenchmarkReport> {
  const { engineeringEvaluationOracle } = await import('./evaluation-fixtures.ts')
  return runEngineeringBenchmark({ ...options, oracle: engineeringEvaluationOracle })
}

function hasActualDispatch(report: TaskUsageReport | 'UNKNOWN'): boolean {
  return report !== 'UNKNOWN' && report.requests.some(request => request.dispatchStatus === 'DISPATCHED'
    && request.rawUsage !== undefined
    && [request.rawUsage.inputTokens, request.rawUsage.outputTokens, request.rawUsage.totalTokens ?? 0].some(value => value > 0))
}

function classifyOutcome(oracle: EngineeringOracleResult, receipts: readonly EngineeringStageReceipt[], evidence: EngineeringRunEvidence): EngineeringBenchmarkResult['status'] {
  if (evidence.workflowStatus === 'BUDGET_EXHAUSTED') return 'BUDGET_EXHAUSTED'
  if (evidence.workflowStatus === 'UNCERTAIN' || !evidence.confirmedStopped) return 'UNCERTAIN'
  if (evidence.workflowStatus === 'BLOCKED' || evidence.workflowStatus === 'PARTIAL') return 'BLOCKED'
  const terminalSuccess = evidence.workflowStatus === 'ACCEPTED' || evidence.workflowStatus === 'REVIEW_COMPLETE'
  if (evidence.workflowStatus !== undefined && !terminalSuccess) return 'BLOCKED'
  if (!terminalSuccess && receipts.some(receipt => receipt.outcome === 'FAILED')) return 'REJECTED'
  return oracle.accepted ? 'ACCEPTED' : 'REJECTED'
}

async function assertFixtureIdentity(testCase: EngineeringBenchmarkCase, root: string): Promise<void> {
  const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const actualSource = await sourceDigest(root)
  const actualRequest = createHash('sha256').update(testCase.request).digest('hex')
  const actualCriteria = createHash('sha256').update(testCase.criteria).digest('hex')
  if (actualSha !== testCase.seedSha || actualSource !== testCase.sourceDigest || actualRequest !== testCase.requestDigest || actualCriteria !== testCase.criteriaDigest) {
    throw new Error(`fixture ${testCase.id} identity differs from its recorded seed or request manifest`)
  }
}

async function sourceDigest(root: string): Promise<string> {
  const paths: string[] = []
  const visit = async (directory: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(directory, path)
      else paths.push(path)
    }
  }
  await visit(root)
  const entries = await Promise.all(paths.sort().map(async path => `${path}\0${createHash('sha256').update(await readFile(join(root, path), 'utf8')).digest('hex')}`))
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

async function benchmarkTempRoot(caseId: string): Promise<string> {
  const prefix = `dsh-benchmark-${createHash('sha256').update(caseId).digest('hex').slice(0, 12)}-`
  return mkdtemp(join(tmpdir(), prefix))
}

async function removeBenchmarkTempRoot(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/** One route-bound single role invocation supplied by the production role executor. */
export interface ProductionBenchmarkRoleInvoker {
  /** Run one route-bound role invocation.
   * @param input - role, immutable route, request, case failure injection and isolated checkout.
   * @returns settled role receipt.
   */
  invoke(input: { routeId: string; role: 'implementer' | 'reviewer'; request: string; root: string; readOnly: boolean; testCase: EngineeringBenchmarkCase }): Promise<EngineeringStageReceipt>
  /** Run one fixed role stage.
   * @param input - fixed stage, request, case failure injection and isolated checkout.
   * @returns settled stage receipt.
   */
  invokeFixedStage(input: { stage: 'SCOUT' | 'ARCHITECT' | 'CHALLENGER' | 'IMPLEMENTER' | 'VERIFICATION' | 'REVIEWER'; request: string; root: string; readOnly: boolean; testCase: EngineeringBenchmarkCase }): Promise<EngineeringStageReceipt>
  /** Read actual lifecycle evidence for direct A/B/C role and verifier calls when available.
   * @param strategy - strategy whose calls produced the receipts. @param testCase - immutable fixture metadata.
   * @param cwd - isolated fixture checkout. @param receipts - actual settled calls.
   * @returns durable measurements and stop confirmation.
   */
  report?(strategy: EngineeringStrategyId, testCase: EngineeringBenchmarkCase, cwd: string, receipts: readonly EngineeringStageReceipt[], context?: EngineeringBenchmarkRunContext): Promise<EngineeringRunEvidence>
}

/**
 * Bind route IDs for A/B, fixed role stages for C, and production task/review workflows for D.
 * A/B and C invoke the provided runtime adapters; this factory does not create those adapters.
 * @param options - deployment, explicit routes, runtime role adapters and pinned review target resolver.
 * @returns strategy executor for use with {@link runEngineeringBenchmark}.
 */
export function createProductionEngineeringBindings(options: {
  deployment: HarnessConfig
  strongRouteId: string
  cheapRouteId: string
  roleExecutorForCase(testCase: EngineeringBenchmarkCase): RoleExecutor
  direct: ProductionBenchmarkRoleInvoker
  verifySingle(testCase: EngineeringBenchmarkCase, root: string): Promise<EngineeringStageReceipt>
  firstImplementationOracle(testCase: EngineeringBenchmarkCase, root: string): Promise<boolean>
  reviewTarget(testCase: EngineeringBenchmarkCase): GitReviewTarget
}): EngineeringBenchmarkExecutor {
  const durableRuns = new Map<string, EngineeringRunEvidence & { taskId: string; workflow: 'development' | 'review-only' }>()
  const directFirstPass = new Map<string, boolean | 'UNKNOWN'>()
  for (const routeId of [options.strongRouteId, options.cheapRouteId]) {
    if (options.deployment.routes[routeId] === undefined) throw new Error(`unknown benchmark route: ${routeId}`)
  }
  return {
    async run(strategy, testCase, cwd, _context) {
      const review = testCase.kind === 'review'
      if (strategy === 'A_STRONG' || strategy === 'B_CHEAP') {
        const routeId = strategy === 'A_STRONG' ? options.strongRouteId : options.cheapRouteId
        const invocation = await options.direct.invoke({ routeId, role: review ? 'reviewer' : 'implementer', request: testCase.request, root: cwd, readOnly: review, testCase })
        if (review) return [invocation]
        directFirstPass.set(cwd, await options.firstImplementationOracle(testCase, cwd).catch(() => 'UNKNOWN'))
        const verification = await options.verifySingle(testCase, cwd)
        return [invocation, verification]
      }
      if (strategy === 'C_FIXED') {
        const stages = review ? ['SCOUT', 'ARCHITECT', 'CHALLENGER', 'VERIFICATION', 'REVIEWER'] as const : ['SCOUT', 'ARCHITECT', 'CHALLENGER', 'IMPLEMENTER', 'VERIFICATION', 'REVIEWER'] as const
        const receipts: EngineeringStageReceipt[] = []
        for (const stage of stages) {
          receipts.push(await options.direct.invokeFixedStage({ stage, request: testCase.request, root: cwd, readOnly: review || stage !== 'IMPLEMENTER', testCase }))
          if (!review && stage === 'IMPLEMENTER') directFirstPass.set(cwd, await options.firstImplementationOracle(testCase, cwd).catch(() => 'UNKNOWN'))
          if (receipts.at(-1)?.outcome !== 'SUCCESS') break
        }
        return receipts
      }
      const roleReceipts: EngineeringStageReceipt[] = []
      let confirmedStopped = true
      let firstPass: boolean | 'UNKNOWN' = 'UNKNOWN'
      let checkedFirstImplementation = false
      const productionRoleExecutor = options.roleExecutorForCase(testCase)
      const tracedExecutor: RoleExecutor = async invocation => {
        const startedAt = new Date().toISOString()
        try {
          const output = await productionRoleExecutor(invocation)
          roleReceipts.push({ stage: stageForRole(invocation.role), startedAt, endedAt: new Date().toISOString(), outcome: 'SUCCESS', requestIds: [] })
          if (!checkedFirstImplementation && invocation.role === 'implementer') {
            checkedFirstImplementation = true
            firstPass = await options.firstImplementationOracle(testCase, cwd).catch(() => 'UNKNOWN')
          }
          return output
        } catch (error) {
          if (error instanceof RoleQuiescenceError) confirmedStopped = false
          if (!checkedFirstImplementation && invocation.role === 'implementer') {
            checkedFirstImplementation = true
            firstPass = await options.firstImplementationOracle(testCase, cwd).catch(() => 'UNKNOWN')
          }
          roleReceipts.push({ stage: stageForRole(invocation.role), startedAt, endedAt: new Date().toISOString(), outcome: 'FAILED', requestIds: [] })
          throw error
        }
      }
      if (review) {
        const result = await runEngineeringReview({ root: cwd, deployment: options.deployment, target: options.reviewTarget(testCase), executeRole: tracedExecutor })
        confirmedStopped = confirmedStopped && !result.state.requiresStopConfirmation
        durableRuns.set(cwd, {
          taskId: result.taskId, workflow: 'review-only', confirmedStopped,
          workflowStatus: result.status === 'REVIEW_COMPLETE' ? 'REVIEW_COMPLETE' : result.status === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXHAUSTED' : result.status === 'PARTIAL' || result.status === 'BLOCKED' ? 'BLOCKED' : 'UNCERTAIN',
        })
        return roleReceipts
      }
      const runTask = () => runEngineeringTask({ root: cwd, deployment: options.deployment, request: testCase.request, executeRole: tracedExecutor })
      let result: Awaited<ReturnType<typeof runEngineeringTask>>
      try {
        result = await runTask()
      } catch (error) {
        const tasks = (await getEngineeringStatus(cwd)).tasks
        const taskId = tasks.length === 1 ? tasks[0]!.task.id : undefined
        if (taskId !== undefined) durableRuns.set(cwd, { taskId, workflow: 'development', confirmedStopped, firstImplementationPass: firstPass, workflowStatus: confirmedStopped ? 'BLOCKED' : 'UNCERTAIN' })
        if (testCase.id !== 'recovery-latch' || !confirmedStopped || taskId === undefined) throw error
        await recoverEngineeringTask(cwd, taskId, true)
        result = await runEngineeringTask({ root: cwd, deployment: options.deployment, taskId, request: '', executeRole: tracedExecutor })
      }
      confirmedStopped = confirmedStopped && !result.requiresStopConfirmation
      durableRuns.set(cwd, {
        taskId: result.taskId, workflow: 'development', confirmedStopped,
        firstImplementationPass: firstPass,
        workflowStatus: result.status === 'ACCEPTED' ? 'ACCEPTED' : result.status === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXHAUSTED' : result.status === 'BLOCKED' ? 'BLOCKED' : 'UNCERTAIN',
      })
      return roleReceipts
    },
    async report(strategy, testCase, cwd, receipts, context) {
      const run = durableRuns.get(cwd)
      if (run === undefined) return { ...(await options.direct.report?.(strategy, testCase, cwd, receipts, context) ?? { confirmedStopped: true }), firstImplementationPass: directFirstPass.get(cwd) ?? 'UNKNOWN' }
      const repository = new TaskRepository(cwd)
      const lifecycle = await repository.lifecycle(run.taskId, run.workflow, options.deployment.workflow.lifecycleBudget)
      const usageReport = await lifecycle.usageReport()
      const attempts = await routeAttemptRecords(cwd, run.taskId, run.workflow, usageReport)
      return {
        ...run, usageReport,
        ...(attempts === undefined ? {} : { fallbackCount: attempts.filter(attempt => attempt.mode === 'FALLBACK').length,
          escalationCount: attempts.filter(attempt => attempt.mode === 'ESCALATE').length }),
      }
    },
  }
}

async function routeAttemptRecords(root: string, taskId: string, workflow: 'development' | 'review-only', usageReport: TaskUsageReport): Promise<Array<{ mode: string }> | undefined> {
  const directory = join(root, '.agent', workflow === 'development' ? 'tasks' : 'reviews', taskId)
  const names = await readdir(directory)
  const files = names.filter(name => /^ROUTE_ATTEMPTS\..+\.jsonl$/u.test(name))
  if (files.length === 0) return undefined
  const records: Array<{ mode: string }> = []
  const expected = new Map<string, number>()
  if (usageReport.unattributedHistory || usageReport.attempts.length !== usageReport.counts.physicalAttempts) return undefined
  for (const attempt of usageReport.attempts) {
    if (attempt.startedAt === undefined || attempt.endedAt === undefined) return undefined
    const identity = JSON.stringify([attempt.role, attempt.provider, attempt.model, attempt.routeId, attempt.startedAt, attempt.endedAt])
    expected.set(identity, (expected.get(identity) ?? 0) + 1)
  }
  for (const name of files) {
    const content = await readFile(join(directory, name), 'utf8')
    for (const line of content.split('\n')) {
      if (line.trim() === '') continue
      let value: unknown
      try { value = JSON.parse(line) }
      catch (error) { return undefined } // An incomplete audit cannot establish route counts.
      if (typeof value !== 'object' || value === null || !('mode' in value) || typeof value.mode !== 'string' || !['PRIMARY', 'FALLBACK', 'ESCALATE'].includes(value.mode)) return undefined
      const fields = ['role', 'provider', 'model', 'routeId', 'startedAt', 'endedAt'].map(field => Reflect.get(value, field))
      if (!fields.every(field => typeof field === 'string')) return undefined
      const identity = JSON.stringify(fields)
      const remaining = expected.get(identity) ?? 0
      if (remaining === 0) return undefined
      expected.set(identity, remaining - 1)
      records.push({ mode: value.mode })
    }
  }
  return [...expected.values()].every(count => count === 0) ? records : undefined
}

function stageForRole(role: string): EngineeringStageReceipt['stage'] {
  switch (role) {
    case 'scout-primary':
    case 'scout-secondary': return 'SCOUT'
    case 'architect': return 'ARCHITECT'
    case 'challenger': return 'CHALLENGER'
    case 'implementer': return 'IMPLEMENTER'
    case 'reviewer': return 'REVIEWER'
    default: return 'UNKNOWN'
  }
}
