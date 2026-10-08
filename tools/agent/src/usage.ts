/** Pure validation and aggregation for durable provider usage observations. */

import { createHash } from 'node:crypto'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** Provider pricing asserted by one deployment and snapshotted at request admission. */
export interface ProviderPricing {
  currency: 'USD'
  source: string
  verifiedAt: string
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion?: number
  cacheWritePerMillion?: number
  inputAccounting: 'aggregate' | 'exclusive'
  cacheAccounting: 'reported' | 'not-supported'
}

/** Stable name for deployment pricing configuration. */
export type PricingQuote = ProviderPricing

/** Adapter declaration for cache counters omitted from its usage result. */
export type CacheOmission = 'zero' | 'unsupported' | 'unknown'

/** Immutable route metadata captured when a provider request is admitted. */
export interface RequestAccountingDetails {
  cacheOmission?: CacheOmission
  inputAccounting?: 'aggregate' | 'exclusive'
  pricing?: ProviderPricing
  pricingDigest?: string
}

/** Outcome reported by the adapter after dispatch. */
export type ProviderRequestOutcome = 'SUCCESS' | 'FAILED' | 'ABORTED' | 'INTERRUPTED'

/** Semantic outcome of one disposed model route attempt. */
export type AttemptOutcome = 'SUCCESS' | 'FAILED' | 'CAPABILITY_INSUFFICIENT' | 'UNCERTAIN'

/** Adapter settlement retaining its exact timestamps and raw token counters. */
export interface ProviderSettlement {
  startedAt: string
  endedAt: string
  outcome: ProviderRequestOutcome
  usage?: TokenUsage
}

/** Session event paired with one observed adapter request; never creates a charge. */
export interface SessionUsageEvidence {
  sessionId: string
  eventSeq: number
  usage?: TokenUsage
}

/** Semantic route settlement after child disposal and output validation. */
export interface AttemptSettlement {
  startedAt: string
  endedAt: string
  outcome: AttemptOutcome
}

/** Authoritative proof that a reserved request never invoked its adapter. */
export interface NotDispatchedEvidence {
  at: string
  reason: string
}

/** Durable lifecycle state transition used to calculate task elapsed time. */
export interface RunStateObservation {
  state: 'RUNNING' | 'BLOCKED' | 'BUDGET_EXHAUSTED' | 'COMPLETE' | 'FAILED'
  at: string
}

/** One immutable provider request projection in the usage report. */
export interface UsageRequestRow {
  sessionEvidence?: SessionUsageEvidence
  sessionUsageMatch?: 'MATCH' | 'MISMATCH' | 'UNKNOWN'
  requestId: string
  attemptId: string
  invocationId: string
  logicalInvocationId: string
  role: string
  provider: string
  model: string
  routeId: string
  purpose: string
  sessionId?: string
  rawUsage?: TokenUsage
  dispatchStatus: 'ADMITTED' | 'DISPATCHED' | 'ABORTED_BEFORE_DISPATCH' | 'UNKNOWN_DISPATCH'
  outcome?: ProviderRequestOutcome
  startedAt?: string
  endedAt?: string
  durationMs: number | 'UNKNOWN'
  tokens: number | 'UNKNOWN'
  cacheReadTokens: number | 'UNKNOWN'
  cacheWriteTokens: number | 'UNKNOWN'
  reasoningTokens: number | 'UNKNOWN'
  estimatedCostUsd: number | 'UNKNOWN'
  pricingDigest?: string
}

/** Settled route attempt with its role and route attribution. */
export interface UsageAttemptRow {
  attemptId: string
  invocationId: string
  role: string
  provider: string
  model: string
  routeId: string
  outcome?: AttemptOutcome
  startedAt?: string
  endedAt?: string
  durationMs: number | 'UNKNOWN'
}

/** Aggregate known values while retaining the count of observations that remain unknown. */
export interface UsageSubtotal {
  status: 'KNOWN' | 'UNKNOWN'
  knownSubtotal: number
  unknownRequestCount: number
}

/** Read-only report; generating it never changes the ledger. */
export interface TaskUsageReport {
  taskId: string
  workflow: 'development' | 'review-only'
  requests: UsageRequestRow[]
  attempts: UsageAttemptRow[]
  counts: {
    logicalInvocations: number
    physicalAttempts: number
    providerRequests: number
    compactionRequests: number
    failedRequests: number
    abortedRequests: number
    toolCalls: number
  }
  totalTokens: UsageSubtotal
  cacheReadTokens: UsageSubtotal
  cacheWriteTokens: UsageSubtotal
  reasoningTokens: UsageSubtotal
  estimatedCostUsd: UsageSubtotal
  providerActiveMs: number | 'UNKNOWN'
  requestDurationSumMs: number | 'UNKNOWN'
  endToEndMs: number | 'UNKNOWN'
  providerFailures: { knownFailures: number; knownDispatched: number; unknownDispatchCount: number }
  unattributedHistory: boolean
  unattributedHistoryCount: number
  byRole: Record<string, UsageBreakdown>
  byProvider: Record<string, UsageBreakdown>
  byModel: Record<string, UsageBreakdown>
}

/** Token, cost, failure and request counts grouped by role, provider or model. */
export interface UsageBreakdown {
  requestCount: number
  knownDispatched: number
  unknownDispatchCount: number
  knownFailures: number
  totalTokens: UsageSubtotal
  estimatedCostUsd: UsageSubtotal
}

/** Canonical JSON used for semantic duplicate detection and pricing fingerprints. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Compare observations independent of property insertion order. */
export function semanticallyEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

/** Stable digest of a validated pricing quote. */
export function pricingDigest(pricing: ProviderPricing): string {
  return createHash('sha256').update(canonicalJson(pricing)).digest('hex')
}

/** Validate an adapter usage record without inventing missing totals. */
export function isValidUsage(value: unknown): value is TokenUsage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const count = record[key]
    if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) return false
  }
  if (typeof record.inputTokens !== 'number' || !Number.isSafeInteger(record.inputTokens)
    || typeof record.outputTokens !== 'number' || !Number.isSafeInteger(record.outputTokens)) return false
  if (typeof record.totalTokens === 'number' && record.totalTokens < record.inputTokens + record.outputTokens) return false
  return true
}

/** Validate deployment pricing and reject stale or malformed assertions. */
export function validatePricing(value: unknown, now: number): ProviderPricing {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('provider pricing must be an object')
  const pricing = value as Record<string, unknown>
  if (pricing.currency !== 'USD' || typeof pricing.source !== 'string' || pricing.source.trim() === '') throw new Error('provider pricing currency and source are invalid')
  if (typeof pricing.verifiedAt !== 'string' || !Number.isFinite(Date.parse(pricing.verifiedAt)) || Date.parse(pricing.verifiedAt) > now) throw new Error('provider pricing verification timestamp is invalid or in the future')
  for (const key of ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion']) {
    const rate = pricing[key]
    if (rate !== undefined && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) throw new Error(`provider pricing ${key} must be a non-negative finite number`)
  }
  if (typeof pricing.inputPerMillion !== 'number' || typeof pricing.outputPerMillion !== 'number'
    || (pricing.inputAccounting !== 'aggregate' && pricing.inputAccounting !== 'exclusive')
    || (pricing.cacheAccounting !== 'reported' && pricing.cacheAccounting !== 'not-supported')) throw new Error('provider pricing fields are invalid')
  return {
    currency: 'USD', source: pricing.source, verifiedAt: pricing.verifiedAt,
    inputPerMillion: pricing.inputPerMillion, outputPerMillion: pricing.outputPerMillion,
    ...(typeof pricing.cacheReadPerMillion === 'number' ? { cacheReadPerMillion: pricing.cacheReadPerMillion } : {}),
    ...(typeof pricing.cacheWritePerMillion === 'number' ? { cacheWritePerMillion: pricing.cacheWritePerMillion } : {}),
    inputAccounting: pricing.inputAccounting, cacheAccounting: pricing.cacheAccounting,
  }
}

/** Validate deployment pricing at config admission time. */
export function validatePricingQuote(value: unknown, now = Date.now()): PricingQuote {
  return validatePricing(value, now)
}

/** Calculate price only when route identity and all required usage fields match the quote. */
export function estimateRequestCost(input: {
  provider: string
  model: string
  detailsProvider: string
  detailsModel: string
  pricing?: ProviderPricing
  inputAccounting?: 'aggregate' | 'exclusive'
  cacheOmission?: CacheOmission
  usage?: TokenUsage
}): number | undefined {
  const { pricing, usage } = input
  if (pricing === undefined || usage === undefined || input.provider !== input.detailsProvider || input.model !== input.detailsModel) return undefined
  if (input.inputAccounting !== undefined && input.inputAccounting !== pricing.inputAccounting) return undefined
  const cacheRead = usage.cacheReadTokens ?? (input.cacheOmission === 'zero' || input.cacheOmission === 'unsupported' ? 0 : undefined)
  const cacheWrite = usage.cacheWriteTokens ?? (input.cacheOmission === 'zero' || input.cacheOmission === 'unsupported' ? 0 : undefined)
  if (pricing.cacheAccounting === 'not-supported' && ((usage.cacheReadTokens ?? 0) !== 0 || (usage.cacheWriteTokens ?? 0) !== 0)) return undefined
  if (cacheRead === undefined || cacheWrite === undefined) return undefined
  let inputTokens = usage.inputTokens
  if (pricing.inputAccounting === 'aggregate') {
    inputTokens -= cacheRead + cacheWrite
    if (inputTokens < 0) return undefined
  }
  if (cacheRead > 0 && pricing.cacheReadPerMillion === undefined) return undefined
  if (cacheWrite > 0 && pricing.cacheWritePerMillion === undefined) return undefined
  const dollars = inputTokens * pricing.inputPerMillion + usage.outputTokens * pricing.outputPerMillion
    + cacheRead * (pricing.cacheReadPerMillion ?? 0) + cacheWrite * (pricing.cacheWritePerMillion ?? 0)
  const result = dollars / 1_000_000
  return Number.isFinite(result) ? result : undefined
}

/** Compute elapsed milliseconds only from valid, nonnegative timestamp pairs. */
export function intervalMs(startedAt: string | undefined, endedAt: string | undefined): number | undefined {
  if (startedAt === undefined || endedAt === undefined) return undefined
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  return end - start
}

/** Return the duration of the union of ordered request intervals. */
export function intervalUnionMs(intervals: ReadonlyArray<{ startedAt?: string; endedAt?: string }>): number | undefined {
  const sorted = intervals.map(interval => {
    if (interval.startedAt === undefined || interval.endedAt === undefined) return undefined
    const start = Date.parse(interval.startedAt)
    const end = Date.parse(interval.endedAt)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
    return { start, end }
  })
  if (sorted.some(interval => interval === undefined)) return undefined
  const valid = sorted.filter((interval): interval is { start: number; end: number } => interval !== undefined).sort((a, b) => a.start - b.start)
  if (valid.length === 0) return 0
  let start = valid[0]!.start
  let end = valid[0]!.end
  let total = 0
  for (const interval of valid.slice(1)) {
    if (interval.start <= end) end = Math.max(end, interval.end)
    else { total += end - start; start = interval.start; end = interval.end }
  }
  return total + end - start
}
