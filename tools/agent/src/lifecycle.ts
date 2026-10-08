/** Durable task-wide admission and usage ledger shared by recovery attempts. */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ResolvedRoleRoute } from './config.ts'
import { RoleInvocationError } from './role-execution.ts'

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
  id: EngineeringProviderRequestId
  attemptId: EngineeringAttemptId
  details: ProviderRequestDetails
  createdAt: string
  usage?: TokenUsage
}
interface LifecycleDocument extends LifecycleRecord {
  legacyLogicalInvocations: number
  legacyModelAttempts: number
  invocations: InvocationEntry[]
  attempts: AttemptEntry[]
  requests: ProviderEntry[]
  toolExecutions: Array<{ id: string; attemptId: EngineeringAttemptId; createdAt: string }>
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
}

const emptyCounts = (): LifecycleCounts => ({
  logicalInvocations: 0, modelAttempts: 0, providerRequests: 0, toolCalls: 0, totalTokens: 0, knownCostUsd: 0,
})

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validUsage(value: unknown): value is TokenUsage {
  if (!isObject(value)) return false
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const count = value[key]
    if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) return false
  }
  if (typeof value.inputTokens !== 'number' || !Number.isSafeInteger(value.inputTokens) || value.inputTokens < 0
    || typeof value.outputTokens !== 'number' || !Number.isSafeInteger(value.outputTokens) || value.outputTokens < 0) return false
  if (typeof value.totalTokens === 'number') {
    const knownMinimum = value.inputTokens + value.outputTokens + (typeof value.cacheReadTokens === 'number' ? value.cacheReadTokens : 0)
      + (typeof value.cacheWriteTokens === 'number' ? value.cacheWriteTokens : 0)
    if (!Number.isSafeInteger(knownMinimum) || value.totalTokens < knownMinimum) return false
  }
  return true
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
    if (typeof details.provider !== 'string' || typeof details.model !== 'string' || typeof details.routeId !== 'string' || (details.purpose !== 'agent' && details.purpose !== 'compaction' && details.purpose !== 'other') || (details.sessionId !== undefined && typeof details.sessionId !== 'string')) throw new Error(`lifecycle provider metadata is invalid for task ${taskId}`)
    requests.push({
      id: brandString<EngineeringProviderRequestId>(entry.id), attemptId: brandString<EngineeringAttemptId>(entry.attemptId),
      details: { provider: details.provider, model: details.model, routeId: details.routeId, purpose: details.purpose, ...(details.sessionId === undefined ? {} : { sessionId: details.sessionId }) },
      createdAt: entry.createdAt, ...(entry.usage === undefined ? {} : { usage: entry.usage }),
    })
  }
  const toolExecutions: LifecycleDocument['toolExecutions'] = []
  for (const entry of value.toolExecutions) {
    if (!isObject(entry) || typeof entry.id !== 'string' || typeof entry.attemptId !== 'string' || typeof entry.createdAt !== 'string') throw new Error(`lifecycle tool execution is invalid for task ${taskId}`)
    toolExecutions.push({ id: entry.id, attemptId: brandString<EngineeringAttemptId>(entry.attemptId), createdAt: entry.createdAt })
  }
  const document: LifecycleDocument = {
    schemaVersion: 1, taskId, workflow, firstAdmittedAt: value.firstAdmittedAt,
    counts: emptyCounts(), legacyLogicalInvocations: value.legacyLogicalInvocations as number, legacyModelAttempts: value.legacyModelAttempts as number,
    history: value.history, unknownUsage: value.unknownUsage, unknownCost: value.unknownCost,
    invocations, attempts, requests, toolExecutions,
  }
  const invocationIds = new Set(invocations.map(entry => entry.id))
  const attemptIds = new Set(attempts.map(entry => entry.id))
  const requestIds = new Set(requests.map(entry => entry.id))
  const toolIds = new Set(toolExecutions.map(entry => entry.id))
  if (invocationIds.size !== invocations.length || attemptIds.size !== attempts.length || requestIds.size !== requests.length || toolIds.size !== toolExecutions.length
    || attempts.some(entry => !invocationIds.has(entry.invocationId))
    || requests.some(entry => !attemptIds.has(entry.attemptId))
    || toolExecutions.some(entry => !attemptIds.has(entry.attemptId))) throw new Error(`lifecycle ledger references or IDs are invalid for task ${taskId}`)
  const storedCounts = value.counts
  for (const key of ['logicalInvocations', 'modelAttempts', 'providerRequests', 'toolCalls', 'totalTokens'] as const) {
    const count = storedCounts[key]
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error(`lifecycle count ${key} is invalid for task ${taskId}`)
  }
  if (typeof storedCounts.knownCostUsd !== 'number' || !Number.isFinite(storedCounts.knownCostUsd) || storedCounts.knownCostUsd < 0) throw new Error(`lifecycle count knownCostUsd is invalid for task ${taskId}`)
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
  return {
    logicalInvocations: document.legacyLogicalInvocations + document.invocations.length,
    modelAttempts: document.legacyModelAttempts + document.attempts.length,
    providerRequests: document.requests.length,
    toolCalls: document.toolExecutions.length,
    totalTokens: document.requests.reduce((total, request) => total + (request.usage === undefined ? 0 : tokenTotal(request.usage)), 0),
    knownCostUsd: 0,
  }
}

function publicRecord(document: LifecycleDocument): LifecycleRecord {
  return {
    schemaVersion: 1, taskId: document.taskId, workflow: document.workflow,
    firstAdmittedAt: document.firstAdmittedAt, counts: countsOf(document), history: document.history,
    unknownUsage: document.unknownUsage || document.requests.some(request => request.usage === undefined || request.usage.totalTokens === undefined),
    unknownCost: document.unknownCost || document.requests.length > 0,
  }
}

function validateLimits(limits: LifecycleLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error(`lifecycle limit ${name} must be a non-negative number`)
  }
}

/** File-backed implementation; repository supplies its stable root and injected clock. */
export class FileTaskLifecycle implements TaskLifecycle {
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
    await this.mutate(document => {
      const attempt = document.attempts.find(entry => entry.id === attemptId)
      if (attempt === undefined) throw new Error('lifecycle attempt identity does not belong to this task')
      const existing = document.requests.find(entry => entry.id === requestId)
      if (existing !== undefined) {
        if (existing.attemptId !== attemptId || JSON.stringify(existing.details) !== JSON.stringify(details)) throw new Error('provider request identity conflicts with its durable metadata')
        return
      }
      this.assertCapacity(document, 'providerRequests')
      document.requests.push({ id: brandString<EngineeringProviderRequestId>(requestId), attemptId, details, createdAt: this.timestamp() })
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
      if (request.usage !== undefined) {
        if (JSON.stringify(request.usage) !== JSON.stringify(usage)) throw new Error('provider usage conflicts with the durable request record')
        return
      }
      request.usage = usage
    })
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
          unknownUsage: this.historical, unknownCost: this.historical,
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
      if (this.limits.maxTotalTokens !== undefined && (record.unknownUsage || document.requests.some(request => request.usage === undefined))) throw new BudgetExhaustedError('unknownUsage')
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
