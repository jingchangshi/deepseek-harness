/** Typed role-dispatch failures and attempt records for safe route fallback. */

import {
  ACCOUNT_QUOTA_EXCEEDED_CODE,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  INVALID_CREDENTIAL_CODE,
  POLICY_REFUSAL_CODE,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type { ResolvedRoleRoute } from './config.ts'
import type { EngineeringRole } from './automatic.ts'
import type { SchedulingEscalationId } from './scheduling.ts'

/** One disjoint reason a role attempt can stop without an authoritative result. */
export type RoleFailureClass =
  | 'PROVIDER_REQUEST_FAILURE'
  | 'ROUTE_EXECUTION_FAILURE'
  | 'MISSING_STRUCTURED_OUTPUT'
  | 'SCHEMA_INVALID'
  | 'MODEL_MALFORMED_OUTPUT'
  | 'ROLE_TIMEOUT_QUIESCENT'
  | 'POLICY_REFUSED'
  | 'NON_FALLBACKABLE'

/** One settled candidate attempt in a logical role invocation. */
export interface RoleAttemptRecord {
  /** Logical engineering role under dispatch. */
  role: EngineeringRole
  /** One-based attempt ordinal within one logical invocation. */
  attemptIndex: number
  mode: 'PRIMARY' | 'FALLBACK' | 'ESCALATE'
  escalationId?: SchedulingEscalationId
  /** Reservation that owns a FALLBACK route dispatched for an escalation. */
  parentEscalationId?: SchedulingEscalationId
  routeId: string
  provider: string
  model: string
  reasoningEffort: string
  startedAt: string
  endedAt: string
  outcome: 'SUCCESS' | 'FAILED'
  failureClass?: RoleFailureClass
  fallbackReason?: string
}

/** Error a role executor or schema validator raises with an explicit failure class. */
export class RoleInvocationError extends Error {
  /** Create a classified role failure. */
  constructor(
    message: string,
    public readonly failureClass: RoleFailureClass,
    public readonly fallbackable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RoleInvocationError'
  }
}

/** A role child could not be confirmed stopped after its result settled. */
export class RoleQuiescenceError extends RoleInvocationError {
  /**
   * Create a non-fallbackable failure that requires stopped-work recovery.
   * @param message - cleanup diagnostic retained for durable recovery.
   * @param options - underlying cleanup or combined execution and cleanup failure.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'NON_FALLBACKABLE', false, options)
    this.name = 'RoleQuiescenceError'
  }
}

/** Typed model request for bounded capability escalation. */
export class CapabilityInsufficientError extends Error {
  /** Create a capability failure with its bounded model-provided checkpoint. */
  constructor(
    public readonly reason: 'EVIDENCE_INSUFFICIENT' | 'TASK_COMPLEXITY' | 'REPAIR_FAILED' | 'DESIGN_ERROR',
    public readonly details: string,
    public readonly partial: { observations: string[]; unresolvedQuestions: string[] },
    public readonly failedRouteId?: string,
    public readonly failedAttemptIndex?: number,
  ) {
    super(details)
    this.name = 'CapabilityInsufficientError'
  }
}

const PROVIDER_REQUEST_FAILURE_CODES = new Set([
  'AUTH',
  'MISSING_CREDENTIAL',
  INVALID_CREDENTIAL_CODE,
  'RATE_LIMIT',
  QUOTA_EXCEEDED_CODE,
  ACCOUNT_QUOTA_EXCEEDED_CODE,
  'INVALID_REQUEST',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'STREAM_CLOSED',
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  'PI_AI_ERROR',
])

const ROUTE_EXECUTION_FAILURE_CODES = new Set([
  'NO_ADAPTER',
  'UNKNOWN_MODEL',
  'UNSUPPORTED_REASONING_EFFORT',
  'INVALID_MODEL_INFO',
  'INVALID_MODEL_CONTEXT',
  'INVALID_MODEL_MAX_TOKENS',
  'INVALID_MODEL_REASONING',
  'INVALID_CATALOG',
  'NO_DISCOVERY',
])

/**
 * Map one stable LLM runtime code to a fallback-eligible role failure.
 *
 * Only exact provider/request and route-resolution codes are accepted.
 * Lifecycle, registration, programming, abort, and unknown codes return no
 * classification and therefore remain non-fallbackable.
 *
 * @param code - stable code preserved by the child's durable turn error.
 * @param message - model-safe diagnostic retained on the classified failure.
 * @returns a typed fallback-eligible failure, or `undefined` for every other code.
 */
export function roleInvocationErrorForLlmCode(code: string, message: string): RoleInvocationError | undefined {
  if (code === POLICY_REFUSAL_CODE) return new RoleInvocationError(message, 'POLICY_REFUSED', true)
  if (code === 'MALFORMED_RESPONSE') return new RoleInvocationError(message, 'MODEL_MALFORMED_OUTPUT', true)
  if (PROVIDER_REQUEST_FAILURE_CODES.has(code)) return new RoleInvocationError(message, 'PROVIDER_REQUEST_FAILURE', true)
  if (ROUTE_EXECUTION_FAILURE_CODES.has(code)) return new RoleInvocationError(message, 'ROUTE_EXECUTION_FAILURE', true)
  return undefined
}

/** Create one bounded in-memory attempt record. */
export function newRoleAttempt(route: ResolvedRoleRoute, attemptIndex: number, outcome: RoleAttemptRecord['outcome'], extra?: Pick<RoleAttemptRecord, 'failureClass' | 'fallbackReason'>): RoleAttemptRecord {
  return {
    role: route.role as EngineeringRole,
    attemptIndex,
    mode: attemptIndex === 1 ? 'PRIMARY' : 'FALLBACK',
    routeId: route.routeId,
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoningEffort,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    outcome,
    ...extra,
  }
}

/**
 * Decide whether one rejected role attempt may run a different configured route.
 *
 * Cancellation and shutdown are never fallbackable, regardless of any provider
 * text. Generic, unclassified errors are also non-fallbackable: only explicitly
 * classified provider, route, structured-output, malformed-output, or quiescent
 * local-deadline failures can be absorbed.
 *
 * @param error - executor or validator rejection.
 * @param signal - logical invocation signal; the local role deadline is classified only after disposal succeeds.
 * @returns the failure class and model-safe reason when a fallback is allowed.
 */
export function fallbackRoleAttempt(error: unknown, signal: AbortSignal): { failureClass: RoleFailureClass; fallbackReason: string } | undefined {
  if (signal.aborted || isAbortError(error)) return undefined
  if (!(error instanceof RoleInvocationError) || !error.fallbackable) return undefined
  if (!['PROVIDER_REQUEST_FAILURE', 'ROUTE_EXECUTION_FAILURE', 'MISSING_STRUCTURED_OUTPUT', 'SCHEMA_INVALID', 'MODEL_MALFORMED_OUTPUT', 'ROLE_TIMEOUT_QUIESCENT', 'POLICY_REFUSED'].includes(error.failureClass)) return undefined
  return { failureClass: error.failureClass, fallbackReason: error.message.slice(0, 1000) }
}

/** Narrow an abort-style rejection without confusing it with provider failure. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/**
 * Prevent another role attempt after a potentially mutating tool dispatch.
 * @param error - settled attempt failure after child cleanup.
 * @returns a non-fallbackable classified failure, preserving unclassified errors.
 */
export function roleFailureAfterMutation(error: unknown): unknown {
  if (error instanceof CapabilityInsufficientError) {
    return new RoleInvocationError(`${error.message} Capability escalation is disabled because this attempt dispatched a potentially mutating tool.`, 'NON_FALLBACKABLE', false, { cause: error })
  }
  if (!(error instanceof RoleInvocationError) || !error.fallbackable) return error
  return new RoleInvocationError(`${error.message} Fallback is disabled because this attempt dispatched a potentially mutating tool.`, 'NON_FALLBACKABLE', false, { cause: error })
}

/** Inputs shared by Development and Review-only route attempts. */
export interface RoleAttemptsOptions<T> {
  role: EngineeringRole
  attempts: readonly ResolvedRoleRoute[]
  signal: AbortSignal
  executeAttempt: (route: ResolvedRoleRoute, attemptIndex: number, markMutationStarted: () => void, dispatch?: { mode: RoleAttemptRecord['mode']; escalationId?: SchedulingEscalationId; onReservedAttempt?: (attemptId: string) => Promise<void> }) => Promise<unknown>
  validateOutput: (value: unknown) => T
  persistAttempts: (records: RoleAttemptRecord[]) => Promise<void>
  primary?: { startedAt: string; execution: Promise<unknown>; mutation: { started: boolean } }
  escalationCandidates?: readonly ResolvedRoleRoute[]
  escalationFallbackCandidates?: readonly ResolvedRoleRoute[]
  onEscalate?: (error: CapabilityInsufficientError, failedRoute: ResolvedRoleRoute, failedAttemptIndex: number) => Promise<{ escalationId: SchedulingEscalationId }>
  beforeEscalationDispatch?: (escalationId: SchedulingEscalationId, attemptId: string) => Promise<void>
  onEscalationSettled?: (escalationId: SchedulingEscalationId, result: { output?: unknown; error?: unknown }) => Promise<void>
  atAttempt?: (routeId: string, attemptIndex: number) => void
  /** Already reserved diagnosis; its owner performs dispatch CAS and settlement. */
  initialEscalationId?: SchedulingEscalationId
}

/**
 * Execute configured routes only after the preceding child has settled and stopped.
 * @param options - route dispatch, validation, mutation observation and durable audit owners.
 * @returns the first valid output; rejects after unsafe failure or exhausted routes.
 */
export async function runRoleAttempts<T>(options: RoleAttemptsOptions<T>): Promise<T> {
  const records: RoleAttemptRecord[] = []
  let quiescenceError: RoleQuiescenceError | undefined
  try {
    for (const [index, route] of options.attempts.entries()) {
      const attemptIndex = index + 1
      const primary = index === 0 ? options.primary : undefined
      if (primary === undefined) options.signal.throwIfAborted()
      const startedAt = primary?.startedAt ?? new Date().toISOString()
      const mutation = primary?.mutation ?? { started: false }
      options.atAttempt?.(route.routeId, attemptIndex)
      const initialMode: RoleAttemptRecord['mode'] = options.initialEscalationId === undefined
        ? (index === 0 ? 'PRIMARY' : 'FALLBACK')
        : (index === 0 ? 'ESCALATE' : 'FALLBACK')
      try {
        const value = await (primary?.execution ?? options.executeAttempt(route, attemptIndex, () => { mutation.started = true }, options.initialEscalationId === undefined ? undefined : { mode: initialMode, escalationId: options.initialEscalationId }))
        options.signal.throwIfAborted()
        const output = options.validateOutput(value)
        records.push({ role: options.role, attemptIndex, mode: initialMode, ...(options.initialEscalationId === undefined ? {} : { escalationId: options.initialEscalationId, ...(initialMode === 'FALLBACK' ? { parentEscalationId: options.initialEscalationId } : {}) }), routeId: route.routeId, provider: route.provider, model: route.model,
          reasoningEffort: route.reasoningEffort, startedAt, endedAt: new Date().toISOString(), outcome: 'SUCCESS' })
        return output
      } catch (caught) {
        if (caught instanceof CapabilityInsufficientError) {
          const capabilityError = new CapabilityInsufficientError(caught.reason, caught.details, caught.partial, route.routeId, attemptIndex)
          records.push({ role: options.role, attemptIndex, mode: initialMode, ...(options.initialEscalationId === undefined ? {} : { escalationId: options.initialEscalationId, ...(initialMode === 'FALLBACK' ? { parentEscalationId: options.initialEscalationId } : {}) }), routeId: route.routeId, provider: route.provider, model: route.model,
            reasoningEffort: route.reasoningEffort, startedAt, endedAt: new Date().toISOString(), outcome: 'FAILED', failureClass: 'NON_FALLBACKABLE', fallbackReason: caught.details.slice(0, 1000) })
          if (options.signal.aborted) options.signal.throwIfAborted()
          if (options.role === 'implementer') throw capabilityError
          if (mutation.started) throw roleFailureAfterMutation(capabilityError)
          if (options.onEscalate === undefined || options.escalationCandidates?.length === 0 || options.escalationCandidates === undefined) throw capabilityError
          const routes = [
            ...options.escalationCandidates.filter(candidate => candidate.capabilityLevel > route.capabilityLevel),
            ...(options.escalationFallbackCandidates ?? []).filter(candidate => candidate.capabilityLevel > route.capabilityLevel),
          ]
          if (routes.length === 0) throw capabilityError
          const { escalationId } = await options.onEscalate(capabilityError, route, attemptIndex)
          let escalationOutput: unknown
          try {
            for (const [escalationIndex, escalationRoute] of routes.entries()) {
              options.signal.throwIfAborted()
              const physicalIndex = records.length + 1
              options.atAttempt?.(escalationRoute.routeId, physicalIndex)
              const mode = escalationIndex === 0 ? 'ESCALATE' : 'FALLBACK'
              const escalationStartedAt = new Date().toISOString()
              const escalationMutation = { started: false }
              try {
                const value = await options.executeAttempt(escalationRoute, physicalIndex, () => { escalationMutation.started = true }, {
                  mode,
                  escalationId,
                  ...(escalationIndex === 0 && options.beforeEscalationDispatch !== undefined
                    ? { onReservedAttempt: attemptId => options.beforeEscalationDispatch?.(escalationId, attemptId) ?? Promise.resolve() }
                    : {}),
                })
                options.signal.throwIfAborted()
                escalationOutput = options.validateOutput(value)
                records.push({ role: options.role, attemptIndex: physicalIndex, mode, escalationId,
                  ...(mode === 'FALLBACK' ? { parentEscalationId: escalationId } : {}), routeId: escalationRoute.routeId,
                  provider: escalationRoute.provider, model: escalationRoute.model, reasoningEffort: escalationRoute.reasoningEffort,
                  startedAt: escalationStartedAt, endedAt: new Date().toISOString(), outcome: 'SUCCESS' })
                break
              } catch (error) {
                const settledError = escalationMutation.started ? roleFailureAfterMutation(error) : error
                records.push({ role: options.role, attemptIndex: physicalIndex, mode, escalationId,
                  ...(mode === 'FALLBACK' ? { parentEscalationId: escalationId } : {}), routeId: escalationRoute.routeId,
                  provider: escalationRoute.provider, model: escalationRoute.model, reasoningEffort: escalationRoute.reasoningEffort,
                  startedAt: escalationStartedAt, endedAt: new Date().toISOString(), outcome: 'FAILED',
                  failureClass: settledError instanceof RoleInvocationError ? settledError.failureClass : 'NON_FALLBACKABLE',
                  fallbackReason: (settledError instanceof Error ? settledError.message : String(settledError)).slice(0, 1000) })
                if (settledError instanceof RoleQuiescenceError) quiescenceError = settledError
                if (escalationMutation.started || settledError instanceof RoleQuiescenceError
                  || fallbackRoleAttempt(settledError, options.signal) === undefined || escalationIndex + 1 >= routes.length) throw settledError
              }
            }
          } catch (error) {
            try {
              await options.onEscalationSettled?.(escalationId, { error })
            } catch (settlementError) {
              if (error instanceof RoleQuiescenceError) {
                const combined = new RoleQuiescenceError(error.message, {
                  cause: new AggregateError([error, settlementError], 'Role quiescence and escalation settlement failed'),
                })
                quiescenceError = combined
                throw combined
              }
              if (settlementError instanceof RoleQuiescenceError) quiescenceError = settlementError
              throw settlementError
            }
            throw error
          }
          try {
            await options.onEscalationSettled?.(escalationId, { output: escalationOutput })
          } catch (settlementError) {
            if (settlementError instanceof RoleQuiescenceError) quiescenceError = settlementError
            throw settlementError
          }
          return escalationOutput as T
        }
        const error = mutation.started ? roleFailureAfterMutation(caught) : caught
        const fallback = fallbackRoleAttempt(error, options.signal)
        records.push({ role: options.role, attemptIndex, mode: initialMode, ...(options.initialEscalationId === undefined ? {} : { escalationId: options.initialEscalationId, ...(initialMode === 'FALLBACK' ? { parentEscalationId: options.initialEscalationId } : {}) }), routeId: route.routeId, provider: route.provider, model: route.model,
          reasoningEffort: route.reasoningEffort, startedAt, endedAt: new Date().toISOString(), outcome: 'FAILED',
          failureClass: fallback?.failureClass ?? (error instanceof RoleInvocationError ? error.failureClass : 'NON_FALLBACKABLE'),
          fallbackReason: fallback?.fallbackReason ?? (error instanceof Error ? error.message : String(error)).slice(0, 1000) })
        if (fallback !== undefined && attemptIndex < options.attempts.length) continue
        if (error instanceof RoleQuiescenceError) quiescenceError = error
        throw error
      }
    }
    throw new Error(`role ${options.role} exhausted its configured dispatch routes`)
  } finally {
    try {
      await options.persistAttempts(records)
    } catch (error) {
      if (quiescenceError === undefined) throw error
      throw new RoleQuiescenceError(quiescenceError.message, {
        cause: new AggregateError([quiescenceError, error], 'Role quiescence and attempt audit persistence failed'),
      })
    }
  }
}
