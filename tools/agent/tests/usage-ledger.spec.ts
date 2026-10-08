import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileTaskLifecycle } from '../src/lifecycle.ts'
import type { ResolvedRoleRoute } from '../src/config.ts'

const roots: string[] = []
const route: ResolvedRoleRoute = { role: 'scout-primary', routeId: 'fixture-cheap', capabilityLevel: 0, provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'off', maxTokens: 1000, writable: false, externalRelay: false, costClass: 'standard' }
const start = '2026-10-08T00:00:00.000Z'
const end = '2026-10-08T00:00:00.100Z'
const quote = { currency: 'USD' as const, source: 'https://fixture.invalid/official-prices', verifiedAt: '2026-10-07T00:00:00.000Z', inputPerMillion: 10, outputPerMillion: 20, cacheReadPerMillion: 1, cacheWritePerMillion: 2, inputAccounting: 'aggregate' as const, cacheAccounting: 'reported' as const }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-usage-ledger-'))
  roots.push(root)
  await mkdir(join(root, '.agent/tasks/usage'), { recursive: true })
  const lifecycle = new FileTaskLifecycle(root, 'usage', 'development', {}, () => start, 0, false)
  await lifecycle.initialize()
  const invocationId = await lifecycle.reserveInvocation(route.role)
  const attemptId = await lifecycle.reserveAttempt(invocationId, route)
  return { root, lifecycle, invocationId, attemptId, path: join(root, '.agent/tasks/usage/LIFECYCLE.json') }
}

function accounting(lifecycle: FileTaskLifecycle) {
  expect(lifecycle, 'Phase4 settlement API must exist before report assertions execute').toHaveProperty('settleProviderRequest', expect.any(Function))
  expect(lifecycle).toHaveProperty('usageReport', expect.any(Function))
  return lifecycle as FileTaskLifecycle & {
    settleProviderRequest(requestId: string, settlement: { startedAt: string; endedAt: string; outcome: 'SUCCESS' | 'FAILED' | 'ABORTED' | 'INTERRUPTED'; usage?: { inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number } }): Promise<void>
    markNotDispatched(requestId: string, evidence: { at: string; reason: string }): Promise<void>
    recordRunState(state: { state: 'RUNNING' | 'BLOCKED' | 'BUDGET_EXHAUSTED' | 'COMPLETE' | 'FAILED'; at: string }): Promise<void>
    settleAttempt(attemptId: string, settlement: { startedAt: string; endedAt: string; outcome: 'SUCCESS' | 'FAILED' | 'CAPABILITY_INSUFFICIENT' | 'UNCERTAIN' }): Promise<void>
    usageReport(): Promise<{ requests: Array<{ requestId: string; attemptId: string; invocationId: string; role: string; provider: string; model: string; routeId: string; purpose: string; rawUsage?: object; dispatchStatus: string; outcome?: string; durationMs: number | 'UNKNOWN'; tokens: number | 'UNKNOWN'; estimatedCostUsd: number | 'UNKNOWN' }>; totalTokens: { status: string; knownSubtotal: number; unknownRequestCount: number }; estimatedCostUsd: { status: string; knownSubtotal: number; unknownRequestCount: number }; providerActiveMs: number | 'UNKNOWN'; requestDurationSumMs: number | 'UNKNOWN'; endToEndMs: number | 'UNKNOWN'; providerFailures: { knownFailures: number; knownDispatched: number; unknownDispatchCount: number } }>
  }
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('actual usage accounting', () => {
  it('preserves an authoritative aggregate total without adding cached input again', async () => {
    const { lifecycle, attemptId, path } = await fixture()
    await lifecycle.reserveProviderRequest(attemptId, 'actual-aggregate', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' })
    const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 80, cacheWriteTokens: 0, reasoningTokens: 7 }
    await expect(lifecycle.recordUsage('actual-aggregate', usage)).resolves.toBeUndefined()
    expect((await lifecycle.read()).counts.totalTokens).toBe(120)
    const durable = JSON.parse(await readFile(path, 'utf8'))
    expect(durable.requests[0].usage).toEqual(usage)
  })

  it('treats repeated usage with reordered fields as the same request observation', async () => {
    const { lifecycle, attemptId } = await fixture()
    await lifecycle.reserveProviderRequest(attemptId, 'usage-replay', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' })
    await lifecycle.recordUsage('usage-replay', { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    await expect(lifecycle.recordUsage('usage-replay', { totalTokens: 15, outputTokens: 5, inputTokens: 10 })).resolves.toBeUndefined()
    expect((await lifecycle.read()).counts).toMatchObject({ providerRequests: 1, totalTokens: 15 })
    await expect(lifecycle.recordUsage('usage-replay', { inputTokens: 10, outputTokens: 6, totalTokens: 16 })).rejects.toThrow(/conflict/i)
  })

  it('retains unknown dispatches and excludes only authoritatively uninvoked reservations from failure counts', async () => {
    const { lifecycle, attemptId } = await fixture()
    const store = accounting(lifecycle)
    for (const id of ['lost-post', 'not-invoked', 'failed-without-usage']) await lifecycle.reserveProviderRequest(attemptId, id, { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' })
    await store.markNotDispatched('not-invoked', { at: end, reason: 'Owning dispatcher confirmed abort before adapter invocation' })
    await store.settleProviderRequest('failed-without-usage', { startedAt: start, endedAt: end, outcome: 'FAILED' })
    const report = await store.usageReport()
    expect(report.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: 'lost-post', dispatchStatus: 'UNKNOWN_DISPATCH', tokens: 'UNKNOWN', estimatedCostUsd: 'UNKNOWN' }),
      expect.objectContaining({ requestId: 'not-invoked', dispatchStatus: 'ABORTED_BEFORE_DISPATCH' }),
      expect.objectContaining({ requestId: 'failed-without-usage', dispatchStatus: 'DISPATCHED', outcome: 'FAILED', tokens: 'UNKNOWN' }),
    ]))
    expect(report.providerFailures).toEqual({ knownFailures: 1, knownDispatched: 1, unknownDispatchCount: 1 })
    expect(report.totalTokens).toMatchObject({ status: 'UNKNOWN', knownSubtotal: 0, unknownRequestCount: 2 })
    await expect(store.settleProviderRequest('not-invoked', { startedAt: start, endedAt: end, outcome: 'SUCCESS', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })).rejects.toThrow(/conflict|dispatch|invok/i)
  })

  it('settles once, rejects conflicting settlement, and keeps report reads and replay byte-stable', async () => {
    const { lifecycle, attemptId, path, invocationId } = await fixture()
    const store = accounting(lifecycle)
    await lifecycle.reserveProviderRequest(attemptId, 'once', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'compaction', sessionId: 'child-session' })
    const settlement = { startedAt: start, endedAt: end, outcome: 'SUCCESS' as const, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 80, reasoningTokens: 5 } }
    await store.settleProviderRequest('once', settlement)
    await store.settleProviderRequest('once', settlement)
    await store.settleAttempt(attemptId, { startedAt: start, endedAt: end, outcome: 'CAPABILITY_INSUFFICIENT' })
    await expect(store.settleProviderRequest('once', { ...settlement, outcome: 'FAILED' })).rejects.toThrow(/conflict/i)
    const before = await readFile(path, 'utf8')
    const report = await store.usageReport()
    expect(report.requests).toEqual([expect.objectContaining({ requestId: 'once', attemptId, invocationId, role: route.role, provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'compaction', rawUsage: settlement.usage, outcome: 'SUCCESS', durationMs: 100, tokens: 120, estimatedCostUsd: 'UNKNOWN' })])
    expect(report.totalTokens).toEqual({ status: 'KNOWN', knownSubtotal: 120, unknownRequestCount: 0 })
    await store.usageReport()
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('separates overlapping provider time, summed request time, and completed end-to-end time across recovery pauses', async () => {
    const { lifecycle, attemptId } = await fixture()
    const store = accounting(lifecycle)
    await store.recordRunState({ state: 'RUNNING', at: start })
    for (const [id, from, to] of [['parallel-a', start, end], ['parallel-b', '2026-10-08T00:00:00.050Z', '2026-10-08T00:00:00.150Z']] as const) {
      await lifecycle.reserveProviderRequest(attemptId, id, { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' })
      await store.settleProviderRequest(id, { startedAt: from, endedAt: to, outcome: 'SUCCESS', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
    }
    await store.recordRunState({ state: 'BLOCKED', at: '2026-10-08T00:00:00.200Z' })
    expect((await store.usageReport()).endToEndMs).toBe('UNKNOWN')
    await store.recordRunState({ state: 'RUNNING', at: '2026-10-08T00:00:00.400Z' })
    await store.recordRunState({ state: 'COMPLETE', at: '2026-10-08T00:00:00.600Z' })
    expect(await store.usageReport()).toMatchObject({ providerActiveMs: 150, requestDurationSumMs: 200, endToEndMs: 600 })
  })

  it('retains backwards raw timestamps while reporting unknown duration', async () => {
    const { lifecycle, attemptId, path } = await fixture()
    const store = accounting(lifecycle)
    await lifecycle.reserveProviderRequest(attemptId, 'clock-backwards', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' })
    await store.settleProviderRequest('clock-backwards', { startedAt: end, endedAt: start, outcome: 'INTERRUPTED' })
    expect((await store.usageReport()).requests[0]).toMatchObject({ durationMs: 'UNKNOWN', outcome: 'INTERRUPTED' })
    const durable = await readFile(path, 'utf8')
    expect(durable).toContain(start)
    expect(durable).toContain(end)
  })

  it('snapshots aggregate-input pricing at admission and never reprices existing request history', async () => {
    const { root, lifecycle, attemptId } = await fixture()
    const store = accounting(lifecycle)
    const metadata = { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' as const, cacheOmission: 'zero' as const, inputAccounting: 'aggregate' as const, pricing: { ...quote } }
    await lifecycle.reserveProviderRequest(attemptId, 'priced', metadata)
    metadata.pricing.inputPerMillion = 1000
    await store.settleProviderRequest('priced', { startedAt: start, endedAt: end, outcome: 'SUCCESS', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 80 } })
    const expected = (20 * 10 + 20 * 20 + 80) / 1_000_000
    expect((await store.usageReport()).requests[0]?.estimatedCostUsd).toBeCloseTo(expected, 12)
    const reopened = accounting(new FileTaskLifecycle(root, 'usage', 'development', {}, () => end))
    expect((await reopened.usageReport()).requests[0]?.estimatedCostUsd).toBeCloseTo(expected, 12)
  })

  it.each(['zero', 'unknown'] as const)('normalizes omitted adapter cache categories using %s metadata independently of a quote', async cacheOmission => {
    const { lifecycle, attemptId } = await fixture()
    const store = accounting(lifecycle)
    await lifecycle.reserveProviderRequest(attemptId, 'cache-omission', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent', cacheOmission, inputAccounting: 'aggregate', pricing: quote })
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
    await store.settleProviderRequest('cache-omission', { startedAt: start, endedAt: end, outcome: 'SUCCESS', usage })
    const request = (await store.usageReport()).requests[0]!
    expect(request.rawUsage).toEqual(usage)
    if (cacheOmission === 'zero') expect(request.estimatedCostUsd).toBeCloseTo(0.00014, 12)
    else expect(request.estimatedCostUsd).toBe('UNKNOWN')
  })

  it('never fabricates a total from partial usage or erases failed request usage', async () => {
    const { lifecycle, attemptId } = await fixture()
    const store = accounting(lifecycle)
    await lifecycle.reserveProviderRequest(attemptId, 'partial-failed', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' })
    const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 }
    await store.settleProviderRequest('partial-failed', { startedAt: start, endedAt: end, outcome: 'FAILED', usage })
    const report = await store.usageReport()
    expect(report.requests).toEqual([expect.objectContaining({ rawUsage: usage, tokens: 'UNKNOWN', outcome: 'FAILED' })])
    expect(report.totalTokens).toEqual({ status: 'UNKNOWN', knownSubtotal: 0, unknownRequestCount: 1 })
    expect(report.providerFailures).toEqual({ knownFailures: 1, knownDispatched: 1, unknownDispatchCount: 0 })
  })

  it('prices exclusive input independently of reported cache categories', async () => {
    const { lifecycle, attemptId } = await fixture()
    const store = accounting(lifecycle)
    await lifecycle.reserveProviderRequest(attemptId, 'exclusive', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent', cacheOmission: 'zero', inputAccounting: 'exclusive', pricing: { ...quote, inputAccounting: 'exclusive' } })
    await store.settleProviderRequest('exclusive', { startedAt: start, endedAt: end, outcome: 'SUCCESS', usage: { inputTokens: 20, outputTokens: 20, totalTokens: 120, cacheReadTokens: 80 } })
    expect((await store.usageReport()).requests[0]?.estimatedCostUsd).toBeCloseTo(0.00068, 12)
    expect((await store.usageReport()).totalTokens).toEqual({ status: 'KNOWN', knownSubtotal: 120, unknownRequestCount: 0 })
  })

  it('rejects settlement identities owned by a different task', async () => {
    const { root, lifecycle, attemptId } = await fixture()
    const store = accounting(lifecycle)
    await lifecycle.reserveProviderRequest(attemptId, 'owned-by-usage', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' })
    await mkdir(join(root, '.agent/tasks/other'), { recursive: true })
    const other = accounting(new FileTaskLifecycle(root, 'other', 'development', {}, () => start, 0, false))
    await other.initialize()
    await expect(other.settleProviderRequest('owned-by-usage', { startedAt: start, endedAt: end, outcome: 'SUCCESS' })).rejects.toThrow(/request|own|reserv/i)
    await expect(other.settleAttempt(attemptId, { startedAt: start, endedAt: end, outcome: 'SUCCESS' })).rejects.toThrow(/attempt|own|reserv/i)
    expect((await store.usageReport()).requests[0]?.dispatchStatus).toBe('UNKNOWN_DISPATCH')
  })

  it('preserves cumulative token and estimated-cost admission ceilings after reopening the task', async () => {
    const { root, lifecycle, attemptId } = await fixture()
    const store = accounting(lifecycle)
    await lifecycle.reserveProviderRequest(attemptId, 'charged', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent', cacheOmission: 'zero', inputAccounting: 'aggregate', pricing: quote })
    await store.settleProviderRequest('charged', { startedAt: start, endedAt: end, outcome: 'SUCCESS', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 80 } })
    const tokenLimited = new FileTaskLifecycle(root, 'usage', 'development', { maxTotalTokens: 120 }, () => end)
    await expect(tokenLimited.reserveProviderRequest(attemptId, 'past-tokens', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' })).rejects.toThrow(/totalTokens|token/i)
    const costLimited = new FileTaskLifecycle(root, 'usage', 'development', { maxKnownCostUsd: 0.0006 }, () => end)
    await expect(costLimited.reserveProviderRequest(attemptId, 'past-cost', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' })).rejects.toThrow(/cost|knownCostUsd/i)
    expect((await store.usageReport()).requests).toHaveLength(1)
  })

  it('fails cost admission closed after a request with unknown pricing', async () => {
    const { root, lifecycle, attemptId } = await fixture()
    const store = accounting(lifecycle)
    await lifecycle.reserveProviderRequest(attemptId, 'unpriced', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' })
    await store.settleProviderRequest('unpriced', { startedAt: start, endedAt: end, outcome: 'SUCCESS', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } })
    const limited = new FileTaskLifecycle(root, 'usage', 'development', { maxKnownCostUsd: 1 }, () => end)
    await expect(limited.reserveProviderRequest(attemptId, 'unknown-cost-retry', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' })).rejects.toThrow(/unknownCost|cost/i)
  })

  it.each(['missing-cache', 'negative-input', 'provider-mismatch'] as const)('keeps estimated cost unknown for %s', async scenario => {
    const { lifecycle, attemptId } = await fixture()
    const store = accounting(lifecycle)
    await lifecycle.reserveProviderRequest(attemptId, scenario, { provider: scenario === 'provider-mismatch' ? 'other-provider' : route.provider, model: route.model, routeId: route.routeId, purpose: 'agent', pricing: quote, inputAccounting: 'aggregate', cacheOmission: 'unknown' })
    await store.settleProviderRequest(scenario, { startedAt: start, endedAt: end, outcome: 'SUCCESS', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, ...(scenario === 'missing-cache' ? {} : { cacheReadTokens: scenario === 'negative-input' ? 20 : 0, cacheWriteTokens: 0 }) } })
    expect((await store.usageReport()).requests[0]?.estimatedCostUsd).toBe('UNKNOWN')
    expect((await store.usageReport()).estimatedCostUsd).toMatchObject({ status: 'UNKNOWN', unknownRequestCount: 1 })
  })
})
