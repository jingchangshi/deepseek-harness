/** Public Agent Teams identities, durable records, and service request values. */

import type {
  TeamTaskCompletionEvidence,
  TeamTaskCompletionReceipt,
  TeamTaskCompletionRequirement,
} from './completion.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identifies the implicit team rooted at one top-level Session. */
export type TeamId = Branded<'TeamId'>

/**
 * Brand one root Session identity as its implicit Team identity.
 * @param id - Root Session identity.
 * @returns the same string branded as a Team identity.
 */
export function TeamId(id: SessionId | string): TeamId {
  return id as TeamId
}

/** Declared business role identity. */
export type RoleId = Branded<'RoleId'>

/** Brand a role registry key. @param id - Registry key. @returns Role identity. */
export function RoleId(id: string): RoleId { return id as RoleId }

/** Deployment-owned role route and concurrency limit. */
export interface RoleSpec {
  readonly id: RoleId
  readonly description: string
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly maxConcurrent: number
  readonly persona?: string
}

/** Stable capacity position; an absent member leaves the generation counter intact. */
export interface TeamSlotSnapshot {
  readonly id: string
  readonly roleId: RoleId | null
  readonly pinned: boolean
  readonly generation: number
  readonly memberId?: SessionId
}

/** Initial reserved positions and flexible capacity. */
export interface TeamSlotPlan {
  readonly reserved: readonly { readonly id: string; readonly roleId: RoleId }[]
  readonly flex: readonly string[]
}

/** Stable identifier for one task in a Team. */
export type TeamTaskId = Branded<'TeamTaskId'>

/**
 * Brand a validated task id.
 * @param id - Team-local task identity.
 * @returns the same string branded as a Team task identity.
 */
export function TeamTaskId(id: string): TeamTaskId {
  return id as TeamTaskId
}

/** Stable identifier for one durable peer message. */
export type TeamMessageId = Branded<'TeamMessageId'>

/**
 * Brand a generated peer-message id.
 * @param id - Durable mailbox message identity.
 * @returns the same string branded as a Team message identity.
 */
export function TeamMessageId(id: string): TeamMessageId {
  return id as TeamMessageId
}

/** Durable teammate lifecycle. */
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed' | 'retired'

/** Whole durable value written on every teammate lifecycle change. */
export interface TeamMemberSnapshot {
  readonly roleId: RoleId
  readonly slotId: string
  readonly generation: number
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly phase: TeamMemberPhase
  readonly error?: string
}

/** Current runtime-enriched roster row. */
export interface TeamMemberView {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly status: 'running' | 'inactive' | 'provisioning' | 'failed' | 'retired'
  readonly roleId?: RoleId
  readonly slotId?: string
  readonly generation?: number
  readonly description?: string
  readonly provider?: string
  readonly context?: 'fresh' | 'fork'
  readonly model?: string
  readonly diagnostics: string[]
}

/** Durable task lifecycle. */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** Whole durable task snapshot; every mutation increments {@link revision}. */
export interface TeamTaskSnapshot {
  readonly requiredRole?: RoleId
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  /**
   * Explicit declared completion requirements. Absent on ordinary tasks and on
   * every task persisted before this field existed, so those tasks behave
   * exactly as they did. When present and non-empty, this task may only
   * complete through a registered completion policy.
   */
  readonly completionRequirements?: TeamTaskCompletionRequirement[]
  /** Durable policy receipt recorded by the completion that this revision committed. */
  readonly completion?: TeamTaskCompletionReceipt
}

/** Runtime-enriched task view returned to tools and hosts. */
export interface TeamTaskView {
  readonly requiredRole?: RoleId
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  readonly ownerName?: string
  readonly ready: boolean
  readonly writeScopeWarnings: string[]
  /** Declared completion requirements, when this task declares any. */
  readonly completionRequirements?: TeamTaskCompletionRequirement[]
  /** Recorded acceptance receipt, only on a task completed through a policy. */
  readonly completion?: TeamTaskCompletionReceipt
}

/** One durable roster row published through the `agentTeam` Session projection. */
export interface TeamMemberProjection {
  readonly roleId?: RoleId
  readonly slotId?: string
  readonly generation?: number
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  /** Durable lifecycle; the Lead row is always `active`. Turn activity comes from Session status. */
  readonly phase: TeamMemberPhase
  readonly error?: string
}

/**
 * Durable Team state published to browser clients through the Lead Session's
 * `agentTeam` projection. `failure` names the first rejected persisted Team
 * record; members and tasks then stay at the last valid state.
 */
export interface TeamProjection {
  readonly slots: readonly TeamSlotSnapshot[]
  readonly members: TeamMemberProjection[]
  readonly tasks: TeamTaskView[]
  readonly failure?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Durable roster and non-deleted task board of the Team rooted at the projected Session. */
    agentTeam: TeamProjection
  }
}

/** One peer message recorded by the historical Team mailbox. */
export interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
}

/** Source recorded by a target Session for one historical Team mailbox delivery. */
export interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-message': TeamMessageSource
  }
}

/** Team-service deployment limits. */
export interface Config {
  readonly roles?: readonly RoleSpec[]
  readonly slotPlan?: TeamSlotPlan
  readonly memberIdleGraceMs?: number
  /** Maximum non-retired teammate instances admitted by one Team. */
  readonly maxMembers?: number
  /** Maximum non-deleted tasks retained by one Team. */
  readonly maxTasks?: number
  /** Maximum UTF-8 bytes in one complete sender-framed delivery. */
  readonly maxMessageBytes?: number
  /** Maximum milliseconds runtime disposal waits for shared work and child drains. */
  readonly disposalTimeoutMs?: number
}

/** Input for creating one durable teammate. */
export interface SpawnTeammateRequest {
  readonly roleId: RoleId
  readonly description?: string
  readonly task: ContentBlock[]
  readonly context: 'fresh' | 'fork'
  readonly slotId?: string
  readonly signal: AbortSignal
}

/** Result after one teammate reaches a durable active or failed edge. */
export interface SpawnTeammateResult {
  readonly member: TeamMemberView
}

/** Input for one direct peer-message attempt. */
export interface SendTeamMessageRequest {
  /** Assert the target's declared role before inbox acceptance; omitted permits ordinary cross-role communication. */
  readonly expectedRole?: RoleId
  readonly target: string
  readonly content: ContentBlock[]
  readonly signal: AbortSignal
}

/** Target inbox acceptance under ordinary Agent persistence; no Team retry or deduplication. */
export interface SendTeamMessageResult {
  readonly messageId: MessageId
}

/** Input for creating one shared task. */
export interface CreateTeamTaskRequest {
  readonly requiredRole?: RoleId
  readonly subject: string
  readonly description: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
  /**
   * Explicit, generic completion requirements declared with the task. A task
   * with any requirement may only complete through a registered completion
   * policy; a task without requirements keeps the historical behaviour.
   */
  readonly completionRequirements?: readonly TeamTaskCompletionRequirement[]
}

/** Supported task mutation actions. */
export type TeamTaskAction =
  | 'claim'
  | 'release'
  | 'edit'
  | 'set_dependencies'
  | 'complete'
  | 'reopen'
  | 'reassign'
  | 'delete'

/** Compare-and-set mutation of one shared task. */
export interface UpdateTeamTaskRequest {
  readonly taskId: TeamTaskId
  readonly expectedRevision: number
  readonly action: TeamTaskAction
  readonly subject?: string
  readonly description?: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
  readonly owner?: string
  /**
   * `edit`: replacement completion requirements. Requirements may only be added
   * or strengthened; dropping, weakening, or replacing a declared requirement is
   * refused. `complete`: offered evidence references for the declared requirements.
   */
  readonly completionRequirements?: readonly TeamTaskCompletionRequirement[]
  /** Evidence references offered by `complete`, one per declared requirement. */
  readonly evidence?: readonly TeamTaskCompletionEvidence[]
}

/** Result of waiting for Team activity. */
export interface TeamWaitResult {
  readonly timedOut: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole capacity slot value, stored only in the Team Lead Session. */
    'team/slot': { version: 1; teamId: TeamId; slot: TeamSlotSnapshot }
    /** Whole role-bound teammate lifecycle value, stored only in the Team Lead Session. */
    'team/member': { version: 4; teamId: TeamId; member: TeamMemberSnapshot }
    /** Whole shared-task value with optional required role and completion policy evidence. */
    'team/task': { version: 4; teamId: TeamId; task: TeamTaskSnapshot }
    /** Historical mailbox enqueue; new sends use the target Agent inbox. */
    'team/message/queued': { version: 2; teamId: TeamId; message: TeamMessageSnapshot }
    /** Historical acknowledgement that the target Session recorded a queued message. */
    'team/message/delivered': {
      version: 2
      teamId: TeamId
      messageId: TeamMessageId
      targetId: SessionId
    }
  }
}
