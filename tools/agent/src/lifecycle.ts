/** Durable task-wide admission and usage ledger shared by recovery attempts. */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ResolvedRoleRoute } from './config.ts'
import { RoleInvocationError } from './role-execution.ts'
import { estimateRequestCost, intervalMs, intervalUnionMs, isValidUsage, pricingDigest as computePricingDigest, semanticallyEqual, validatePricing } from './usage.ts'
import type { AttemptSettlement, CacheOmission, NotDispatchedEvidence, ProviderPricing, ProviderSettlement, RunStateObservation, TaskUsageReport, UsageAttemptRow, UsageBreakdown, UsageRequestRow, UsageSubtotal } from './usage.ts'

/** Identity of one logical role invocation across its model fallbacks. */
export type EngineeringInvocationId = Branded<'EngineeringInvocationId'>
/** Identity of one selected model route attempt. */
export type EngineeringAttemptId = Branded<'EngineeringAttemptId'>
/** Identity of one adapter dispatch request. */
export type EngineeringProviderRequestId = Branded<'EngineeringProviderRequestId'>

/** Configured cumulative task ceilings. Omitted token and cost ceilings are disabled. */
export interface LifecycleLimits {
  maxLogicalInvocations?: number
  maxModelAttempts?: number
  maxProviderRequests?: number
  maxToolCalls?: number
  maxElapsedMs?: number
  maxTotalTokens?: number
  maxKnownCostUsd?: number
}

/** Provider metadata retained for an adapter dispatch. */
export interface ProviderRequestDetails {
  provider: string
  model: string
  routeId: string
  purpose: 'agent' | 'compaction' | 'other'
  sessionId?: string
  cacheOmission?: CacheOmission
  inputAccounting?: 'aggregate' | 'exclusive'
  pricing?: ProviderPricing
}

/** Durable aggregate counters for a task lifecycle. */
export interface LifecycleCounts {
  logicalInvocations: number
  modelAttempts: number
  providerRequests: number
  toolCalls: number
  totalTokens: number
  knownCostUsd: number
}

/** Read-only view of the persisted ledger and its uncertainty. */
export interface LifecycleRecord {
  schemaVersion: 1
  taskId: string
  workflow: 'development' | 'review-only'
  firstAdmittedAt: string
  counts: LifecycleCounts
  history: 'KNOWN' | 'UNKNOWN'
  unknownUsage: boolean
  unknownCost: boolean
}

interface InvocationEntry { id: EngineeringInvocationId; role: string; createdAt: string }
interface AttemptEntry {
  id: EngineeringAttemptId
  invocationId: EngineeringInvocationId
  route: Pick<ResolvedRoleRoute, 'role' | 'routeId' | 'provider' | 'model' | 'reasoningEffort'>
  createdAt: string
}
interface ProviderEntry {
  sessionEvidence?: import('./usage.ts').SessionUsageEvidence
  id: EngineeringProviderRequestId
  attemptId: EngineeringAttemptId
  details: ProviderRequestDetails
  createdAt: string
  usage?: TokenUsage
  pricingDigest?: string
  dispatchStatus?: 'ADMITTED' | 'DISPATCHED' | 'ABORTED_BEFORE_DISPATCH'
  notDispatched?: NotDispatchedEvidence
  settlement?: ProviderSettlement
}
interface TimedAttemptSettlement extends AttemptSettlement {}
interface LifecycleDocument extends LifecycleRecord {
  legacyLogicalInvocations: number
  legacyModelAttempts: number
  legacyUnattributedTokens?: number
  invocations: InvocationEntry[]
  attempts: AttemptEntry[]
  requests: ProviderEntry[]
  toolExecutions: Array<{ id: string; attemptId: EngineeringAttemptId; createdAt: string }>
  attemptSettlements?: Array<{ attemptId: EngineeringAttemptId; settlement: TimedAttemptSettlement }>
  runState?: RunStateObservation['state']
  runIntervals?: Array<{ startedAt: string; endedAt?: string; interrupted?: true }>
  finishedAt?: string
}

/** Non-fallbackable task admission failure raised before a new resource is reserved. */
export class BudgetExhaustedError extends RoleInvocationError {
  /** Create a non-fallbackable task-budget admission failure.
   * @param dimensionOrMessage - exhausted lifecycle dimension or a specific caller diagnostic.
   */
  constructor(dimensionOrMessage: keyof LifecycleCounts | 'elapsedMs' | 'unknownUsage' | 'unknownCost' | string) {
    const message = ['logicalInvocations', 'modelAttempts', 'providerRequests', 'toolCalls', 'totalTokens', 'knownCostUsd', 'elapsedMs', 'unknownUsage', 'unknownCost'].includes(dimensionOrMessage)
      ? `task lifecycle budget exhausted: ${dimensionOrMessage}` : dimensionOrMessage
    super(message, 'NON_FALLBACKABLE', false)
    this.name = 'BudgetExhaustedError'
  }
}

/** Operations for reserving and reading one task's cumulative scheduling ledger. */
export interface TaskLifecycle {
  /** Attach a Session event to an already observed request without charging it again.
   * @param requestId - owning adapter request.
   * @param evidence - durable Session identity, sequence and optional raw usage.
   */
  reconcileSessionUsage(requestId: string, evidence: import('./usage.ts').SessionUsageEvidence): Promise<void>
  /** Persist an empty ledger once after a new task has passed repository admission.
   * @returns the initialized durable record.
   */
  initialize(): Promise<LifecycleRecord>
  /** Read validated counters and uncertainty flags from durable state.
   * @returns the current lifecycle record.
   */
  read(): Promise<LifecycleRecord>
  /** Check the cumulative elapsed limit against the repository clock.
   * @returns remaining milliseconds, or undefined when no elapsed limit is configured; rejects when expired.
   */
  remainingElapsedMs(): Promise<number | undefined>
  /** Durably reserve one logical invocation before dispatch.
   * @param role - logical engineering role.
   * @returns the durable invocation identity.
   */
  reserveInvocation(role: string): Promise<EngineeringInvocationId>
  /** Durably reserve one route attempt within a logical invocation.
   * @param invocationId - owning logical invocation.
   * @param route - selected provider route.
   * @returns the durable attempt identity.
   */
  reserveAttempt(invocationId: EngineeringInvocationId, route: ResolvedRoleRoute): Promise<EngineeringAttemptId>
  /** Record one actual adapter dispatch immediately before provider invocation.
   * @param attemptId - owning route attempt.
   * @param requestId - stable adapter request identity.
   * @param details - provider, model, route and dispatch purpose.
   */
  reserveProviderRequest(attemptId: EngineeringAttemptId, requestId: string, details: ProviderRequestDetails): Promise<void>
  /** Record one tool execution using its durable session, sequence and call identity.
   * @param attemptId - owning route attempt.
   * @param toolExecutionId - durable execution identity, not a model call ID by itself.
   */
  reserveToolCall(attemptId: EngineeringAttemptId, toolExecutionId: string): Promise<void>
  /** Confirm that an inspection execution belongs to one of this task's recorded attempts.
   * @param attemptIds - route attempts authorized by the current work unit.
   * @param executionId - persisted runtime tool execution identity.
   * @returns whether the execution was durably reserved under one of those attempts.
   */
  validateInspection(attemptIds: readonly string[], executionId: string): Promise<boolean>
  /** Attach provider usage to its request; identical repeats are idempotent.
   * @param requestId - previously reserved adapter request identity.
   * @param usage - raw provider token usage.
   */
  recordUsage(requestId: string, usage: TokenUsage): Promise<void>
  /** Store the adapter's post-dispatch settlement and exact raw usage, if available. */
  settleProviderRequest(requestId: string, settlement: ProviderSettlement): Promise<void>
  /** Mark a reservation as uninvoked only with authoritative dispatcher evidence. */
  markNotDispatched(requestId: string, evidence: NotDispatchedEvidence): Promise<void>
  /** Record semantic attempt completion after its child is stopped and output is validated. */
  settleAttempt(attemptId: EngineeringAttemptId, settlement: AttemptSettlement): Promise<void>
  /** Record one durable lifecycle state and its run interval. */
  recordRunState(state: RunStateObservation): Promise<void>
  /** Project durable request, attempt and task timing observations without mutation. */
  usageReport(): Promise<TaskUsageReport>
}

const emptyCounts = (): LifecycleCounts => ({
  logicalInvocations: 0, modelAttempts: 0, providerRequests: 0, toolCalls: 0, totalTokens: 0, knownCostUsd: 0,
})

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validUsage(value: unknown): value is TokenUsage {
  return isValidUsage(value)
}

function validProviderSettlement(value: unknown): value is ProviderSettlement {
  return isObject(value) && typeof value.startedAt === 'string' && typeof value.endedAt === 'string'
    && ['SUCCESS', 'FAILED', 'ABORTED', 'INTERRUPTED'].includes(String(value.outcome))
    && (value.usage === undefined || validUsage(value.usage))
}

function validAttemptSettlement(value: unknown): value is AttemptSettlement {
  return isObject(value) && typeof value.startedAt === 'string' && typeof value.endedAt === 'string'
    && ['SUCCESS', 'FAILED', 'CAPABILITY_INSUFFICIENT', 'UNCERTAIN'].includes(String(value.outcome))
}

function validCacheOmission(value: unknown): value is CacheOmission {
  return value === 'zero' || value === 'unsupported' || value === 'unknown'
}

function validNotDispatched(value: unknown): value is NotDispatchedEvidence {
  return isObject(value) && typeof value.at === 'string' && typeof value.reason === 'string' && value.reason.trim() !== ''
}

function isRunState(value: unknown): value is RunStateObservation['state'] {
  return value === 'RUNNING' || value === 'BLOCKED' || value === 'BUDGET_EXHAUSTED' || value === 'COMPLETE' || value === 'FAILED'
}

function validDetails(value: ProviderRequestDetails, now: number): ProviderRequestDetails {
  if ([value.provider, value.model, value.routeId].some(item => typeof item !== 'string' || item.trim() === '')) throw new Error('provider request metadata is invalid')
  if (!['agent', 'compaction', 'other'].includes(value.purpose)) throw new Error('provider request purpose is invalid')
  if (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || value.sessionId.trim() === '')) throw new Error('provider request session identity is invalid')
  if (value.cacheOmission !== undefined && !validCacheOmission(value.cacheOmission)) throw new Error('provider cache omission metadata is invalid')
  if (value.inputAccounting !== undefined && value.inputAccounting !== 'aggregate' && value.inputAccounting !== 'exclusive') throw new Error('provider input accounting metadata is invalid')
  const pricing = value.pricing === undefined ? undefined : validatePricing(value.pricing, now)
  if (pricing !== undefined && value.inputAccounting !== undefined && value.inputAccounting !== pricing.inputAccounting) throw new Error('provider input accounting does not match its pricing quote')
  return {
    provider: value.provider, model: value.model, routeId: value.routeId, purpose: value.purpose,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.cacheOmission === undefined ? {} : { cacheOmission: value.cacheOmission }),
    ...(value.inputAccounting === undefined ? {} : { inputAccounting: value.inputAccounting }),
    ...(pricing === undefined ? {} : { pricing }),
  }
}

function copyProviderSettlement(value: ProviderSettlement): ProviderSettlement {
  return { startedAt: value.startedAt, endedAt: value.endedAt, outcome: value.outcome, ...(value.usage === undefined ? {} : { usage: { ...value.usage } }) }
}

function copyAttemptSettlement(value: AttemptSettlement): AttemptSettlement {
  return { startedAt: value.startedAt, endedAt: value.endedAt, outcome: value.outcome }
}

function validDocument(value: unknown, taskId: string, workflow: 'development' | 'review-only'): LifecycleDocument {
  if (!isObject(value) || value.schemaVersion !== 1 || value.taskId !== taskId || value.workflow !== workflow
    || typeof value.firstAdmittedAt !== 'string' || !Number.isFinite(Date.parse(value.firstAdmittedAt))
    || !isObject(value.counts)
    || !Number.isSafeInteger(value.legacyLogicalInvocations) || (value.legacyLogicalInvocations as number) < 0
    || !Number.isSafeInteger(value.legacyModelAttempts) || (value.legacyModelAttempts as number) < 0
    || !Array.isArray(value.invocations) || !Array.isArray(value.attempts) || !Array.isArray(value.requests)
    || !Array.isArray(value.toolExecutions) || (value.history !== 'KNOWN' && value.history !== 'UNKNOWN')
    || typeof value.unknownUsage !== 'boolean' || typeof value.unknownCost !== 'boolean') {
    throw new Error(`lifecycle ledger identity or fields are invalid for task ${taskId}`)
  }
  const invocations: InvocationEntry[] = []
  for (const entry of value.invocations) {
    if (!isObject(entry) || typeof entry.id !== 'string' || typeof entry.role !== 'string' || typeof entry.createdAt !== 'string') throw new Error(`lifecycle invocation is invalid for task ${taskId}`)
    invocations.push({ id: brandString<EngineeringInvocationId>(entry.id), role: entry.role, createdAt: entry.createdAt })
  }
  const attempts: AttemptEntry[] = []
  for (const entry of value.attempts) {
    if (!isObject(entry) || typeof entry.id !== 'string' || typeof entry.invocationId !== 'string' || !isObject(entry.route) || typeof entry.createdAt !== 'string') throw new Error(`lifecycle attempt is invalid for task ${taskId}`)
    const route = entry.route
    if (typeof route.role !== 'string' || typeof route.routeId !== 'string' || typeof route.provider !== 'string' || typeof route.model !== 'string' || typeof route.reasoningEffort !== 'string') throw new Error(`lifecycle attempt route is invalid for task ${taskId}`)
    attempts.push({
      id: brandString<EngineeringAttemptId>(entry.id), invocationId: brandString<EngineeringInvocationId>(entry.invocationId),
      route: { role: route.role, routeId: route.routeId, provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort }, createdAt: entry.createdAt,
    })
  }
  const requests: ProviderEntry[] = []
  for (const entry of value.requests) {
    if (!isObject(entry) || typeof entry.id !== 'string' || typeof entry.attemptId !== 'string' || !isObject(entry.details) || typeof entry.createdAt !== 'string' || (entry.usage !== undefined && !validUsage(entry.usage))) throw new Error(`lifecycle provider request is invalid for task ${taskId}`)
    const details = entry.details
    const sessionEvidence = entry.sessionEvidence
    if (sessionEvidence !== undefined && (!isObject(sessionEvidence) || typeof sessionEvidence.sessionId !== 'string' || !Number.isSafeInteger(sessionEvidence.eventSeq) || (sessionEvidence.eventSeq as number) < 0 || (sessionEvidence.usage !== undefined && !validUsage(sessionEvidence.usage)))) throw new Error('lifecycle Session usage evidence is invalid')
    if (typeof details.provider !== 'string' || typeof details.model !== 'string' || typeof details.routeId !== 'string' || (details.purpose !== 'agent' && details.purpose !== 'compaction' && details.purpose !== 'other') || (details.sessionId !== undefined && typeof details.sessionId !== 'string')
      || (details.cacheOmission !== undefined && !validCacheOmission(details.cacheOmission))
      || (details.inputAccounting !== undefined && details.inputAccounting !== 'aggregate' && details.inputAccounting !== 'exclusive')) throw new Error(`lifecycle provider metadata is invalid for task ${taskId}`)
    const pricing = details.pricing === undefined ? undefined : validatePricing(details.pricing, Number.POSITIVE_INFINITY)
    const dispatchStatus = entry.dispatchStatus === undefined
      ? (entry.usage === undefined ? 'ADMITTED' : 'DISPATCHED')
      : entry.dispatchStatus
    if (dispatchStatus !== 'ADMITTED' && dispatchStatus !== 'DISPATCHED' && dispatchStatus !== 'ABORTED_BEFORE_DISPATCH') throw new Error(`lifecycle dispatch status is invalid for task ${taskId}`)
    if (entry.notDispatched !== undefined && !validNotDispatched(entry.notDispatched)) throw new Error(`lifecycle no-dispatch evidence is invalid for task ${taskId}`)
    if (entry.settlement !== undefined && !validProviderSettlement(entry.settlement)) throw new Error(`lifecycle provider settlement is invalid for task ${taskId}`)
    if (entry.settlement !== undefined && dispatchStatus !== 'DISPATCHED' || entry.notDispatched !== undefined && (dispatchStatus !== 'ABORTED_BEFORE_DISPATCH' || entry.settlement !== undefined)) throw new Error(`lifecycle provider dispatch status conflicts with settlement for task ${taskId}`)
    if (entry.settlement !== undefined && entry.settlement.usage !== undefined && entry.usage !== undefined && !semanticallyEqual(entry.settlement.usage, entry.usage)) throw new Error(`lifecycle settlement usage conflicts with request usage for task ${taskId}`)
    const metadata: ProviderRequestDetails = {
      provider: details.provider, model: details.model, routeId: details.routeId, purpose: details.purpose,
      ...(details.sessionId === undefined ? {} : { sessionId: details.sessionId }),
      ...(details.cacheOmission === undefined ? {} : { cacheOmission: details.cacheOmission }),
      ...(details.inputAccounting === undefined ? {} : { inputAccounting: details.inputAccounting }),
      ...(pricing === undefined ? {} : { pricing }),
    }
    const storedDigest = typeof entry.pricingDigest === 'string' ? entry.pricingDigest : undefined
    if (entry.pricingDigest !== undefined && storedDigest === undefined) throw new Error(`lifecycle pricing digest is invalid for task ${taskId}`)
    const computedDigest = pricing === undefined ? undefined : computePricingDigest(pricing)
    if (storedDigest !== computedDigest) throw new Error(`lifecycle pricing snapshot digest disagrees for task ${taskId}`)
    requests.push({
      id: brandString<EngineeringProviderRequestId>(entry.id), attemptId: brandString<EngineeringAttemptId>(entry.attemptId),
      details: metadata,
      ...(sessionEvidence === undefined ? {} : { sessionEvidence: { sessionId: sessionEvidence.sessionId as string, eventSeq: sessionEvidence.eventSeq as number, ...(sessionEvidence.usage === undefined ? {} : { usage: sessionEvidence.usage as TokenUsage }) } }),
      createdAt: entry.createdAt,
      ...(entry.usage === undefined ? {} : { usage: entry.usage }),
      ...(storedDigest === undefined ? {} : { pricingDigest: storedDigest }),
      ...(dispatchStatus === undefined ? {} : { dispatchStatus }),
      ...(entry.notDispatched === undefined ? {} : { notDispatched: { at: entry.notDispatched.at, reason: entry.notDispatched.reason } }),
      ...(entry.settlement === undefined ? {} : { settlement: copyProviderSettlement(entry.settlement) }),
    })
  }
  const toolExecutions: LifecycleDocument['toolExecutions'] = []
  for (const entry of value.toolExecutions) {
    if (!isObject(entry) || typeof entry.id !== 'string' || typeof entry.attemptId !== 'string' || typeof entry.createdAt !== 'string') throw new Error(`lifecycle tool execution is invalid for task ${taskId}`)
    toolExecutions.push({ id: entry.id, attemptId: brandString<EngineeringAttemptId>(entry.attemptId), createdAt: entry.createdAt })
  }
  const attemptSettlements: NonNullable<LifecycleDocument['attemptSettlements']> = []
  if (value.attemptSettlements !== undefined) {
    if (!Array.isArray(value.attemptSettlements)) throw new Error(`lifecycle attempt settlements are invalid for task ${taskId}`)
    for (const entry of value.attemptSettlements) {
      if (!isObject(entry) || typeof entry.attemptId !== 'string' || !validAttemptSettlement(entry.settlement)) throw new Error(`lifecycle attempt settlement is invalid for task ${taskId}`)
      attemptSettlements.push({ attemptId: brandString<EngineeringAttemptId>(entry.attemptId), settlement: copyAttemptSettlement(entry.settlement) })
    }
  }
  const runIntervals: NonNullable<LifecycleDocument['runIntervals']> = []
  if (value.runIntervals !== undefined) {
    if (!Array.isArray(value.runIntervals)) throw new Error(`lifecycle run intervals are invalid for task ${taskId}`)
    for (const interval of value.runIntervals) {
      if (!isObject(interval) || typeof interval.startedAt !== 'string' || !Number.isFinite(Date.parse(interval.startedAt))
        || (interval.endedAt !== undefined && (typeof interval.endedAt !== 'string' || !Number.isFinite(Date.parse(interval.endedAt))))) throw new Error(`lifecycle run interval is invalid for task ${taskId}`)
      if (interval.interrupted !== undefined && interval.interrupted !== true) throw new Error(`lifecycle run interruption marker is invalid for task ${taskId}`)
      runIntervals.push({ startedAt: interval.startedAt, ...(interval.endedAt === undefined ? {} : { endedAt: interval.endedAt }), ...(interval.interrupted === true ? { interrupted: true as const } : {}) })
    }
  }
  if (value.runState !== undefined && !isRunState(value.runState)) throw new Error(`lifecycle run state is invalid for task ${taskId}`)
  if (value.finishedAt !== undefined && (typeof value.finishedAt !== 'string' || !Number.isFinite(Date.parse(value.finishedAt)))) throw new Error(`lifecycle finish timestamp is invalid for task ${taskId}`)
  const document: LifecycleDocument = {
    schemaVersion: 1, taskId, workflow, firstAdmittedAt: value.firstAdmittedAt,
    counts: emptyCounts(), legacyLogicalInvocations: value.legacyLogicalInvocations as number, legacyModelAttempts: value.legacyModelAttempts as number,
    history: value.history, unknownUsage: value.unknownUsage, unknownCost: value.unknownCost,
    invocations, attempts, requests, toolExecutions,
    ...(attemptSettlements.length === 0 ? {} : { attemptSettlements }),
    ...(value.runState === undefined ? {} : { runState: value.runState }),
    ...(value.runIntervals === undefined ? {} : { runIntervals }),
    ...(typeof value.finishedAt === 'string' ? { finishedAt: value.finishedAt } : {}),
  }
  const invocationIds = new Set(invocations.map(entry => entry.id))
  const attemptIds = new Set(attempts.map(entry => entry.id))
  const requestIds = new Set(requests.map(entry => entry.id))
  const toolIds = new Set(toolExecutions.map(entry => entry.id))
  if (invocationIds.size !== invocations.length || attemptIds.size !== attempts.length || requestIds.size !== requests.length || toolIds.size !== toolExecutions.length
    || attempts.some(entry => !invocationIds.has(entry.invocationId))
    || requests.some(entry => !attemptIds.has(entry.attemptId))
    || toolExecutions.some(entry => !attemptIds.has(entry.attemptId))
    || new Set(attemptSettlements.map(entry => entry.attemptId)).size !== attemptSettlements.length
    || attemptSettlements.some(entry => !attemptIds.has(entry.attemptId))) throw new Error(`lifecycle ledger references or IDs are invalid for task ${taskId}`)
  const storedCounts = value.counts
  for (const key of ['logicalInvocations', 'modelAttempts', 'providerRequests', 'toolCalls', 'totalTokens'] as const) {
    const count = storedCounts[key]
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error(`lifecycle count ${key} is invalid for task ${taskId}`)
  }
  if (typeof storedCounts.knownCostUsd !== 'number' || !Number.isFinite(storedCounts.knownCostUsd) || storedCounts.knownCostUsd < 0) throw new Error(`lifecycle count knownCostUsd is invalid for task ${taskId}`)
  const oldTokenTotal = requests.reduce((total, request) => total + (request.usage === undefined ? 0 : tokenTotal(request.usage)), 0)
  const authoritativeTokenTotal = requests.reduce((total, request) => total + (request.usage?.totalTokens ?? 0), 0)
  const legacyUnattributedTokens = value.legacyUnattributedTokens === undefined
    ? oldTokenTotal - authoritativeTokenTotal
    : value.legacyUnattributedTokens
  if (typeof legacyUnattributedTokens !== 'number' || !Number.isSafeInteger(legacyUnattributedTokens) || legacyUnattributedTokens < 0
    || (value.legacyUnattributedTokens === undefined && storedCounts.totalTokens !== oldTokenTotal)
    || (value.legacyUnattributedTokens !== undefined && storedCounts.totalTokens !== legacyUnattributedTokens + authoritativeTokenTotal)) {
    throw new Error(`lifecycle legacy token accounting disagrees with durable entries for task ${taskId}`)
  }
  document.legacyUnattributedTokens = legacyUnattributedTokens
  const computedCounts = countsOf(document)
  for (const key of Object.keys(computedCounts) as Array<keyof LifecycleCounts>) {
    if (storedCounts[key] !== computedCounts[key]) throw new Error(`lifecycle count ${key} disagrees with durable entries for task ${taskId}`)
  }
  document.counts = computedCounts
  return document
}

function tokenTotal(usage: TokenUsage): number {
  return usage.totalTokens ?? usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

function countsOf(document: LifecycleDocument): LifecycleCounts {
  const knownCostUsd = document.requests.reduce((total, request) => total + (request.dispatchStatus === 'ABORTED_BEFORE_DISPATCH' ? 0 : requestCost(request, document.attempts.find(attempt => attempt.id === request.attemptId)) ?? 0), 0)
  return {
    logicalInvocations: document.legacyLogicalInvocations + document.invocations.length,
    modelAttempts: document.legacyModelAttempts + document.attempts.length,
    providerRequests: document.requests.length,
    toolCalls: document.toolExecutions.length,
    totalTokens: (document.legacyUnattributedTokens ?? 0) + document.requests.reduce((total, request) => total + (request.usage?.totalTokens ?? 0), 0),
    knownCostUsd,
  }
}

function publicRecord(document: LifecycleDocument): LifecycleRecord {
  const actualRequests = document.requests.filter(request => request.dispatchStatus !== 'ABORTED_BEFORE_DISPATCH')
  return {
    schemaVersion: 1, taskId: document.taskId, workflow: document.workflow,
    firstAdmittedAt: document.firstAdmittedAt, counts: countsOf(document), history: document.history,
    unknownUsage: document.unknownUsage || actualRequests.some(request => request.dispatchStatus !== 'DISPATCHED' || request.usage?.totalTokens === undefined || sessionUsageMismatch(request)),
    unknownCost: document.unknownCost || actualRequests.some(request => requestCost(request, document.attempts.find(attempt => attempt.id === request.attemptId)) === undefined),
  }
}

function requestCost(request: ProviderEntry, attempt: AttemptEntry | undefined): number | undefined {
  if (attempt === undefined || sessionUsageMismatch(request)) return undefined
  return estimateRequestCost({
    provider: attempt.route.provider, model: attempt.route.model,
    detailsProvider: request.details.provider, detailsModel: request.details.model,
    ...(request.details.pricing === undefined ? {} : { pricing: request.details.pricing }),
    ...(request.details.inputAccounting === undefined ? {} : { inputAccounting: request.details.inputAccounting }),
    ...(request.details.cacheOmission === undefined ? {} : { cacheOmission: request.details.cacheOmission }),
    ...(request.usage === undefined ? {} : { usage: request.usage }),
  })
}

function sessionUsageMismatch(request: ProviderEntry): boolean {
  return request.sessionEvidence?.usage !== undefined && request.usage !== undefined && !semanticallyEqual(request.sessionEvidence.usage, request.usage)
}

function subtotal(values: readonly (number | undefined)[], forceUnknown = false): UsageSubtotal {
  const knownSubtotal = values.reduce<number>((total, value) => total + (value ?? 0), 0)
  const unknownRequestCount = values.filter(value => value === undefined).length
  return { status: unknownRequestCount === 0 && !forceUnknown ? 'KNOWN' : 'UNKNOWN', knownSubtotal, unknownRequestCount }
}

function buildUsageReport(document: LifecycleDocument): TaskUsageReport {
  const attemptsById = new Map(document.attempts.map(attempt => [attempt.id, attempt]))
  const invocationsById = new Map(document.invocations.map(invocation => [invocation.id, invocation]))
  const attemptSettlements = new Map((document.attemptSettlements ?? []).map(entry => [entry.attemptId, entry.settlement]))
  const requests: UsageRequestRow[] = document.requests.map(request => {
    const attempt = attemptsById.get(request.attemptId)
    const invocation = attempt === undefined ? undefined : invocationsById.get(attempt.invocationId)
    if (attempt === undefined || invocation === undefined) throw new Error(`lifecycle request ${request.id} has incomplete role attribution`)
    const dispatchStatus = request.dispatchStatus === 'DISPATCHED' ? 'DISPATCHED'
      : request.dispatchStatus === 'ABORTED_BEFORE_DISPATCH' ? 'ABORTED_BEFORE_DISPATCH' : 'UNKNOWN_DISPATCH'
    const usage = request.usage
    const settlement = request.settlement
    const cacheReadTokens = usage === undefined ? undefined : usage.cacheReadTokens ?? (request.details.cacheOmission === 'zero' || request.details.cacheOmission === 'unsupported' ? 0 : undefined)
    const cacheWriteTokens = usage === undefined ? undefined : usage.cacheWriteTokens ?? (request.details.cacheOmission === 'zero' || request.details.cacheOmission === 'unsupported' ? 0 : undefined)
    const estimate = requestCost(request, attempt)
    const mismatch = request.sessionEvidence?.usage !== undefined && usage !== undefined && !semanticallyEqual(request.sessionEvidence.usage, usage)
    return {
      requestId: request.id, attemptId: request.attemptId, invocationId: invocation.id, logicalInvocationId: invocation.id,
      ...(request.sessionEvidence === undefined ? {} : { sessionEvidence: request.sessionEvidence, sessionUsageMatch: mismatch ? 'MISMATCH' as const : request.sessionEvidence.usage === undefined || usage === undefined ? 'UNKNOWN' as const : 'MATCH' as const }),
      role: invocation.role, provider: request.details.provider, model: request.details.model, routeId: request.details.routeId,
      purpose: request.details.purpose, ...(request.details.sessionId === undefined ? {} : { sessionId: request.details.sessionId }),
      ...(usage === undefined ? {} : { rawUsage: { ...usage } }), dispatchStatus,
      ...(settlement === undefined ? {} : { outcome: settlement.outcome, startedAt: settlement.startedAt, endedAt: settlement.endedAt }),
      durationMs: intervalMs(settlement?.startedAt, settlement?.endedAt) ?? 'UNKNOWN',
      tokens: mismatch ? 'UNKNOWN' : usage?.totalTokens ?? 'UNKNOWN', cacheReadTokens: cacheReadTokens ?? 'UNKNOWN',
      cacheWriteTokens: cacheWriteTokens ?? 'UNKNOWN', reasoningTokens: usage?.reasoningTokens ?? 'UNKNOWN',
      estimatedCostUsd: mismatch ? 'UNKNOWN' : estimate ?? 'UNKNOWN', ...(request.pricingDigest === undefined ? {} : { pricingDigest: request.pricingDigest }),
    }
  })
  const attempts: UsageAttemptRow[] = document.attempts.map(attempt => {
    const settlement = attemptSettlements.get(attempt.id)
    return {
      attemptId: attempt.id, invocationId: attempt.invocationId, role: attempt.route.role,
      provider: attempt.route.provider, model: attempt.route.model, routeId: attempt.route.routeId,
      ...(settlement === undefined ? {} : { outcome: settlement.outcome, startedAt: settlement.startedAt, endedAt: settlement.endedAt }),
      durationMs: intervalMs(settlement?.startedAt, settlement?.endedAt) ?? 'UNKNOWN',
    }
  })
  const actualRequests = requests.filter(request => request.dispatchStatus !== 'ABORTED_BEFORE_DISPATCH')
  const unattributedHistory = document.history === 'UNKNOWN' || (document.legacyUnattributedTokens ?? 0) > 0
  const sumFor = (rows: readonly UsageRequestRow[], select: (row: UsageRequestRow) => number | 'UNKNOWN', forceUnknown = false): UsageSubtotal =>
    subtotal(rows.map(row => { const value = select(row); return value === 'UNKNOWN' ? undefined : value }), forceUnknown)
  const intervals = requests.filter(request => request.dispatchStatus !== 'ABORTED_BEFORE_DISPATCH')
  const intervalValues = intervals.map(request => ({
    ...(request.startedAt === undefined ? {} : { startedAt: request.startedAt }),
    ...(request.endedAt === undefined ? {} : { endedAt: request.endedAt }),
  }))
  const providerActive = unattributedHistory || intervals.some(request => request.dispatchStatus !== 'DISPATCHED') ? undefined : intervalUnionMs(intervalValues)
  const durationUnknown = unattributedHistory || intervals.some(request => request.dispatchStatus !== 'DISPATCHED' || request.durationMs === 'UNKNOWN')
  const durationSum = durationUnknown ? undefined : intervals.reduce((total, request) => total + Number(request.durationMs), 0)
  const elapsed = document.finishedAt === undefined || document.runIntervals?.some(interval => interval.interrupted === true)
    ? undefined : intervalMs(document.firstAdmittedAt, document.finishedAt)
  const providerFailures = {
    knownFailures: requests.filter(request => request.dispatchStatus === 'DISPATCHED' && request.outcome !== undefined && request.outcome !== 'SUCCESS').length,
    knownDispatched: requests.filter(request => request.dispatchStatus === 'DISPATCHED').length,
    unknownDispatchCount: requests.filter(request => request.dispatchStatus === 'UNKNOWN_DISPATCH').length,
  }
  const breakdown = (rows: readonly UsageRequestRow[]): UsageBreakdown => ({
    requestCount: rows.length,
    knownDispatched: rows.filter(request => request.dispatchStatus === 'DISPATCHED').length,
    unknownDispatchCount: rows.filter(request => request.dispatchStatus === 'UNKNOWN_DISPATCH').length,
    knownFailures: rows.filter(request => request.dispatchStatus === 'DISPATCHED' && request.outcome !== undefined && request.outcome !== 'SUCCESS').length,
    totalTokens: sumFor(rows.filter(request => request.dispatchStatus !== 'ABORTED_BEFORE_DISPATCH'), row => row.tokens, unattributedHistory),
    estimatedCostUsd: sumFor(rows.filter(request => request.dispatchStatus !== 'ABORTED_BEFORE_DISPATCH'), row => row.estimatedCostUsd, unattributedHistory),
  })
  const group = (key: (request: UsageRequestRow) => string): Record<string, UsageBreakdown> => {
    const grouped = new Map<string, UsageRequestRow[]>()
    for (const request of requests) {
      const name = key(request)
      const rows = grouped.get(name) ?? []
      rows.push(request)
      grouped.set(name, rows)
    }
    return Object.fromEntries([...grouped].map(([name, rows]) => [name, breakdown(rows)]))
  }
  return {
    taskId: document.taskId, workflow: document.workflow, requests, attempts,
    counts: {
      logicalInvocations: document.counts.logicalInvocations + document.legacyLogicalInvocations,
      physicalAttempts: document.counts.modelAttempts + document.legacyModelAttempts,
      providerRequests: document.counts.providerRequests,
      compactionRequests: requests.filter(request => request.purpose === 'compaction').length,
      failedRequests: providerFailures.knownFailures,
      abortedRequests: requests.filter(request => request.dispatchStatus === 'ABORTED_BEFORE_DISPATCH').length,
      toolCalls: document.counts.toolCalls,
    },
    totalTokens: sumFor(actualRequests, row => row.tokens, unattributedHistory),
    cacheReadTokens: sumFor(actualRequests, row => row.cacheReadTokens, unattributedHistory),
    cacheWriteTokens: sumFor(actualRequests, row => row.cacheWriteTokens, unattributedHistory),
    reasoningTokens: sumFor(actualRequests, row => row.reasoningTokens, unattributedHistory),
    estimatedCostUsd: sumFor(actualRequests, row => row.estimatedCostUsd, unattributedHistory),
    providerActiveMs: providerActive ?? 'UNKNOWN', requestDurationSumMs: durationSum ?? 'UNKNOWN',
    endToEndMs: unattributedHistory ? 'UNKNOWN' : elapsed ?? 'UNKNOWN', providerFailures,
    unattributedHistory, unattributedHistoryCount: unattributedHistory ? 1 : 0,
    byRole: group(request => request.role), byProvider: group(request => request.provider), byModel: group(request => request.model),
  }
}

function validateLimits(limits: LifecycleLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error(`lifecycle limit ${name} must be a non-negative number`)
  }
}

/** File-backed implementation; repository supplies its stable root and injected clock. */
export class FileTaskLifecycle implements TaskLifecycle {
  /** Attach one immutable Session event; replay cannot add requests or token counts. */
  async reconcileSessionUsage(requestId: string, evidence: import('./usage.ts').SessionUsageEvidence): Promise<void> {
    if (!Number.isSafeInteger(evidence.eventSeq) || evidence.eventSeq < 0 || (evidence.usage !== undefined && !validUsage(evidence.usage))) throw new Error('Session usage evidence is invalid')
    await this.mutate(document => {
      const request = document.requests.find(item => item.id === requestId)
      if (request === undefined || request.details.sessionId !== evidence.sessionId) throw new Error('Session usage evidence does not belong to this request')
      if (request.sessionEvidence !== undefined && !semanticallyEqual(request.sessionEvidence, evidence)) throw new Error('Session usage evidence conflicts with durable record')
      request.sessionEvidence = structuredClone(evidence)
    })
  }
  private readonly path: string

  /** Create a ledger facade for an already selected task directory.
   * @param root - repository root containing `.agent`.
   * @param taskId - task identity.
   * @param workflow - artifact namespace owning the task.
   * @param limits - cumulative admission ceilings.
   * @param now - repository clock returning an ISO timestamp.
   * @param legacyRoleCalls - known AUTO role-call count when importing an old task.
   * @param historical - whether the missing ledger belongs to a pre-ledger task.
   * @param legacyModelAttempts - known pre-ledger route attempts.
   * @param historicalCreatedAt - task creation time when elapsed usage has no ledger record.
   */
  constructor(
    root: string,
    private readonly taskId: string,
    private readonly workflow: 'development' | 'review-only',
    private readonly limits: LifecycleLimits,
    private readonly now: () => string,
    private readonly legacyRoleCalls = 0,
    private readonly historical = true,
    private readonly legacyModelAttempts = 0,
    private readonly historicalCreatedAt?: string,
  ) {
    this.path = join(root, '.agent', workflow === 'development' ? 'tasks' : 'reviews', taskId, 'LIFECYCLE.json')
    validateLimits(limits)
  }

  /** Read validated counters and uncertainty flags from durable state. */
  async read(): Promise<LifecycleRecord> {
    return withFileLock(this.path, async () => publicRecord(await this.load()))
  }

  /** Evaluate the remaining task lifetime using the same clock as reservations. */
  async remainingElapsedMs(): Promise<number | undefined> {
    if (this.limits.maxElapsedMs === undefined) return undefined
    const document = await this.load()
    const remaining = this.limits.maxElapsedMs - (this.timestampMs() - Date.parse(document.firstAdmittedAt))
    if (remaining <= 0) throw new BudgetExhaustedError('elapsedMs')
    return remaining
  }

  /** Persist an empty ledger once after a new task has passed repository admission. */
  async initialize(): Promise<LifecycleRecord> {
    return withFileLock(this.path, async () => {
      try {
        const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
        return publicRecord(validDocument(parsed, this.taskId, this.workflow))
      } catch (error) {
        if (!isObject(error) || error.code !== 'ENOENT') throw error
      }
      const document = await this.load()
      if (document.legacyLogicalInvocations !== 0 || document.legacyModelAttempts !== 0 || document.history !== 'KNOWN') throw new Error('cannot initialize a new lifecycle ledger over historical task activity')
      await writeFileAtomic(this.path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
      return publicRecord(document)
    })
  }

  /** Durably reserve one logical invocation before dispatch. */
  async reserveInvocation(role: string): Promise<EngineeringInvocationId> {
    if (role.trim() === '') throw new Error('lifecycle role must be non-empty')
    const id = brandString<EngineeringInvocationId>(randomUUID())
    await this.mutate(document => {
      this.assertCapacity(document, 'logicalInvocations')
      document.invocations.push({ id, role, createdAt: this.timestamp() })
    })
    return id
  }

  /** Durably reserve one route attempt within a logical invocation. */
  async reserveAttempt(invocationId: EngineeringInvocationId, route: ResolvedRoleRoute): Promise<EngineeringAttemptId> {
    const id = brandString<EngineeringAttemptId>(randomUUID())
    await this.mutate(document => {
      if (!document.invocations.some(invocation => invocation.id === invocationId)) throw new Error('lifecycle invocation identity does not belong to this task')
      this.assertCapacity(document, 'modelAttempts')
      document.attempts.push({
        id, invocationId, route: { role: route.role, routeId: route.routeId, provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort },
        createdAt: this.timestamp(),
      })
    })
    return id
  }

  /** Record one actual adapter dispatch immediately before provider invocation. */
  async reserveProviderRequest(attemptId: EngineeringAttemptId, requestId: string, details: ProviderRequestDetails): Promise<void> {
    if (requestId.trim() === '') throw new Error('provider request identity must be non-empty')
    const normalizedDetails = validDetails(details, this.timestampMs())
    const quoteDigest = normalizedDetails.pricing === undefined ? undefined : computePricingDigest(normalizedDetails.pricing)
    await this.mutate(document => {
      const attempt = document.attempts.find(entry => entry.id === attemptId)
      if (attempt === undefined) throw new Error('lifecycle attempt identity does not belong to this task')
      const existing = document.requests.find(entry => entry.id === requestId)
      if (existing !== undefined) {
        if (existing.attemptId !== attemptId || !semanticallyEqual(existing.details, normalizedDetails) || existing.pricingDigest !== quoteDigest) throw new Error('provider request identity conflicts with its durable metadata')
        return
      }
      this.assertCapacity(document, 'providerRequests')
      document.requests.push({ id: brandString<EngineeringProviderRequestId>(requestId), attemptId, details: normalizedDetails, createdAt: this.timestamp(), dispatchStatus: 'ADMITTED', ...(quoteDigest === undefined ? {} : { pricingDigest: quoteDigest }) })
    })
  }

  /** Record one tool execution using its durable session, sequence and call identity. */
  async reserveToolCall(attemptId: EngineeringAttemptId, toolExecutionId: string): Promise<void> {
    await this.mutate(document => {
      if (!document.attempts.some(entry => entry.id === attemptId)) throw new Error('lifecycle attempt identity does not belong to this task')
      const existing = document.toolExecutions.find(entry => entry.id === toolExecutionId)
      if (existing !== undefined) {
        if (existing.attemptId !== attemptId) throw new Error('tool execution identity conflicts with its durable attempt')
        return
      }
      this.assertCapacity(document, 'toolCalls')
      document.toolExecutions.push({ id: toolExecutionId, attemptId, createdAt: this.timestamp() })
    })
  }

  /** Confirm that an inspection execution belongs to one of this task's recorded attempts.
   * @param attemptIds - route attempts authorized by the current work unit.
   * @param executionId - persisted runtime tool execution identity.
   * @returns whether the execution was durably reserved under one of those attempts.
   */
  async validateInspection(attemptIds: readonly string[], executionId: string): Promise<boolean> {
    if (attemptIds.length === 0 || executionId.length === 0) return false
    const allowed = new Set(attemptIds)
    return withFileLock(this.path, async () => {
      const document = await this.load()
      const execution = document.toolExecutions.find(entry => entry.id === executionId)
      if (execution === undefined || !allowed.has(execution.attemptId)) return false
      const attempt = document.attempts.find(entry => entry.id === execution.attemptId)
      return attempt !== undefined && document.invocations.some(invocation => invocation.id === attempt.invocationId)
    })
  }

  /** Attach provider usage to its request; identical repeats are idempotent. */
  async recordUsage(requestId: string, usage: TokenUsage): Promise<void> {
    if (!validUsage(usage)) throw new Error('provider usage is invalid')
    await this.mutate(document => {
      const request = document.requests.find(entry => entry.id === requestId)
      if (request === undefined) throw new Error('provider usage has no reserved request')
      if (request.dispatchStatus === 'ABORTED_BEFORE_DISPATCH') throw new Error('provider usage conflicts with confirmed non-dispatch')
      if (request.usage !== undefined) {
        if (!semanticallyEqual(request.usage, usage)) throw new Error('provider usage conflicts with the durable request record')
      } else {
        request.usage = { ...usage }
      }
      request.dispatchStatus = 'DISPATCHED'
      if (request.settlement !== undefined && request.settlement.usage === undefined) request.settlement.usage = { ...usage }
    })
  }

  /** Store the adapter's post-dispatch outcome and exact raw usage. */
  async settleProviderRequest(requestId: string, settlement: ProviderSettlement): Promise<void> {
    if (requestId.trim() === '' || !validProviderSettlement(settlement)) throw new Error('provider settlement is invalid')
    await this.mutate(document => {
      const request = document.requests.find(entry => entry.id === requestId)
      if (request === undefined) throw new Error('provider settlement has no reserved request owned by this task')
      if (request.dispatchStatus === 'ABORTED_BEFORE_DISPATCH') throw new Error('provider settlement conflicts with confirmed non-dispatch')
      const next = copyProviderSettlement(settlement)
      if (request.settlement !== undefined) {
        const previous = request.settlement
        if (previous.startedAt !== next.startedAt || previous.endedAt !== next.endedAt || previous.outcome !== next.outcome
          || previous.usage !== undefined && next.usage !== undefined && !semanticallyEqual(previous.usage, next.usage)) {
          throw new Error('provider settlement conflicts with its durable request record')
        }
        if (previous.usage === undefined && next.usage !== undefined) previous.usage = { ...next.usage }
      } else {
        request.settlement = next
      }
      if (next.usage !== undefined) {
        if (request.usage !== undefined && !semanticallyEqual(request.usage, next.usage)) throw new Error('provider settlement usage conflicts with its durable request record')
        request.usage = { ...next.usage }
      }
      request.dispatchStatus = 'DISPATCHED'
    })
  }

  /** Confirm a reserved request never invoked its adapter. */
  async markNotDispatched(requestId: string, evidence: NotDispatchedEvidence): Promise<void> {
    if (requestId.trim() === '' || !validNotDispatched(evidence) || !Number.isFinite(Date.parse(evidence.at))) throw new Error('non-dispatch evidence is invalid')
    await this.mutate(document => {
      const request = document.requests.find(entry => entry.id === requestId)
      if (request === undefined) throw new Error('non-dispatch evidence has no reserved request owned by this task')
      if (request.dispatchStatus === 'DISPATCHED' || request.usage !== undefined || request.settlement !== undefined) throw new Error('request dispatch cannot be reversed by non-dispatch evidence')
      if (request.notDispatched !== undefined) {
        if (!semanticallyEqual(request.notDispatched, evidence)) throw new Error('non-dispatch evidence conflicts with its durable request record')
        return
      }
      request.notDispatched = { at: evidence.at, reason: evidence.reason }
      request.dispatchStatus = 'ABORTED_BEFORE_DISPATCH'
    })
  }

  /** Record a disposed route attempt's semantic result. */
  async settleAttempt(attemptId: EngineeringAttemptId, settlement: AttemptSettlement): Promise<void> {
    if (!validAttemptSettlement(settlement)) throw new Error('attempt settlement is invalid')
    await this.mutate(document => {
      if (!document.attempts.some(attempt => attempt.id === attemptId)) throw new Error('attempt settlement identity does not belong to this task')
      const entries = document.attemptSettlements ??= []
      const existing = entries.find(entry => entry.attemptId === attemptId)
      const next = copyAttemptSettlement(settlement)
      if (existing !== undefined) {
        if (!semanticallyEqual(existing.settlement, next)) throw new Error('attempt settlement conflicts with its durable result')
        return
      }
      entries.push({ attemptId, settlement: next })
    })
  }

  /** Persist run boundaries and terminal task timing with the lifecycle writer. */
  async recordRunState(observation: RunStateObservation): Promise<void> {
    if (!isRunState(observation.state) || !Number.isFinite(Date.parse(observation.at))) throw new Error('lifecycle run state observation is invalid')
    await this.mutate(document => {
      if (document.finishedAt !== undefined) {
        if (document.runState === observation.state && document.finishedAt === observation.at) return
        throw new Error('lifecycle task is already terminal')
      }
      const intervals = document.runIntervals ??= []
      const active = intervals.at(-1)
      if (observation.state === 'RUNNING') {
        if (document.runState === 'RUNNING' && active !== undefined && active.endedAt === undefined && active.startedAt === observation.at) return
        if (document.runState === 'RUNNING' && active !== undefined && active.endedAt === undefined) active.interrupted = true
        else if (active?.endedAt === undefined && active !== undefined) throw new Error('lifecycle run is already active')
        intervals.push({ startedAt: observation.at })
        document.runState = observation.state
        return
      }
      if (observation.state === 'BLOCKED' || observation.state === 'BUDGET_EXHAUSTED') {
        if (document.runState === observation.state && active?.endedAt === observation.at) return
        if (document.runState !== 'RUNNING' || active === undefined || active.endedAt !== undefined) throw new Error('lifecycle run cannot close without an active interval')
        active.endedAt = observation.at
        document.runState = observation.state
        return
      }
      if (document.runState === 'RUNNING' && active !== undefined && active.endedAt === undefined) active.endedAt = observation.at
      document.runState = observation.state
      document.finishedAt = observation.at
    })
  }

  /** Build a read-only report from persisted request, attempt and run observations. */
  async usageReport(): Promise<TaskUsageReport> {
    return withFileLock(this.path, async () => buildUsageReport(await this.load()))
  }

  private async load(): Promise<LifecycleDocument> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      return validDocument(parsed, this.taskId, this.workflow)
    } catch (error) {
      if (isObject(error) && error.code === 'ENOENT') {
        return {
          schemaVersion: 1, taskId: this.taskId, workflow: this.workflow, firstAdmittedAt: this.historical ? this.historicalCreatedAt ?? this.timestamp() : this.timestamp(),
          counts: emptyCounts(), legacyLogicalInvocations: this.legacyRoleCalls, legacyModelAttempts: this.legacyModelAttempts, history: this.historical ? 'UNKNOWN' : 'KNOWN',
          unknownUsage: this.historical, unknownCost: this.historical, legacyUnattributedTokens: 0,
          invocations: [], attempts: [], requests: [], toolExecutions: [],
        }
      }
      throw error
    }
  }

  private async mutate(operation: (document: LifecycleDocument) => void): Promise<void> {
    await withFileLock(this.path, async () => {
      const document = await this.load()
      operation(document)
      document.counts = countsOf(document)
      await writeFileAtomic(this.path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    })
  }

  private assertCapacity(document: LifecycleDocument, dimension: keyof LifecycleCounts): void {
    const record = publicRecord(document)
    const limit = dimension === 'knownCostUsd' ? this.limits.maxKnownCostUsd
      : dimension === 'logicalInvocations' ? this.limits.maxLogicalInvocations
        : dimension === 'modelAttempts' ? this.limits.maxModelAttempts
          : dimension === 'providerRequests' ? this.limits.maxProviderRequests
            : dimension === 'toolCalls' ? this.limits.maxToolCalls
              : dimension === 'totalTokens' ? this.limits.maxTotalTokens : undefined
    if (limit !== undefined && record.counts[dimension] >= limit) throw new BudgetExhaustedError(dimension)
    if (this.limits.maxElapsedMs !== undefined && this.timestampMs() - Date.parse(document.firstAdmittedAt) >= this.limits.maxElapsedMs) throw new BudgetExhaustedError('elapsedMs')
    if (dimension === 'providerRequests') {
      if (this.limits.maxProviderRequests !== undefined && document.history === 'UNKNOWN') throw new BudgetExhaustedError('unknownProviderRequests')
      if (this.limits.maxTotalTokens !== undefined && (record.unknownUsage || document.requests.some(request => request.dispatchStatus !== 'ABORTED_BEFORE_DISPATCH' && request.usage?.totalTokens === undefined))) throw new BudgetExhaustedError('unknownUsage')
      if (this.limits.maxTotalTokens !== undefined && record.counts.totalTokens >= this.limits.maxTotalTokens) throw new BudgetExhaustedError('totalTokens')
      if (this.limits.maxKnownCostUsd !== undefined && record.unknownCost) throw new BudgetExhaustedError('unknownCost')
      if (this.limits.maxKnownCostUsd !== undefined && record.counts.knownCostUsd >= this.limits.maxKnownCostUsd) throw new BudgetExhaustedError('knownCostUsd')
    }
    if (dimension === 'toolCalls' && this.limits.maxToolCalls !== undefined && document.history === 'UNKNOWN') throw new BudgetExhaustedError('unknownToolCalls')
  }

  private timestamp(): string {
    const value = this.now()
    if (!Number.isFinite(Date.parse(value))) throw new Error('lifecycle clock returned an invalid timestamp')
    return value
  }

  private timestampMs(): number { return Date.parse(this.timestamp()) }
}
