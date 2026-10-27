/** Generic, product-independent completion requirements and policy gate for shared Team tasks. */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { errorMessage, TeamError } from './error.ts'
import type { TeamId, TeamTaskId } from './types.ts'
import { requiredText } from './validation.ts'

const DEFAULT_POLICY_TIMEOUT_MS = 30_000
const payloadSchema = z.json()

/**
 * Opaque lossless-JSON requirement payload. The Team domain never interprets
 * it; only the completion policy that owns the requirement `kind` may.
 */
export type TeamTaskCompletionPayload =
  | null
  | boolean
  | number
  | string
  | TeamTaskCompletionPayload[]
  | { [key: string]: TeamTaskCompletionPayload }

/**
 * One explicit completion requirement declared at task creation. `key` is a
 * policy-owned stable identity used to bind evidence to the requirement;
 * `kind` selects the policy's validator and `payload` carries its parameters.
 */
export interface TeamTaskCompletionRequirement {
  readonly key: string
  readonly kind: string
  readonly payload: TeamTaskCompletionPayload
}

/** One opaque evidence reference supplied by the caller at completion time. */
export interface TeamTaskCompletionEvidence {
  /** Key of the declared requirement this reference is offered for. */
  readonly key: string
  /** Policy-interpreted evidence handle, for example an external run id. */
  readonly reference: string
}

/** Acceptance verdict from one completion policy. */
export interface TeamTaskCompletionAcceptance {
  readonly outcome: 'accepted'
}

/** Rejection verdict from one completion policy, carrying a model-facing reason. */
export interface TeamTaskCompletionRejection {
  readonly outcome: 'rejected'
  /** Stable failure code; defaults to `TEAM_TASK_COMPLETION_REJECTED`. */
  readonly code?: string
  /** Clear human-readable reason for the refusal. */
  readonly message: string
}

/** One policy verdict; rejection never commits a completed task. */
export type TeamTaskCompletionDecision = TeamTaskCompletionAcceptance | TeamTaskCompletionRejection

/** Complete read-only view of one completion attempt presented to a policy. */
export interface TeamTaskCompletionAttempt {
  readonly teamId: TeamId
  readonly taskId: TeamTaskId
  /** Exact task revision the policy is deciding on. */
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly requirements: readonly TeamTaskCompletionRequirement[]
  /** SHA-256 over the canonical requirement set, rechecked at commit time. */
  readonly requirementsDigest: string
  readonly evidence: readonly TeamTaskCompletionEvidence[]
  readonly callerId: SessionId
  readonly callerName: string
  /** Aborted when this attempt exceeds its timeout or the Team runtime disposes. */
  readonly signal: AbortSignal
}

/**
 * One registered completion policy. A task that declares completion
 * requirements may only complete when every registered policy accepts.
 */
export interface TeamTaskCompletionPolicy {
  /** Stable policy name recorded on the completion receipt. */
  readonly name: string
  /**
   * Decide one completion attempt.
   * @param attempt - declarative requirements, offered evidence, and cancellation.
   * @returns the verdict; a rejection refuses the completion.
   */
  evaluate(attempt: TeamTaskCompletionAttempt): Promise<TeamTaskCompletionDecision> | TeamTaskCompletionDecision
}

/** Per-registration policy limits. */
export interface TeamTaskCompletionPolicyOptions {
  /** Milliseconds allowed for one verdict. Defaults to 30000. */
  readonly timeoutMs?: number
}

/** Durable record of the policy check that accepted one completion. */
export interface TeamTaskCompletionReceipt {
  /** Registered policy names that accepted, in registration order. */
  readonly policy: string
  readonly requirementsDigest: string
  readonly evidence: TeamTaskCompletionEvidence[]
  /** Exact revision the accepting policies evaluated. */
  readonly acceptedRevision: number
}

/** Cancellation source owned by the Team runtime. */
export interface TeamTaskCompletionLifetime {
  readonly signal: AbortSignal
}

/**
 * Normalize one declared requirement set and reject malformed requests.
 * @param values - caller-declared completion requirements.
 * @returns detached validated requirements in declaration order.
 */
export function normalizeCompletionRequirements(
  values: readonly TeamTaskCompletionRequirement[],
): TeamTaskCompletionRequirement[] {
  const keys = new Set<string>()
  return values.map((value) => {
    const key = requiredText(value.key, 'completion requirement key', 120)
    const kind = requiredText(value.kind, 'completion requirement kind', 120)
    if (keys.has(key)) {
      throw new TeamError(`duplicate completion requirement key ${JSON.stringify(key)}`, 'TEAM_INVALID_ARGUMENT')
    }
    keys.add(key)
    if (!payloadSchema.safeParse(value.payload).success) {
      throw new TeamError(
        `completion requirement ${JSON.stringify(key)} payload must be lossless JSON`,
        'TEAM_INVALID_ARGUMENT',
      )
    }
    return { key, kind, payload: value.payload }
  })
}

/**
 * Normalize one evidence set and reject malformed requests.
 * @param values - caller-supplied completion evidence references.
 * @returns detached validated evidence references in supplied order.
 */
export function normalizeCompletionEvidence(
  values: readonly TeamTaskCompletionEvidence[],
): TeamTaskCompletionEvidence[] {
  return values.map(value => ({
    key: requiredText(value.key, 'completion evidence key', 120),
    reference: requiredText(value.reference, 'completion evidence reference', 2_048),
  }))
}

/**
 * Reject evidence that names an undeclared requirement or repeats a key.
 * @param requirements - requirements declared on the task.
 * @param evidence - normalized evidence references.
 * @throws {TeamError} when a reference has no declared requirement or repeats.
 */
export function assertCompletionEvidence(
  requirements: readonly TeamTaskCompletionRequirement[],
  evidence: readonly TeamTaskCompletionEvidence[],
): void {
  const declared = new Set(requirements.map(requirement => requirement.key))
  const seen = new Set<string>()
  for (const entry of evidence) {
    if (!declared.has(entry.key)) {
      throw new TeamError(
        `completion evidence references undeclared requirement ${JSON.stringify(entry.key)}`,
        'TEAM_INVALID_ARGUMENT',
      )
    }
    if (seen.has(entry.key)) {
      throw new TeamError(
        `duplicate completion evidence for requirement ${JSON.stringify(entry.key)}`,
        'TEAM_INVALID_ARGUMENT',
      )
    }
    seen.add(entry.key)
  }
}

/** Serialize one payload with object keys sorted, so equal payloads hash equally. */
function canonicalJson(value: TeamTaskCompletionPayload): string {
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry)).join(',')}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

/**
 * Compute the stable digest of one declared requirement set.
 * @param requirements - normalized completion requirements.
 * @returns lowercase hex SHA-256 over the canonical requirement set.
 */
export function completionRequirementsDigest(
  requirements: readonly TeamTaskCompletionRequirement[],
): string {
  const canonical = requirements.map(entry => [entry.key, entry.kind, canonicalJson(entry.payload)])
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** Requirement facts needed to authorize one completion, without durable state. */
export interface TeamTaskCompletionRequest {
  readonly teamId: TeamId
  readonly taskId: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly requirements: readonly TeamTaskCompletionRequirement[]
  readonly evidence: readonly TeamTaskCompletionEvidence[]
  readonly callerId: SessionId
  readonly callerName: string
}

/** Owns the registered completion policies and their bounded execution. */
export class TeamCompletionGate {
  private readonly registered: Array<{
    readonly policy: TeamTaskCompletionPolicy
    readonly timeoutMs: number
  }> = []

  /**
   * @param lifetime - Team runtime cancellation source observed by every attempt.
   */
  constructor(private readonly lifetime: TeamTaskCompletionLifetime) {}

  /**
   * Register one completion policy.
   * @param policy - policy receiving every attempted completion.
   * @param options - per-policy timeout; the default is thirty seconds.
   * @returns an idempotent disposer that unregisters this policy.
   */
  register(policy: TeamTaskCompletionPolicy, options: TeamTaskCompletionPolicyOptions = {}): () => void {
    if (typeof policy.name !== 'string' || policy.name.trim().length === 0) {
      throw new TeamError('completion policy name must be non-empty', 'TEAM_INVALID_ARGUMENT')
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_POLICY_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TeamError('completion policy timeoutMs must be a positive safe integer', 'TEAM_INVALID_ARGUMENT')
    }
    const entry = { policy, timeoutMs }
    this.registered.push(entry)
    return () => {
      const index = this.registered.indexOf(entry)
      if (index >= 0) this.registered.splice(index, 1)
    }
  }

  /**
   * Run every registered policy over one completion attempt.
   * @param request - task revision, declared requirements, evidence, and caller.
   * @returns the durable receipt to record on the completed task.
   * @throws {TeamError} when no policy is registered, a policy rejects, a policy
   * fails, or a policy exceeds its timeout.
   */
  async authorize(request: TeamTaskCompletionRequest): Promise<TeamTaskCompletionReceipt> {
    const policies = [...this.registered]
    if (policies.length === 0) {
      throw new TeamError(
        `team task "${request.taskId}" declares ${request.requirements.length} completion requirement(s) but no completion policy is registered`,
        'TEAM_TASK_COMPLETION_UNAVAILABLE',
      )
    }
    assertCompletionEvidence(request.requirements, request.evidence)
    const requirementsDigest = completionRequirementsDigest(request.requirements)
    const names: string[] = []
    for (const entry of policies) {
      const decision = await this.run(entry, { ...request, requirementsDigest })
      if (decision.outcome === 'rejected') {
        throw new TeamError(
          `completion policy "${entry.policy.name}" rejected task "${request.taskId}": ${decision.message}`,
          decision.code ?? 'TEAM_TASK_COMPLETION_REJECTED',
        )
      }
      names.push(entry.policy.name)
    }
    return {
      policy: names.join(','),
      requirementsDigest,
      evidence: request.evidence.map(entry => ({ ...entry })),
      acceptedRevision: request.revision,
    }
  }

  /** Run one policy with its timeout and the Team runtime cancellation. */
  private async run(
    entry: { readonly policy: TeamTaskCompletionPolicy; readonly timeoutMs: number },
    request: TeamTaskCompletionRequest & { readonly requirementsDigest: string },
  ): Promise<TeamTaskCompletionDecision> {
    const controller = new AbortController()
    const attempt: TeamTaskCompletionAttempt = {
      teamId: request.teamId,
      taskId: request.taskId,
      revision: request.revision,
      subject: request.subject,
      description: request.description,
      requirements: request.requirements,
      requirementsDigest: request.requirementsDigest,
      evidence: request.evidence,
      callerId: request.callerId,
      callerName: request.callerName,
      signal: AbortSignal.any([controller.signal, this.lifetime.signal]),
    }
    let timer!: ReturnType<typeof setTimeout>
    // The policy observes the abort synchronously, so it may reject before the
    // race itself settles. The deadline marker keeps that rejection reported as
    // the timeout it actually is instead of a generic policy failure.
    const deadline = { exceeded: false }
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        deadline.exceeded = true
        controller.abort()
        reject(new TeamError(
          `completion policy "${entry.policy.name}" exceeded ${entry.timeoutMs}ms`,
          'TEAM_TASK_COMPLETION_TIMEOUT',
        ))
      }, entry.timeoutMs)
    })
    try {
      return await Promise.race([entry.policy.evaluate(attempt), timeout])
    } catch (error: unknown) {
      if (deadline.exceeded) {
        throw new TeamError(
          `completion policy "${entry.policy.name}" exceeded ${entry.timeoutMs}ms`,
          'TEAM_TASK_COMPLETION_TIMEOUT',
        )
      }
      throw this.policyFailure(entry.policy.name, error)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Preserve a policy's own Team failure code and wrap every other thrown value. */
  private policyFailure(name: string, error: unknown): TeamError {
    if (error instanceof TeamError) return error
    return new TeamError(
      `completion policy "${name}" failed: ${errorMessage(error)}`,
      'TEAM_TASK_COMPLETION_REJECTED',
      { cause: error },
    )
  }
}

/**
 * Enforce that a completed requirement-bearing task carries the acceptance
 * receipt a completion policy produced. A task without declared requirements
 * is unaffected, so every historical task keeps its exact meaning.
 * The durable log is the last line of defence: even a hand-edited or foreign
 * Team log cannot fabricate a completion that skipped the policy gate.
 * @param task - candidate task snapshot folded from one durable Team event.
 * @throws {Error} when a completed task declares requirements without the
 *   acceptance receipt that matches those exact requirements.
 */
export function assertCompletionAccepted(task: {
  readonly status: string
  readonly completionRequirements?: readonly TeamTaskCompletionRequirement[]
  readonly completion?: TeamTaskCompletionReceipt
}): void {
  const requirements = task.completionRequirements ?? []
  if (task.status !== 'completed' || requirements.length === 0) return
  const receipt = task.completion
  if (receipt === undefined) {
    throw new Error('a completed task that declares completion requirements must carry a policy acceptance receipt')
  }
  if (receipt.requirementsDigest !== completionRequirementsDigest(requirements)) {
    throw new Error('a completion acceptance receipt must match the declared completion requirements')
  }
}

/**
 * Enforce that a requirement set may only grow: an existing key must keep its
 * exact kind and payload, and no declared key may disappear. This is the
 * durable invariant behind "requirements can never be silently removed or
 * weakened", enforced by the projection on every committed revision.
 * @param prior - requirements declared by the previous revision.
 * @param next - requirements declared by the candidate revision.
 * @throws {Error} when the candidate drops or rewrites a declared requirement.
 */
export function assertCompletionRequirementsStrengthened(
  prior: readonly TeamTaskCompletionRequirement[],
  next: readonly TeamTaskCompletionRequirement[],
): void {
  if (prior.length === 0) return
  for (const declared of prior) {
    const candidate = next.find(entry => entry.key === declared.key)
    if (candidate === undefined) {
      throw new Error(`completion requirement "${declared.key}" was removed`)
    }
    if (candidate.kind !== declared.kind || canonicalJson(candidate.payload) !== canonicalJson(declared.payload)) {
      throw new Error(`completion requirement "${declared.key}" was weakened or rewritten`)
    }
  }
}
