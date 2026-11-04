/** Team membership, continuable-child provisioning, and roster-owned teardown. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { errorMessage, TeamError } from './error.ts'
import type { TeamAdmission } from './admission.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamRuntimeLifecycle } from './lifecycle.ts'
import { readPersistedSession } from './persisted.ts'
import type { TeamState } from './projection.ts'
import { messageAccepted } from './session-message.ts'
import { TeamId } from './types.ts'
import type {
  Config,
  RoleSpec,
  TeamSlotSnapshot,
  SpawnTeammateRequest,
  SpawnTeammateResult,
  TeamMemberSnapshot,
  TeamMemberView,
} from './types.ts'
import { requiredText } from './validation.ts'

const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Caller identity inside one implicit Team. */
export interface TeamMembership {
  readonly root: Agent
  readonly id: TeamId
  readonly role: 'lead' | 'teammate'
  readonly name: string
}

/**
 * Resolve one active Team member by model-facing name, including the Lead pseudo-row.
 * @param root - exact live Team Lead.
 * @param state - current Team state.
 * @param rawName - candidate member name.
 * @returns resolved durable id and normalized name.
 */
export function resolveActiveMember(
  root: Agent,
  state: TeamState,
  rawName: string,
): { id: SessionId; name: string } {
  const name = rawName.trim()
  if (name === 'lead') return { id: root.id, name }
  const member = state.members.find(candidate => candidate.name === name)
  if (member === undefined || member.phase !== 'active') {
    throw new TeamError(`active teammate "${name}" not found`, 'TEAM_MEMBER_NOT_FOUND')
  }
  return { id: member.id, name }
}

/** Owns Team identities and the lifecycle of rostered continuable children. */
export class TeamRoster {
  private readonly idleSince = new Map<SessionId, number>()
  private readonly startedAt = Date.now()
  /**
   * @param ctx - Team service context with Agent, Session, persistence, and subagent services.
   * @param journal - authoritative Lead-log transaction owner.
   * @param lifecycle - shared Team runtime admission cutoff.
   * @param config - Resolved role registry, slot plan, capacity, and idle grace.
   * @param admission - Shared Team admission owner.
   */
  constructor(
    private readonly ctx: Context,
    private readonly journal: TeamJournal,
    private readonly lifecycle: TeamRuntimeLifecycle,
    private readonly config: Required<Config>,
    private readonly admission: TeamAdmission,
  ) {}

  /**
   * Resolve one exact live Agent's Team role.
   * @param agent - exact live Agent used as the authority credential.
   * @returns its root, Team identity, role, and model-facing name.
   */
  membership(agent: Agent): TeamMembership {
    const membership = this.tryMembership(agent)
    if (membership === undefined) {
      throw new TeamError(`agent "${agent.id}" is not a member of an active Agent Team`, 'TEAM_NOT_MEMBER')
    }
    return membership
  }

  /**
   * Resolve a caller without throwing for scoped installation and lifecycle observers.
   * @param agent - candidate exact live Agent.
   * @returns Team membership, or undefined for non-Team subagents and stale identities.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    if (this.ctx.agents.get(agent.id) !== agent) return undefined
    try {
      const parentId = agent.session.header.parentSession
      if (parentId !== undefined) {
        const root = this.ctx.agents.get(parentId)
        if (root !== undefined) {
          const member = this.journal.state(root).members.find(candidate => candidate.id === agent.id)
          if (member?.phase === 'active' || member?.phase === 'provisioning') {
            return { root, id: TeamId(root.id), role: 'teammate', name: member.name }
          }
          // A direct child outside the durable roster is not a teammate. Ordinary
          // host forks are independent roots; subagent descriptors distinguish
          // provider-owned workers that must not receive a nested Team identity.
          if (this.subagentDescriptor(agent)) return undefined
          return { root: agent, id: TeamId(agent.id), role: 'lead', name: 'lead' }
        }
      }
      // A continuation can briefly outlive its parent during child-first teardown.
      // Do not reinterpret that durable child as a new implicit root Team. A host-
      // resumed ordinary fork has no descriptor in its own suffix and remains a
      // valid new root whose inherited Team records stay outside its projected Team state.
      if (this.subagentDescriptor(agent)) return undefined
      return { root: agent, id: TeamId(agent.id), role: 'lead', name: 'lead' }
    } catch {
      // This method is used by lifecycle observers and teardown discovery. A
      // malformed durable stream is surfaced by authoritative Team operations;
      // the non-throwing probe must not veto unrelated Agent lifecycle edges.
      return undefined
    }
  }

  /**
   * List the runtime-enriched roster visible to one Team member.
   * @param membership - exact caller membership resolved by this roster.
   * @returns Lead and teammate rows in creation order.
   */
  list(membership: TeamMembership): TeamMemberView[] {
    const { root } = membership
    const state = this.journal.state(root)
    const result: TeamMemberView[] = [{
      id: root.id,
      name: 'lead',
      role: 'lead',
      status: availability(root),
      ...root.options.model === undefined ? {} : { model: root.options.model },
      diagnostics: [],
    }]
    for (const member of state.members) {
      const live = this.ctx.agents.get(member.id)
      // The route belongs to the MEMBER. Falling back to the Lead's model here
      // would report the Lead's route for a teammate on its own route (for
      // example after the member went inactive or was cold-resumed elsewhere);
      // an unknown model is better than a wrong one, and the spawn edge
      // reports the member's own route while it is live.
      const model = live?.options.model
      result.push({
        id: member.id,
        name: member.name,
        role: 'teammate',
        roleId: member.roleId, slotId: member.slotId, generation: member.generation,
        status: member.phase === 'retired' ? 'retired' : member.phase === 'failed'
          ? 'failed'
          : member.phase === 'provisioning'
            ? 'provisioning'
            : availability(live),
        description: member.description,
        provider: member.provider,
        context: member.context,
        ...model === undefined ? {} : { model },
        diagnostics: member.error === undefined ? [] : [member.error],
      })
    }
    return result
  }

  /**
   * Create a role-bound continuation in one reserved or flexible slot.
   * @param caller - exact live Lead Agent.
   * @param request - Role, task content, context mode, optional slot, and cancellation.
   * @returns the active roster row.
   */
  async spawn(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult> {
    if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    return await this.lifecycle.track(this.spawnAdmitted(caller, request))
  }

  /**
   * Reconcile provisioning state when one Team member Session starts.
   * @param agent - newly started exact live Agent.
   * @param signal - shared runtime cancellation.
   */
  async recoverFor(agent: Agent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const membership = this.tryMembership(agent)
    if (membership?.role === 'lead') {
      await this.admission.run(membership.root.id, async () => {
        await this.reconcileProvisioning(membership.root, signal)
        const state = this.journal.state(membership.root)
        for (const slot of state.slots) {
          if (slot.memberId === undefined) continue
          const member = state.members.find(member => member.id === slot.memberId)
          if (member === undefined || member.phase === 'retired') await this.releaseSlot(membership.root, slot)
          else if (member.phase === 'failed') await this.retireMember(membership.root, member)
        }
      })
    }
  }

  /**
   * Interrupt one live teammate turn without clearing its pending inbox.
   * @param caller - exact live Lead Agent.
   * @param targetName - durable teammate name.
   * @returns the target status sampled before cancellation.
   */
  interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'inactive' } {
    const membership = this.membership(caller)
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead can interrupt teammates', 'TEAM_LEAD_REQUIRED')
    const state = this.journal.state(membership.root)
    const target = resolveActiveMember(membership.root, state, targetName)
    if (target.id === membership.root.id) throw new TeamError('the Team Lead cannot interrupt itself', 'TEAM_INVALID_TARGET')
    const live = this.ctx.agents.get(target.id)
    if (live === undefined) return { previousStatus: 'inactive' }
    const previousStatus = availability(live)
    this.ctx.subagents.interrupt(target.id, { kind: 'ancestor', agent: caller })
    return { previousStatus }
  }

  /**
   * Group exact live roster children by their current Lead for runtime teardown.
   * @returns each live Lead and the roster child ids currently in the Agent registry.
   */
  liveChildrenByRoot(): Map<Agent, SessionId[]> {
    const teams = new Map<Agent, SessionId[]>()
    for (const agent of this.ctx.agents.list()) {
      const rootId = agent.session.header.parentSession
      if (rootId === undefined) continue
      const root = this.ctx.agents.get(rootId)
      if (root === undefined
        || !this.journal.state(root).members.some(member => member.id === agent.id)) continue
      const children = teams.get(root) ?? []
      children.push(agent.id)
      teams.set(root, children)
    }
    return teams
  }

  /**
   * Release exact teammate Activations through the continuation lifecycle owner.
   * @param root - exact live Team Lead authorizing release.
   * @param childIds - selected roster child ids.
   */
  async stopTeammates(root: Agent, childIds: readonly SessionId[]): Promise<void> {
    await this.lifecycle.withTimeout(this.ctx.subagents.drainChildren(root, childIds))
  }

  /** Record member-local idle timing from lifecycle notifications. @param agent - Changed Agent. */
  observeStatus(agent: Agent): void {
    if (this.tryMembership(agent)?.role !== 'teammate') return
    if (agent.status === 'running') this.idleSince.delete(agent.id)
    else this.touch(agent.id)
  }

  /** Reset grace after an accepted delivery. @param id - Member Session identity. */
  touch(id: SessionId): void { this.idleSince.set(id, Date.now()) }

  /**
   * Permanently retire a teammate after child drain succeeds.
   * @param caller - Exact live Lead.
   * @param target - Historical member name.
   * @returns The retired roster row.
   */
  async retire(caller: Agent, target: string): Promise<TeamMemberView> {
    if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    const membership = this.membership(caller)
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead can retire teammates', 'TEAM_LEAD_REQUIRED')
    return await this.lifecycle.track(this.admission.run(membership.root.id, async () => {
      const member = this.journal.state(membership.root).members.find(member => member.name === target)
      if (!member) throw new TeamError(`teammate "${target}" not found`, 'TEAM_MEMBER_NOT_FOUND')
      if (member.phase !== 'retired') {
        this.assertRetirable(membership.root, member)
        await this.retireMember(membership.root, member)
      }
      const view = this.list(membership).find(row => row.id === member.id)
      if (view === undefined) throw new TeamError('retired member disappeared', 'TEAM_MEMBER_NOT_FOUND')
      return view
    }))
  }

  private plannedSlots(): TeamSlotSnapshot[] {
    return [
      ...this.config.slotPlan.reserved.map(slot => ({ ...slot, pinned: true, generation: 0 })),
      ...this.config.slotPlan.flex.map(id => ({ id, roleId: null, pinned: false, generation: 0 })),
    ]
  }

  private async initializeSlots(root: Agent): Promise<void> {
    await this.journal.transact(root.id, async () => {
      for (const slot of this.plannedSlots()) {
        if (this.journal.state(root).slots.some(candidate => candidate.id === slot.id)) continue
        await this.journal.appendAndFlush(root, 'team/slot', { version: 1, teamId: TeamId(root.id), slot })
      }
    })
  }

  private hasOpenTasks(root: Agent, member: TeamMemberSnapshot): boolean {
    return this.journal.state(root).tasks.some(task => task.ownerId === member.id
      && task.status !== 'completed' && task.status !== 'deleted')
  }

  private assertRetirable(root: Agent, member: TeamMemberSnapshot): void {
    if (member.phase === 'provisioning' || this.memberBusy(member)) {
      throw new TeamError('teammate is provisioning or running', 'TEAM_MEMBER_BUSY')
    }
    if (this.hasOpenTasks(root, member)) throw new TeamError('teammate owns unfinished tasks', 'TEAM_MEMBER_BUSY')
  }

  private memberBusy(member: TeamMemberSnapshot): boolean {
    const live = this.ctx.agents.get(member.id)
    return live?.status === 'running' || (live !== undefined
      && (live.inbox.nextTurn.length > 0 || live.inbox.nextStep.length > 0))
  }

  private async reclaim(root: Agent, role: RoleSpec, explicitSlot?: string): Promise<void> {
    const state = this.journal.state(root)
    const candidates = state.members.filter((member) => {
      if (member.phase !== 'active' && member.phase !== 'failed') return false
      const slot = state.slots.find(slot => slot.id === member.slotId)
      if (slot?.pinned || this.hasOpenTasks(root, member) || this.memberBusy(member)) return false
      return member.phase === 'failed' || (this.config.memberIdleGraceMs > 0
        && Date.now() - (this.idleSince.get(member.id) ?? this.startedAt) > this.config.memberIdleGraceMs)
    }).sort((a, b) => (this.idleSince.get(a.id) ?? this.startedAt) - (this.idleSince.get(b.id) ?? this.startedAt))
    const retiring = new Set(candidates.filter(member => member.phase === 'failed').map(member => member.id))
    const occupied = state.members.filter(member => member.phase !== 'retired')
    const roleCount = (): number => occupied.filter(member => member.roleId === role.id && !retiring.has(member.id)).length
    while (roleCount() >= role.maxConcurrent) {
      const candidate = candidates.find(member => member.roleId === role.id && !retiring.has(member.id))
      if (!candidate) throw new TeamError(`role "${role.id}" concurrency limit reached`, 'TEAM_ROLE_FULL')
      retiring.add(candidate.id)
    }
    const available = (): boolean => state.slots.some(slot =>
      (explicitSlot === undefined ? (!slot.pinned || slot.roleId === role.id) : slot.id === explicitSlot)
      && (slot.memberId === undefined || retiring.has(slot.memberId)))
    while (!available() || occupied.filter(member => !retiring.has(member.id)).length >= this.config.maxMembers) {
      const candidate = candidates.find(member => !retiring.has(member.id)
        && (explicitSlot === undefined || member.slotId === explicitSlot))
      if (!candidate) throw new TeamError(`no capacity for role "${role.id}"`, 'TEAM_NO_CAPACITY')
      retiring.add(candidate.id)
    }
    for (const member of candidates) {
      if (retiring.has(member.id)) await this.retireMember(root, member)
    }
  }

  private async retireMember(root: Agent, member: TeamMemberSnapshot): Promise<void> {
    // Retirement must retain admission until the child actually drains. A disposal
    // deadline only bounds shutdown observation; it cannot reopen this member.
    await this.ctx.subagents.drainChildren(root, [member.id])
    await this.journal.transact(root.id, async () => {
      const current = this.journal.state(root).members.find(candidate => candidate.id === member.id)
      if (current === undefined) throw new TeamError('member disappeared', 'TEAM_MEMBER_NOT_FOUND')
      if (current.phase !== 'retired') {
        await this.journal.appendAndFlush(root, 'team/member', {
          version: 4, teamId: TeamId(root.id), member: { ...current, phase: 'retired' },
        })
      }
      const slot = this.journal.state(root).slots.find(slot => slot.memberId === member.id)
      if (slot) await this.releaseSlot(root, slot)
      this.idleSince.delete(member.id)
    })
  }

  private async releaseSlot(root: Agent, slot: TeamSlotSnapshot): Promise<void> {
    const { memberId: _memberId, ...empty } = slot
    await this.journal.appendAndFlush(root, 'team/slot', {
      version: 1, teamId: TeamId(root.id), slot: { ...empty, roleId: slot.pinned ? slot.roleId : null },
    })
  }

  /** Perform one creation admitted before the Team runtime disposal cutoff. */
  private async spawnAdmitted(
    caller: Agent,
    request: SpawnTeammateRequest,
  ): Promise<SpawnTeammateResult> {
    const membership = this.membership(caller)
    if (membership.role !== 'lead') {
      throw new TeamError('only the Team Lead can create teammates', 'TEAM_LEAD_REQUIRED')
    }
    const signal = AbortSignal.any([request.signal, this.lifecycle.signal])
    signal.throwIfAborted()
    const root = membership.root
    const role = this.config.roles.find(role => role.id === request.roleId)
    if (!role) throw new TeamError(`unknown role "${request.roleId}"`, 'TEAM_UNKNOWN_ROLE')
    const description = requiredText(request.description ?? role.description, 'description', 200)
    const provider = request.context === 'fork' ? 'fork' : 'spawn'
    if (!this.ctx.subagents.getProvider(provider)) throw new TeamError(`backend "${provider}" is unavailable`, 'TEAM_INVALID_ARGUMENT')
    if (request.task.length === 0) throw new TeamError('task must contain content', 'TEAM_INVALID_ARGUMENT')
    const planned = this.plannedSlots()
    if (request.slotId !== undefined) {
      const explicit = planned.find(slot => slot.id === request.slotId)
      if (!explicit || (explicit.pinned && explicit.roleId !== role.id)) {
        throw new TeamError('slot is absent or reserved for another role', 'TEAM_INVALID_SLOT')
      }
    }
    const member = await this.admission.run(root.id, async () => {
      signal.throwIfAborted()
      await this.initializeSlots(root)
      await this.reclaim(root, role, request.slotId)
      return await this.journal.transact(root.id, async () => {
        signal.throwIfAborted()
        const state = this.journal.state(root)
        const occupied = state.members.filter(member => member.phase !== 'retired')
        if (occupied.filter(member => member.roleId === role.id).length >= role.maxConcurrent) {
          throw new TeamError(`role "${role.id}" concurrency limit reached`, 'TEAM_ROLE_FULL')
        }
        const slot = request.slotId === undefined
          ? state.slots.find(slot => slot.pinned && slot.roleId === role.id && slot.memberId === undefined)
            ?? state.slots.find(slot => !slot.pinned && slot.memberId === undefined)
          : state.slots.find(slot => slot.id === request.slotId && slot.memberId === undefined)
        if (!slot || occupied.length >= this.config.maxMembers) {
          throw new TeamError(`no capacity for role "${role.id}"`, 'TEAM_NO_CAPACITY')
        }
        const generation = slot.generation + 1
        if (!Number.isSafeInteger(generation)) throw new TeamError('slot generation exhausted', 'TEAM_NO_CAPACITY')
        const childId = brandString<SessionId>(randomUUID())
        const member: TeamMemberSnapshot = {
          id: childId, roleId: role.id, slotId: slot.id, generation,
          name: this.memberName(`${slot.id}-g${generation}`), description, provider,
          context: request.context, phase: 'provisioning',
        }
        await this.journal.appendAndFlush(root, 'team/slot', {
          version: 1, teamId: TeamId(root.id), slot: { ...slot, roleId: role.id, generation, memberId: childId },
        })
        await this.journal.appendAndFlush(root, 'team/member', { version: 4, teamId: TeamId(root.id), member })
        return member
      })
    })
    const childId = member.id
    const name = member.name

    try {
      const started = await this.ctx.subagents.startActivation({
        delivery: 'parent',
        childId,
        provider: member.provider,
        label: description,
        request: {
          prompt: role.persona === undefined ? request.task : [{ type: 'text', text: role.persona }, ...request.task],
          parent: root,
          agentOptions: {
            provider: role.provider, model: role.model,
            ...role.maxTokens === undefined ? {} : { maxTokens: role.maxTokens },
          },
        },
        signal,
      })
      await this.checkpointInitialPrompt(childId, started.messageId, signal)
    } catch (error: unknown) {
      const failed: TeamMemberSnapshot = {
        ...member,
        phase: 'failed',
        error: errorMessage(error),
      }
      try {
        const phase = await this.settleProvisioning(root, failed)
        if (phase !== 'active') {
          await this.admission.run(root.id, async () => this.retireMember(root, failed))
        }
        if (phase === 'active') {
          throw new TeamError(
            `teammate "${name}" became active while its creator reported failure`,
            'TEAM_PROVISIONING_CONFLICT',
            { cause: error },
          )
        }
      } catch (recordError: unknown) {
        throw new AggregateError([error, recordError], 'teammate creation and durable failure recording both failed')
      }
      throw error
    }
    const active = {
      ...member,
      phase: 'active' as const,
    } satisfies TeamMemberSnapshot
    // Once the continuation accepted its first prompt, it is a real child. If
    // this checkpoint fails, keep the in-memory active edge instead of inventing
    // an impossible active -> failed transition; restart reconciliation covers
    // the provisioning-only durable prefix.
    const settledPhase = await this.settleProvisioning(root, active)
    if (settledPhase === 'failed') {
      const conflict = new TeamError(
        `teammate "${name}" was reconciled as failed while creation was in progress`,
        'TEAM_PROVISIONING_CONFLICT',
      )
      try {
        await this.stopTeammates(root, [childId])
      } catch (cleanupError: unknown) {
        /* v8 ignore next -- requires the independently tested HMR settlement conflict and cleanup failure together. */
        throw new AggregateError([conflict, cleanupError], 'provisioning conflict cleanup failed')
      }
      throw conflict
    }
    return { member: this.memberView(active) }
  }

  /** Flush the accepted initial inbox item before the Lead can commit `active`. */
  private async checkpointInitialPrompt(
    childId: SessionId,
    messageId: MessageId,
    signal: AbortSignal,
  ): Promise<void> {
    while (true) {
      signal.throwIfAborted()
      const session = this.ctx.sessions.get(childId)
      if (session === undefined) {
        const stored = await readPersistedSession(this.ctx.sessionPersistence, childId, signal)
        const suffix = stored.events.slice(stored.inheritedEventCount)
        if (messageAccepted(suffix, message => message.id === messageId)) return
        throw new TeamError(
          `teammate "${childId}" initial prompt was not durably accepted`,
          'TEAM_PROVISIONING_CONFLICT',
        )
      }

      const progress = Promise.withResolvers<void>()
      // Abort can win while the durability flush is still pending; mark the
      // later-awaited rejection handled without changing its eventual result.
      void progress.promise.catch(() => undefined)
      const stopEvent = this.ctx.on('session/event', (candidate) => {
        if (candidate === session) progress.resolve()
      })
      const stopDisposed = this.ctx.on('session/disposed', (candidate) => {
        if (candidate === session) progress.resolve()
      })
      const onAbort = (): void => {
        const reason: unknown = signal.reason
        progress.reject(reason instanceof Error
          ? reason
          : new TeamError(`teammate creation aborted: ${errorMessage(reason)}`, 'TEAM_DISPOSED'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        signal.throwIfAborted()
        await this.ctx.sessions.flush(session)
        const suffix = session.snapshotEvents(session.inheritedEventCount)
        if (messageAccepted(suffix, message => message.id === messageId)) return
        if (this.ctx.sessions.get(childId) !== session) continue
        await progress.promise
      } finally {
        signal.removeEventListener('abort', onAbort)
        stopDisposed()
        stopEvent()
      }
    }
  }

  /** Settle provisioning-only members from their independently durable child Sessions. */
  private async reconcileProvisioning(root: Agent, signal: AbortSignal): Promise<void> {
    const provisioning = this.journal.state(root).members.filter(member => member.phase === 'provisioning')
    for (const member of provisioning) {
      signal.throwIfAborted()
      // A live child means creation is still completing in this process. Its
      // creator owns the terminal member edge.
      if (this.ctx.agents.get(member.id) !== undefined) continue
      let phase: 'active' | 'failed' = 'failed'
      let failure = 'provisioning did not leave a resumable child Session'
      try {
        const loaded = await readPersistedSession(this.ctx.sessionPersistence, member.id, signal)
        const suffix = loaded.events.slice(loaded.inheritedEventCount)
        const descriptor = foldSubagentDescriptor(suffix)
        const acceptedInitialPrompt = messageAccepted(suffix, message => message.source.kind === 'user')
        if (loaded.header.parentSession === root.id
          && descriptor?.mode === 'continuable'
          && descriptor.provider === member.provider
          && acceptedInitialPrompt) {
          phase = 'active'
        } else {
          failure = 'persisted child Session does not match the provisioned continuation'
        }
      } catch (error: unknown) {
        failure = `child Session recovery failed: ${errorMessage(error)}`
      }
      signal.throwIfAborted()
      await this.journal.transact(root.id, async () => {
        signal.throwIfAborted()
        const current = this.journal.state(root).members.find(candidate => candidate.id === member.id)
        if (current?.phase !== 'provisioning') return
        const settled: TeamMemberSnapshot = {
          ...current,
          phase,
          ...phase === 'failed' ? { error: failure } : {},
        }
        await this.journal.appendAndFlush(root, 'team/member', {
          version: 4,
          teamId: TeamId(root.id),
          member: settled,
        })
      })
    }
  }

  /** Build one runtime member row after successful creation. */
  private memberView(member: TeamMemberSnapshot & { readonly phase: 'active' }): TeamMemberView {
    const live = this.ctx.agents.get(member.id)
    return {
      id: member.id,
      name: member.name,
      role: 'teammate',
      roleId: member.roleId, slotId: member.slotId, generation: member.generation,
      status: availability(live),
      description: member.description,
      provider: member.provider,
      context: member.context,
      ...live?.options.model === undefined ? {} : { model: live.options.model },
      diagnostics: [],
    }
  }

  /** Validate a never-reused model-facing teammate name. */
  private memberName(value: string): string {
    if (!MEMBER_NAME.test(value) || value.length > 64 || value === 'lead') {
      throw new TeamError(
        'teammate name must be lower-kebab-case, at most 64 characters, and not "lead"',
        'TEAM_INVALID_MEMBER_NAME',
      )
    }
    return value
  }

  /** Append one terminal provisioning edge unless recovery already settled it. */
  private async settleProvisioning(
    root: Agent,
    terminal: TeamMemberSnapshot,
  ): Promise<'active' | 'failed'> {
    return this.journal.transact(root.id, async () => {
      const current = this.journal.state(root).members.find(member => member.id === terminal.id)
      /* v8 ignore next 3 -- the append-only provisioning event is committed by this operation before settlement. */
      if (current === undefined) {
        throw new TeamError(`provisioned teammate "${terminal.id}" disappeared`, 'TEAM_PROVISIONING_CONFLICT')
      }
      if (current.phase !== 'provisioning') return current.phase === 'active' ? 'active' : 'failed'
      await this.journal.appendAndFlush(root, 'team/member', {
        version: 4,
        teamId: TeamId(root.id),
        member: terminal,
      })
      return terminal.phase === 'active' ? 'active' : 'failed'
    })
  }

  /** Whether a Session's own suffix identifies a provider-owned subagent child. */
  private subagentDescriptor(agent: Agent): boolean {
    return foldSubagentDescriptor(agent.session.snapshotEvents(agent.session.inheritedEventCount)) !== undefined
  }
}

/** Turn availability is independent of whether the Agent is loaded. */
function availability(agent: Agent | undefined): 'running' | 'inactive' {
  return agent?.status === 'running' ? 'running' : 'inactive'
}
