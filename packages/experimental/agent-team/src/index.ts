/** Agent Teams service façade over roster, messaging, task, and runtime lifecycle owners. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { steerHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { TeamAdmission } from './admission.ts'
import { TeamActivity } from './activity.ts'
import { TeamCompletionGate } from './completion.ts'
import { errorMessage, TeamError } from './error.ts'
import { TeamJournal } from './journal.ts'
import { TeamRuntimeLifecycle } from './lifecycle.ts'
import { teamProjectionDefinition } from './projection.ts'
import { resolveActiveMember, TeamRoster } from './roster.ts'
import type { TeamMembership } from './roster.ts'
import { TeamTaskBoard } from './task-board.ts'
import { RoleId, TeamId, TeamTaskId } from './types.ts'
import type {
  TeamTaskCompletionPolicy,
  TeamTaskCompletionPolicyOptions,
} from './completion.ts'
import type {
  Config,
  RoleSpec,
  TeamSlotPlan,
  CreateTeamTaskRequest,
  SendTeamMessageRequest,
  SendTeamMessageResult,
  SpawnTeammateRequest,
  SpawnTeammateResult,
  TeamMemberView,
  TeamTaskView,
  TeamWaitResult,
  UpdateTeamTaskRequest,
} from './types.ts'

export type * from './types.ts'
export type {
  TeamTaskCompletionAttempt,
  TeamTaskCompletionDecision,
  TeamTaskCompletionEvidence,
  TeamTaskCompletionPolicy,
  TeamTaskCompletionPolicyOptions,
  TeamTaskCompletionReceipt,
  TeamTaskCompletionRejection,
  TeamTaskCompletionRequirement,
  TeamTaskCompletionAcceptance,
} from './completion.ts'
export type { TeamMembership } from './roster.ts'
export { RoleId, TeamId, TeamMessageId, TeamTaskId } from './types.ts'
export { TeamError } from './error.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeams: TeamService
  }
}

/** Default business roles and their complete model routes. */
export const DEFAULT_ROLES: readonly RoleSpec[] = [
  { id: RoleId('architect'), description: 'Architecture and design', provider: 'magpie', model: 'codex/gpt-6.1-sol', maxConcurrent: 1 },
  { id: RoleId('explorer'), description: 'Explore and research', provider: 'corp', model: 'Qwen3.8-Flash', maxConcurrent: 2 },
  { id: RoleId('implementer'), description: 'Implement changes', provider: 'corp', model: 'DeepSeek-V4.1-Flash-1017', maxConcurrent: 2 },
  { id: RoleId('reviewer'), description: 'Review changes', provider: 'corp', model: 'GLM-5.3-Flash', maxConcurrent: 1 },
  { id: RoleId('challenger'), description: 'Challenge assumptions', provider: 'magpie', model: 'codex/gpt-6.1-sol', maxConcurrent: 1 },
  { id: RoleId('validator'), description: 'Validate outcomes', provider: 'magpie', model: 'auto/mimo-v2.6-flash', maxConcurrent: 1 },
]

/** Four retained core positions and four reusable flexible positions. */
export const DEFAULT_SLOT_PLAN: TeamSlotPlan = {
  reserved: ['architect', 'reviewer', 'explorer', 'implementer'].map(id => ({ id, roleId: RoleId(id) })),
  flex: ['flex-1', 'flex-2', 'flex-3', 'flex-4'],
}
const DEFAULT_MAX_MEMBERS = 8
const DEFAULT_MEMBER_IDLE_GRACE_MS = 60_000
const DEFAULT_MAX_TASKS = 256
const DEFAULT_MAX_MESSAGE_BYTES = 65_536
const DEFAULT_DISPOSAL_TIMEOUT_MS = 5_000

/** Validate one positive safe-integer deployment limit. */
function positiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TeamError(`${name} must be a positive safe integer`, 'TEAM_INVALID_CONFIG')
  }
  return value
}

/** Agent Teams service backed by the exact live Lead Session log. */
export class TeamService extends Service {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'subagents']

  static Config: z<Config> = z.object({
    roles: z.array(z.object({
      id: z.transform(z.string(), RoleId), description: z.string(), provider: z.string(), model: z.string(),
      maxTokens: z.number().step(1).min(1), maxConcurrent: z.number().step(1).min(1), persona: z.string(),
    })).default([...DEFAULT_ROLES]),
    slotPlan: z.object({
      reserved: z.array(z.object({ id: z.string(), roleId: z.transform(z.string(), RoleId) })),
      flex: z.array(z.string()),
    }).default({ reserved: [...DEFAULT_SLOT_PLAN.reserved], flex: [...DEFAULT_SLOT_PLAN.flex] }),
    memberIdleGraceMs: z.number().step(1).min(0).default(DEFAULT_MEMBER_IDLE_GRACE_MS),
    maxMembers: z.number().step(1).min(1).default(DEFAULT_MAX_MEMBERS),
    maxTasks: z.number().step(1).min(1).default(DEFAULT_MAX_TASKS),
    maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
    disposalTimeoutMs: z.number().step(1).min(1).default(DEFAULT_DISPOSAL_TIMEOUT_MS),
  }) as z<Config>

  /** Validated deployment limits used by every Team operation. */
  private readonly config: Required<Config>
  private readonly admission = new TeamAdmission()

  private readonly activity: TeamActivity
  private readonly completion: TeamCompletionGate
  private readonly lifecycle: TeamRuntimeLifecycle
  private readonly journal: TeamJournal
  private readonly roster: TeamRoster
  private readonly tasks: TeamTaskBoard

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentTeams')
    this.config = {
      roles: structuredClone(config.roles ?? DEFAULT_ROLES),
      slotPlan: structuredClone(config.slotPlan ?? DEFAULT_SLOT_PLAN),
      memberIdleGraceMs: config.memberIdleGraceMs ?? DEFAULT_MEMBER_IDLE_GRACE_MS,
      maxMembers: positiveLimit('maxMembers', config.maxMembers ?? DEFAULT_MAX_MEMBERS),
      maxTasks: positiveLimit('maxTasks', config.maxTasks ?? DEFAULT_MAX_TASKS),
      maxMessageBytes: positiveLimit('maxMessageBytes', config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES),
      disposalTimeoutMs: positiveLimit(
        'disposalTimeoutMs',
        config.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS,
      ),
    }

    this.validateTopology()
    this.activity = new TeamActivity()
    this.lifecycle = new TeamRuntimeLifecycle(this.config.disposalTimeoutMs)
    this.completion = new TeamCompletionGate({ signal: this.lifecycle.signal })
    this.journal = new TeamJournal(ctx, (root) => { this.activity.notify(TeamId(root.id)) })
    this.roster = new TeamRoster(ctx, this.journal, this.lifecycle, this.config, this.admission)
    this.tasks = new TeamTaskBoard(this.journal, this.config.maxTasks, this.completion)

    ctx.on('agent/created', ({ agent }) => { this.scheduleRecovery(agent) })
    ctx.on('agent/status', ({ agent }) => {
      this.roster.observeStatus(agent)
      const membership = this.roster.tryMembership(agent)
      if (membership !== undefined) this.activity.notify(membership.id)
    })
    ctx.effect(() => {
      const disposeProjection = ctx.root.sessionProjections.register(teamProjectionDefinition)
      return async () => {
        try {
          await this.disposeRuntime()
        } finally {
          disposeProjection()
        }
      }
    }, 'agentTeams.runtimeLifecycle()')
    for (const agent of ctx.agents.list()) this.scheduleRecovery(agent)
  }

  /**
   * Resolve one exact live Agent's Team role.
   * @param agent - exact live Agent used as the authority credential.
   * @returns its root, Team identity, role, and model-facing name.
   */
  membership(agent: Agent): TeamMembership {
    return this.roster.membership(agent)
  }

  /**
   * List the runtime-enriched roster visible to one Team member.
   * @param agent - exact live Team member.
   * @returns Lead and teammate rows in creation order.
   */
  listMembers(agent: Agent): TeamMemberView[] {
    return this.roster.list(this.roster.membership(agent))
  }

  /**
   * Create a role-bound continuation with a generated slot and generation identity.
   * @param caller - exact live Lead Agent.
   * @param request - Role, task content, context mode, optional slot, and cancellation.
   * @returns the active roster row.
   */
  async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult> {
    return await this.roster.spawn(caller, request)
  }

  /**
   * Drain and permanently retire one active or failed teammate.
   * @param caller - Exact live Team Lead.
   * @param target - Generated member name.
   * @returns The retired member view.
   */
  async retireTeammate(caller: Agent, target: string): Promise<TeamMemberView> {
    return await this.roster.retire(caller, target)
  }

  /**
   * Steer one peer message into the target inbox or reject the attempt.
   * @param caller - exact live sending Team member.
   * @param request - target name, content, and cancellation before acceptance.
   * @returns accepted inbox identity; acceptance follows normal Agent persistence and does not await model processing.
   */
  async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult> {
    if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    return await this.lifecycle.track(this.admission.run(this.roster.membership(caller).root.id, async () => this.sendAdmitted(caller, {
      ...request,
      signal: AbortSignal.any([request.signal, this.lifecycle.signal]),
    })))
  }

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param caller - exact live Team member creating the task.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    return await this.tasks.create(this.roster.membership(caller), request)
  }

  /**
   * Return one task, including a deleted tombstone.
   * @param caller - exact live Team member reading the task.
   * @param id - Team-local task identity.
   * @returns the latest task value and derived readiness diagnostics.
   */
  getTask(caller: Agent, id: TeamTaskId): TeamTaskView {
    return this.tasks.get(this.roster.membership(caller), id)
  }

  /**
   * List current non-deleted tasks in numeric creation order.
   * @param caller - exact live Team member reading the board.
   * @returns detached current task views.
   */
  listTasks(caller: Agent): TeamTaskView[] {
    return this.tasks.list(this.roster.membership(caller))
  }

  /**
   * Compare-and-set one authorized task transition.
   * @param caller - exact live Team member authorizing the mutation.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed next task revision.
   */
  async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView> {
    const operation = async (): Promise<TeamTaskView> => {
      const membership = this.roster.membership(caller)
      return await this.tasks.update(caller, membership, request)
    }
    if (request.action === 'claim' || request.action === 'reassign') {
      return await this.admission.run(this.roster.membership(caller).root.id, operation)
    }
    return await operation()
  }

  /**
   * Register one generic completion policy for every shared task in this Team
   * service that declares completion requirements. Registration is independent
   * of any external product: the policy receives only the declared requirements,
   * the offered evidence references, and a bounded cancellation signal.
   * @param policy - named policy consulted before a requirement-bearing task may complete.
   * @param options - per-policy timeout; the default is thirty seconds.
   * @returns an idempotent disposer that unregisters this policy.
   */
  registerCompletionPolicy(
    policy: TeamTaskCompletionPolicy,
    options: TeamTaskCompletionPolicyOptions = {},
  ): () => void {
    if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    return this.completion.register(policy, options)
  }

  /**
   * Wait for the next Team-domain or member-status change.
   * @param caller - exact live Team member waiting for activity.
   * @param timeoutMs - bounded wait duration from ten seconds through one hour.
   * @param signal - caller cancellation for the wait only.
   * @returns one observed change or a timeout result.
   */
  async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    const membership = this.roster.membership(caller)
    return await this.activity.wait(membership.id, timeoutMs, signal)
  }

  /**
   * Interrupt one live teammate turn without clearing its pending inbox.
   * @param caller - exact live Lead Agent.
   * @param targetName - durable teammate name.
   * @returns the target status sampled before cancellation.
   */
  interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'inactive' } {
    return this.roster.interrupt(caller, targetName)
  }

  /**
   * Resolve a caller without throwing, used by scoped-tool installation and observers.
   * @param agent - candidate exact live Agent.
   * @returns Team membership, or undefined for non-Team subagents and stale identities.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    return this.roster.tryMembership(agent)
  }

  /** Deliver an admitted send using the Lead's authority and the actual sender's identity. */
  private async sendAdmitted(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult> {
    const membership = this.roster.membership(caller)
    request.signal.throwIfAborted()
    const { root } = membership
    const state = this.journal.state(root)
    const target = resolveActiveMember(root, state, request.target)
    if (request.expectedRole !== undefined) {
      const actual = state.members.find(member => member.id === target.id)?.roleId
      if (actual !== request.expectedRole) {
        throw new TeamError(
          `message target "${target.name}" is role "${actual ?? 'unassigned'}", expected "${request.expectedRole}"`,
          'TEAM_ROLE_MISMATCH',
        )
      }
    }
    if (target.id === caller.id) throw new TeamError('a Team member cannot message itself', 'TEAM_SELF_MESSAGE')
    const content = [
      { type: 'text' as const, text: `Team message from ${membership.name}:` },
      ...structuredClone(request.content),
    ]
    if (Buffer.byteLength(JSON.stringify(content), 'utf8') > this.config.maxMessageBytes) {
      throw new TeamError(`team message exceeds ${this.config.maxMessageBytes} bytes`, 'TEAM_MESSAGE_TOO_LARGE')
    }
    const source = { kind: 'agent-message' as const, form: 'relay' as const, senderSessionId: caller.id }
    let messageId
    if (target.id === root.id) {
      const input = createUserMessage({ content, source })
      root.steer(input)
      messageId = input.id
    } else {
      messageId = await steerHostSubagentPrompt(this.ctx.subagents, root, target.id, content, source, request.signal)
    }
    this.roster.touch(target.id)
    this.activity.notify(membership.id)
    return { messageId }
  }

  private validateTopology(): void {
    const { roles, slotPlan, maxMembers, memberIdleGraceMs } = this.config
    if (!Number.isSafeInteger(memberIdleGraceMs) || memberIdleGraceMs < 0) {
      throw new TeamError('memberIdleGraceMs must be a nonnegative safe integer', 'TEAM_INVALID_CONFIG')
    }
    const ids = new Set<string>()
    for (const role of roles) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(role.id) || role.id === 'lead' || ids.has(role.id)
        || !role.description.trim() || !role.provider.trim() || !role.model.trim()) {
        throw new TeamError('roles require unique identities, descriptions, and complete routes', 'TEAM_INVALID_CONFIG')
      }
      ids.add(role.id)
      positiveLimit('maxConcurrent', role.maxConcurrent)
      if (role.maxTokens !== undefined) positiveLimit('maxTokens', role.maxTokens)
    }
    const slots = [...slotPlan.reserved.map(slot => slot.id), ...slotPlan.flex]
    if (slots.length > maxMembers || new Set(slots).size !== slots.length
      || slots.some(id => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) || id.length > 44)
      || slotPlan.reserved.some(slot => !ids.has(slot.roleId))) {
      throw new TeamError('slotPlan requires unique valid slots, declared reserved roles, and capacity <= maxMembers', 'TEAM_INVALID_CONFIG')
    }
  }

  /** Queue one contained provisioning reconciliation after publication has unwound. */
  private scheduleRecovery(agent: Agent): void {
    queueMicrotask(() => {
      if (this.lifecycle.disposed) return
      void this.roster.recoverFor(agent, this.lifecycle.signal).catch((error: unknown) => {
        if (this.lifecycle.disposed) return
        this.ctx.logger.warn(`Agent Teams recovery for "${agent.id}" failed: ${errorMessage(error)}`)
      })
    })
  }

  /** Stop Team-owned live branches and release every waiter before service disposal completes. */
  private async disposeRuntime(): Promise<void> {
    this.lifecycle.close()
    this.activity.close()

    const failures: unknown[] = []
    await this.lifecycle.settle(this.lifecycle.pending(), failures)
    for (const [root, childIds] of this.roster.liveChildrenByRoot()) {
      try {
        await this.roster.stopTeammates(root, childIds)
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Agent Teams runtime disposal failed')
  }
}

export default TeamService
