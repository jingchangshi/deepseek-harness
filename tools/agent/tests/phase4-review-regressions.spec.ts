import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { dump, load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subagents from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'
import * as Runtime from '../runtime/index.ts'
import { getEngineeringStatus, recoverEngineeringTask, runEngineeringTask, type RoleInvocation } from '../src/automatic.ts'
import { createProductionEngineeringBindings, runEngineeringBenchmark, type EngineeringBenchmarkCase, type EngineeringStageReceipt } from '../src/benchmark.ts'
import { loadHarnessConfig, type ResolvedRoleRoute } from '../src/config.ts'
import { FileTaskLifecycle } from '../src/lifecycle.ts'
import { CapabilityInsufficientError, RoleQuiescenceError, runRoleAttempts } from '../src/role-execution.ts'

const roots: string[] = []
const start = '2026-10-08T00:00:00.000Z'
const end = '2026-10-08T00:00:00.100Z'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const receipt = (stage: EngineeringStageReceipt['stage']): EngineeringStageReceipt => ({ stage, startedAt: start, endedAt: end, outcome: 'SUCCESS', requestIds: [] })
const route: ResolvedRoleRoute = { role: 'reviewer', routeId: 'review-route', capabilityLevel: 0, provider: 'fixture', model: 'main', reasoningEffort: 'off', maxTokens: 1000, writable: false, externalRelay: false, costClass: 'standard' }

class ReconciliationAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return Promise.resolve({ provider, id: model, name: model }) }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose !== undefined) {
      const id = ToolCallId('reconciliation-output')
      const argumentsJson = JSON.stringify({ response: { status: 'escalate', reason: 'TASK_COMPLEXITY', details: 'Requires independent diagnosis', partial: { observations: [], unresolvedQuestions: [] } } })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'structured_output', argumentsDelta: argumentsJson }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'structured_output', arguments: argumentsJson } }
    }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }
    yield { type: 'finish', reason: { kind: options.purpose === undefined ? 'stop' : 'tool-calls' } }
  }
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-phase4-review-'))
  roots.push(root)
  return root
}

async function projectFixture() {
  const root = await temporaryRoot()
  await cp(resolve('.agent'), join(root, '.agent'), { recursive: true, filter: source => !source.includes(join('.agent', 'tasks')) && !source.includes(join('.agent', 'reviews')) })
  await writeFile(join(root, 'answer.txt'), '42\n')
  await writeFile(join(root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 20, maxRoleCalls: 20, commandTimeoutMs: 30_000, scheduling: { class: 'simple', scopePaths: ['answer.txt'], acceptanceCriteria: ['answer.txt contains 42'], risks: [], needsInvestigation: false, needsChallenge: false } }))
  await writeFile(join(root, '.agent/adapters/test.yaml'), dump({ adapters: Object.fromEntries(['unit', 'typecheck', 'build'].map(name => [name, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }])) }))
  const rolesPath = join(root, '.agent/config/roles.yaml')
  const roles = load(await readFile(rolesPath, 'utf8')) as { roles: Record<string, Record<string, unknown>> }
  for (const roleConfig of Object.values(roles.roles)) { roleConfig.escalationRoutes = []; roleConfig.escalationFallbackRoutes = [] }
  await writeFile(rolesPath, dump(roles))
  await execa('git', ['init', '-q'], { cwd: root })
  await execa('git', ['add', 'answer.txt'], { cwd: root })
  await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'review seed'], { cwd: root })
  return { root, deployment: await loadHarnessConfig(root, { env: {} }) }
}

async function benchmarkFixture(): Promise<EngineeringBenchmarkCase> {
  const root = await temporaryRoot()
  await writeFile(join(root, 'answer.txt'), '42\n')
  await execa('git', ['init', '-q'], { cwd: root })
  await execa('git', ['add', '.'], { cwd: root })
  await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'evaluation seed'], { cwd: root })
  const seedSha = (await execa('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout
  const request = 'Preserve answer.txt containing 42'
  const criteria = 'answer.txt is unchanged'
  return { id: 'review-regression', kind: 'recovery', request, criteria, seedSha, sourceDigest: sha(`answer.txt\0${sha('42\n')}`), requestDigest: sha(request), criteriaDigest: sha(criteria), allowedPaths: ['answer.txt'], commandProfile: 'independent', run: cwd => cp(root, cwd, { recursive: true }) }
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('Phase 4 independent review regressions', () => {
  it('returns an accepted task without reopening or rewriting its settled lifecycle', async () => {
    const options = await projectFixture()
    const executeRole = async (input: RoleInvocation) => input.role === 'implementer' ? { summary: 'Preserved requested source' } : { decision: 'ACCEPT', summary: 'Checked source', findings: [] }
    const first = await runEngineeringTask({ ...options, request: 'Preserve answer.txt containing 42', executeRole })
    expect(first.status).toBe('ACCEPTED')
    const path = join(options.root, '.agent/tasks', first.taskId, 'LIFECYCLE.json')
    const before = await readFile(path, 'utf8')
    const second = await runEngineeringTask({ ...options, taskId: first.taskId, request: '', executeRole: async () => { throw new Error('Terminal replay dispatched another role') } })
    expect(second.status).toBe('ACCEPTED')
    expect(await readFile(path, 'utf8')).toBe(before)
  }, 30_000)

  it.each(['capability', 'uncertain'] as const)('records %s as a semantic attempt result rather than an ordinary failure', async scenario => {
    const root = await temporaryRoot()
    await mkdir(join(root, '.agent/tasks/attribution'), { recursive: true })
    const lifecycle = new FileTaskLifecycle(root, 'attribution', 'development', {}, () => start, 0, false)
    await lifecycle.initialize()
    const invocationId = await lifecycle.reserveInvocation(route.role)
    const attemptId = await lifecycle.reserveAttempt(invocationId, route)
    const error = scenario === 'capability' ? new CapabilityInsufficientError('TASK_COMPLEXITY', 'Need stronger analysis', { observations: [], unresolvedQuestions: [] }) : new RoleQuiescenceError('Child stop remains uncertain')
    await expect(runRoleAttempts({ role: 'reviewer', attempts: [route], signal: new AbortController().signal, executeAttempt: async () => { throw error }, validateOutput: value => value, persistAttempts: async records => {
      for (const record of records) await lifecycle.settleAttempt(attemptId, { startedAt: record.startedAt, endedAt: record.endedAt, outcome: record.semanticOutcome ?? record.outcome })
    } })).rejects.toBeInstanceOf(scenario === 'capability' ? CapabilityInsufficientError : RoleQuiescenceError)
    expect((await lifecycle.usageReport()).attempts[0]?.outcome).toBe(scenario === 'capability' ? 'CAPABILITY_INSUFFICIENT' : 'UNCERTAIN')
  })

  it('resumes after explicit recovery when interruption left a lifecycle run active', async () => {
    const options = await projectFixture()
    let taskId = ''
    await expect(runEngineeringTask({ ...options, request: 'Preserve answer.txt containing 42', executeRole: async input => {
      taskId = input.taskId
      throw new Error('Fixture interruption after role admission')
    } })).rejects.toThrow('Fixture interruption')
    await recoverEngineeringTask(options.root, taskId, true)
    const resumed = await runEngineeringTask({ ...options, taskId, request: '', executeRole: async input => input.role === 'implementer' ? { summary: 'Preserved source after recovery' } : { decision: 'ACCEPT', summary: 'Checked recovered source', findings: [] } })
    expect(resumed.status).toBe('ACCEPTED')
  }, 30_000)

  it('keeps compaction cost unknown when its actual provider model differs from the attempt quote', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, '.agent/tasks/pricing'), { recursive: true })
    const lifecycle = new FileTaskLifecycle(root, 'pricing', 'development', {}, () => start, 0, false)
    await lifecycle.initialize()
    const invocationId = await lifecycle.reserveInvocation(route.role)
    const attemptId = await lifecycle.reserveAttempt(invocationId, route)
    await lifecycle.reserveProviderRequest(attemptId, 'compaction-model', { provider: 'other-provider', model: 'other-model', routeId: route.routeId, purpose: 'compaction', cacheOmission: 'zero', inputAccounting: 'aggregate', pricing: { currency: 'USD', source: 'https://fixture.invalid/pricing', verifiedAt: '2026-10-07T00:00:00.000Z', inputPerMillion: 10, outputPerMillion: 20, inputAccounting: 'aggregate', cacheAccounting: 'reported' } })
    await lifecycle.settleProviderRequest('compaction-model', { startedAt: start, endedAt: end, outcome: 'SUCCESS', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } })
    expect((await lifecycle.usageReport()).requests[0]?.estimatedCostUsd).toBe('UNKNOWN')
  })

  it('keeps historical usage unknown when no durable request history is available', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, '.agent/tasks/legacy'), { recursive: true })
    const lifecycle = new FileTaskLifecycle(root, 'legacy', 'development', {}, () => start, 3, true, 4, start)
    const report = await lifecycle.usageReport()
    expect(report.totalTokens.status).toBe('UNKNOWN')
    expect(report.estimatedCostUsd.status).toBe('UNKNOWN')
  })

  it('does not normalize absent request usage into known zero cache counters', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, '.agent/tasks/missing-usage'), { recursive: true })
    const lifecycle = new FileTaskLifecycle(root, 'missing-usage', 'development', {}, () => start, 0, false)
    await lifecycle.initialize()
    const invocationId = await lifecycle.reserveInvocation(route.role)
    const attemptId = await lifecycle.reserveAttempt(invocationId, route)
    await lifecycle.reserveProviderRequest(attemptId, 'failed-without-usage', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent', cacheOmission: 'zero' })
    await lifecycle.settleProviderRequest('failed-without-usage', { startedAt: start, endedAt: end, outcome: 'FAILED' })
    const report = await lifecycle.usageReport()
    expect(report.cacheReadTokens.status).toBe('UNKNOWN')
    expect(report.cacheWriteTokens.status).toBe('UNKNOWN')
  })

  it('treats duplicate Session reconciliation as idempotent', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, '.agent/tasks/session-duplicate'), { recursive: true })
    const lifecycle = new FileTaskLifecycle(root, 'session-duplicate', 'development', {}, () => start, 0, false)
    await lifecycle.initialize()
    const invocationId = await lifecycle.reserveInvocation(route.role)
    const attemptId = await lifecycle.reserveAttempt(invocationId, route)
    await lifecycle.reserveProviderRequest(attemptId, 'request-1', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent', sessionId: 'session-1' })
    await lifecycle.settleProviderRequest('request-1', { startedAt: start, endedAt: end, outcome: 'SUCCESS', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } })
    const evidence = { sessionId: 'session-1', eventSeq: 7, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
    await lifecycle.reconcileSessionUsage('request-1', evidence)
    await lifecycle.reconcileSessionUsage('request-1', evidence)
    expect((await lifecycle.usageReport()).requests[0]?.sessionUsageMatch).toBe('MATCH')
  })

  it('marks reordered Session usage evidence unknown when usage conflicts', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, '.agent/tasks/session-mismatch'), { recursive: true })
    const lifecycle = new FileTaskLifecycle(root, 'session-mismatch', 'development', {}, () => start, 0, false)
    await lifecycle.initialize()
    const invocationId = await lifecycle.reserveInvocation(route.role)
    const attemptId = await lifecycle.reserveAttempt(invocationId, route)
    await lifecycle.reserveProviderRequest(attemptId, 'request-1', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent', sessionId: 'session-1' })
    await lifecycle.settleProviderRequest('request-1', { startedAt: start, endedAt: end, outcome: 'SUCCESS', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } })
    await lifecycle.reconcileSessionUsage('request-1', { sessionId: 'session-1', eventSeq: 8, usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 } })
    const report = await lifecycle.usageReport()
    expect(report.requests[0]?.sessionUsageMatch).toBe('MISMATCH')
    expect(report.requests[0]?.tokens).toBe('UNKNOWN')
    expect(report.totalTokens.status).toBe('UNKNOWN')
  })

  it('links the main assistant event without attributing it to an auxiliary same-session request with identical usage', async () => {
    const { root } = await projectFixture()
    const ctx = new Context()
    let injected = false
    try {
      await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(Subagents)
      ctx.llm.registerAdapter(['magpie', 'magpie-responses', 'company'], new ReconciliationAdapter())
      // Equal usage cannot identify the request when another call finishes in the same Session.
      ctx.on('llm/post-dispatch', async post => {
        if (injected) return
        injected = true
        for await (const _chunk of ctx.llm.stream({ ...post.options, purpose: 'session-title' })) { /* Drain the auxiliary adapter stream before the main Session appends its event. */ }
      })
      ctx.subagents.registerProvider({ name: 'spawn', inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, start: request => startInProcessRun(request, {}) })
      await ctx.plugin(Runtime, { deploymentRoot: root, roleTimeoutMs: 30_000 })
      const parent = await ctx.agentLoop.create(SessionId('reconciliation-coordinator'), {}, { cwd: root })
      await parent.ctx.tools.execute({ callId: ToolCallId('reconciliation-task'), name: 'engineering_run', arguments: { request: 'Preserve answer.txt containing 42' }, signal: new AbortController().signal, agent: parent })
      expect(injected).toBe(true)
      const task = (await getEngineeringStatus(root)).tasks[0]!
      const ledger = JSON.parse(await readFile(join(root, '.agent/tasks', task.task.id, 'LIFECYCLE.json'), 'utf8')) as { requests: Array<{ details: { purpose: string }; sessionEvidence?: { eventSeq: number; usage?: object } }> }
      const main = ledger.requests.find(request => request.details.purpose === 'agent')!
      const auxiliary = ledger.requests.find(request => request.details.purpose === 'other')!
      expect(main.sessionEvidence).toEqual(expect.objectContaining({ eventSeq: expect.any(Number), usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }))
      expect(auxiliary.sessionEvidence).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  }, 30_000)

  it.each(['BLOCKED', 'BUDGET_EXHAUSTED', 'UNCERTAIN'] as const)('does not accept %s workflow output even when the independent oracle passes', async workflowStatus => {
    const testCase = await benchmarkFixture()
    const report = await runEngineeringBenchmark({ cases: [testCase], strategies: [{ id: 'D_ADAPTIVE' }], mode: 'OFFLINE_SYNTHETIC', executor: { run: async () => [receipt('IMPLEMENTER')], report: async () => ({ workflowStatus, confirmedStopped: workflowStatus !== 'UNCERTAIN' }) }, oracle: async () => ({ accepted: true, evidence: 'Exact source accepted by oracle' }) })
    expect(report.results[0]?.status).toBe(workflowStatus)
    if (workflowStatus === 'UNCERTAIN') {
      const retained = report.results[0]!.fixturePath!
      roots.push(retained)
      expect(await stat(retained)).toBeDefined()
    }
  })

  it('keeps live evidence unknown without dispatched usage and reports each strategy denominator independently', async () => {
    const testCase = await benchmarkFixture()
    const report = await runEngineeringBenchmark({ cases: [testCase], strategies: [{ id: 'A_STRONG' }, { id: 'B_CHEAP' }], mode: 'LIVE_PROVIDER', executor: { run: async () => [receipt('SINGLE')], report: async strategy => ({ confirmedStopped: true, workflowStatus: strategy === 'A_STRONG' ? 'ACCEPTED' : 'BLOCKED', firstImplementationPass: strategy === 'A_STRONG' ? true : 'UNKNOWN' }) }, oracle: async () => ({ accepted: true, evidence: 'Source oracle' }) })
    expect(report.evidenceStatus).toBe('UNKNOWN')
    expect(report.aggregates.comparisonStatus).toBe('UNKNOWN')
    expect(report.aggregates.byStrategy.A_STRONG).toMatchObject({ acceptedCount: 1, acceptanceDenominator: 1, firstPassCount: 1, firstPassDenominator: 1, tokensPerSuccess: 'UNKNOWN' })
    expect(report.aggregates.byStrategy.B_CHEAP).toMatchObject({ acceptedCount: 0, acceptanceUnknownCount: 1, acceptanceDenominator: 1, firstPassUnknownCount: 1 })
    expect(report.aggregates.byStrategy.C_FIXED.acceptanceDenominator).toBe(0)
  })

  it('accepts a verified recovered workflow without treating a failed intermediate attempt as final rejection', async () => {
    const testCase = await benchmarkFixture()
    const report = await runEngineeringBenchmark({ cases: [testCase], strategies: [{ id: 'D_ADAPTIVE' }], mode: 'OFFLINE_SYNTHETIC', executor: { run: async () => [{ ...receipt('IMPLEMENTER'), outcome: 'FAILED' }, receipt('IMPLEMENTER'), receipt('REVIEWER')], report: async () => ({ confirmedStopped: true, workflowStatus: 'ACCEPTED', fallbackCount: 1 }) }, oracle: async () => ({ accepted: true, evidence: 'Exact final source passes independent oracle' }) })
    expect(report.results[0]).toMatchObject({ status: 'ACCEPTED', fallbackCount: 1 })
  })

  it('binds A and B to different routes and C to fixed read-only Review stages', async () => {
    const { deployment } = await projectFixture()
    const testCase = { ...await benchmarkFixture(), kind: 'review' as const }
    const calls: Array<{ routeId?: string; stage?: string; role?: string; readOnly: boolean }> = []
    const strongRouteId = 'architecture'
    const cheapRouteId = 'worker-secondary'
    const executor = createProductionEngineeringBindings({ deployment, strongRouteId, cheapRouteId, roleExecutorForCase: () => async () => { throw new Error('Unexpected adaptive invocation') }, direct: { invoke: async input => { calls.push(input); return receipt('SINGLE') }, invokeFixedStage: async input => { calls.push(input); return receipt(input.stage) } }, firstImplementationOracle: async () => { throw new Error('Review entered implementation oracle') }, verifySingle: async () => { throw new Error('Review entered implementation verification') }, reviewTarget: () => ({ kind: 'commit', target: 'HEAD' }) })
    const cwd = await temporaryRoot()
    await executor.run('A_STRONG', testCase, cwd)
    await executor.run('B_CHEAP', testCase, cwd)
    await executor.run('C_FIXED', testCase, cwd)
    expect(calls.slice(0, 2)).toMatchObject([{ routeId: strongRouteId, role: 'reviewer', readOnly: true }, { routeId: cheapRouteId, role: 'reviewer', readOnly: true }])
    expect(calls.slice(2).map(call => call.stage)).toEqual(['SCOUT', 'ARCHITECT', 'CHALLENGER', 'VERIFICATION', 'REVIEWER'])
    expect(calls.every(call => call.readOnly)).toBe(true)
  })

  it('records C first implementation outcome for implementation fixtures', async () => {
    const { deployment } = await projectFixture()
    const testCase = await benchmarkFixture()
    let firstOracleCalls = 0
    const executor = createProductionEngineeringBindings({ deployment, strongRouteId: 'architecture', cheapRouteId: 'worker-secondary', roleExecutorForCase: () => async () => ({ summary: 'unused' }), direct: {
      invoke: async () => receipt('SINGLE'),
      invokeFixedStage: async input => receipt(input.stage),
      report: async () => ({ confirmedStopped: true }),
    }, firstImplementationOracle: async () => { firstOracleCalls += 1; return true }, verifySingle: async () => receipt('VERIFICATION'), reviewTarget: () => ({ kind: 'commit', target: 'HEAD' }) })
    const cwd = await temporaryRoot()
    const receipts = await executor.run('C_FIXED', testCase, cwd)
    const evidence = await executor.report?.('C_FIXED', testCase, cwd, receipts)
    expect(firstOracleCalls).toBe(1)
    expect(evidence?.firstImplementationPass).toBe(true)
  })
})
