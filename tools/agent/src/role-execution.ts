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
  if (!(error instanceof RoleInvocationError) || !error.fallbackable) return error
  return new RoleInvocationError(`${error.message} Fallback is disabled because this attempt dispatched a potentially mutating tool.`, 'NON_FALLBACKABLE', false, { cause: error })
}
