/** Shared Team task DAG commands and runtime-enriched views. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamMembership } from './roster.ts'
import {
  assertCompletionEvidence,
  assertCompletionRequirementsStrengthened,
  completionRequirementsDigest,
  normalizeCompletionEvidence,
  normalizeCompletionRequirements,
} from './completion.ts'
import type {
  TeamCompletionGate,
  TeamTaskCompletionReceipt,
  TeamTaskCompletionRequirement,
} from './completion.ts'
import { errorMessage, TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamState } from './projection.ts'
import { resolveActiveMember } from './roster.ts'
import { assertTaskGraphCandidate, TeamTaskGraphError } from './task-graph.ts'
import type { TeamTaskGraphViolation } from './task-graph.ts'
import { TeamId, TeamTaskId } from './types.ts'
import type {
  CreateTeamTaskRequest,
  TeamTaskSnapshot,
  TeamTaskView,
  UpdateTeamTaskRequest,
} from './types.ts'
import { projectTaskView, taskReady } from './task-view.ts'
import { requiredText, writeScope } from './validation.ts'

const TASK_GRAPH_ERROR_CODES: Record<TeamTaskGraphViolation, string> = {
  missing: 'TEAM_TASK_NOT_FOUND',
  duplicate: 'TEAM_INVALID_ARGUMENT',
  cycle: 'TEAM_TASK_DEPENDENCY_CYCLE',
}

/** Completion facts frozen before policy verification and rechecked at commit. */
interface PreparedCompletion {
  readonly revision: number
  readonly requirementsDigest: string
  readonly evidence: readonly { readonly key: string; readonly reference: string }[]
}

/** Owns Team task limits, authorization, transitions, and derived views. */
export class TeamTaskBoard {
  /**
   * @param journal - authoritative Lead-log transaction owner.
   * @param maxTasks - maximum non-deleted tasks retained by one Team.
   * @param completion - registered completion-policy gate consulted by `complete`.
   */
  constructor(
    private readonly journal: TeamJournal,
    private readonly maxTasks: number,
    private readonly completion: TeamCompletionGate,
  ) {}

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param membership - exact caller membership resolved by the Team roster.
   * @param request - task text, blockers, advisory write scopes, and optional
   *   declarative completion requirements.
   * @returns the revision-one task view.
   */
  async create(membership: TeamMembership, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    const { root } = membership
    const requirements = normalizeCompletionRequirements(request.completionRequirements ?? [])
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const active = state.tasks.filter(task => task.status !== 'deleted').length
      if (active >= this.maxTasks) {
        throw new TeamError(`Team task limit ${this.maxTasks} reached`, 'TEAM_TASK_LIMIT')
      }
      const id = TeamTaskId(`task-${state.nextTaskNumber}`)
      if (state.tasks.some(task => task.id === id)) {
        throw new TeamError('Team task id space exhausted', 'TEAM_TASK_LIMIT')
      }
      const task: TeamTaskSnapshot = {
        id,
        revision: 1,
        subject: requiredText(request.subject, 'subject', 200),
        description: requiredText(request.description, 'description', 16_384),
        status: 'pending',
        blockedBy: this.dependencies(request.blockedBy ?? [], state),
        writeScopes: this.writeScopes(request.writeScopes ?? []),
        ...requirements.length === 0 ? {} : { completionRequirements: requirements },
      }
      this.assertTaskGraph(state, task)
      await this.journal.appendAndFlush(root, 'team/task', { version: 3, teamId: TeamId(root.id), task })
      return projectTaskView(state, task)
    })
  }

  /**
   * Return one task, including a deleted tombstone.
   * @param membership - exact caller membership resolved by the Team roster.
   * @param id - Team-local task identity.
   * @returns the latest task value and derived readiness diagnostics.
   */
  get(membership: TeamMembership, id: TeamTaskId): TeamTaskView {
    const { root } = membership
    const state = this.journal.state(root)
    const task = state.tasks.find(candidate => candidate.id === id)
    if (task === undefined) throw new TeamError(`team task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
    return projectTaskView(state, task)
  }

  /**
   * List current non-deleted tasks in numeric creation order.
   * @param membership - exact caller membership resolved by the Team roster.
   * @returns detached current task views.
   */
  list(membership: TeamMembership): TeamTaskView[] {
    const { root } = membership
    const state = this.journal.state(root)
    return state.tasks
      .filter(task => task.status !== 'deleted')
      .map(task => projectTaskView(state, task))
  }

  /**
   * Compare-and-set one authorized task transition.
   *
   * A completion of a task that declares completion requirements runs every
   * registered completion policy OUTSIDE the Lead transaction queue, then
   * commits inside one transaction that re-reads the task and requires the
   * same revision, requirement digest, and evidence reference the policies
   * accepted. Every other transition, and every completion of a task without
   * declared requirements, keeps the historical single-transaction behaviour.
   * @param caller - exact live Team member authorizing the mutation.
   * @param membership - caller role and exact live Lead.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed next task revision.
   */
  async update(
    caller: Agent,
    membership: TeamMembership,
    request: UpdateTeamTaskRequest,
  ): Promise<TeamTaskView> {
    const state = this.journal.state(membership.root)
    const current = this.requireCurrent(state, request)
    const requirements = current.completionRequirements ?? []
    if (request.action === 'complete' && current.status === 'in_progress' && requirements.length > 0) {
      return await this.completeWithPolicy(caller, membership, request, current, requirements)
    }
    return await this.journal.transact(membership.root.id, async () => {
      return await this.mutate(caller, membership, this.journal.state(membership.root), request)
    })
  }

  /**
   * Two-phase completion: freeze the accepted facts, run every registered
   * policy OUTSIDE the Lead transaction queue, then commit inside one
   * transaction that revalidates the exact same revision and requirement set.
   * @param caller - exact live Team member completing the task.
   * @param membership - caller role and exact live Lead.
   * @param request - task identity, expected revision, and offered evidence.
   * @param current - the in-progress task carrying the declared requirements.
   * @param requirements - the non-empty requirement set read with the task.
   * @returns the committed next task view.
   */
  private async completeWithPolicy(
    caller: Agent,
    membership: TeamMembership,
    request: UpdateTeamTaskRequest,
    current: TeamTaskSnapshot,
    requirements: readonly TeamTaskCompletionRequirement[],
  ): Promise<TeamTaskView> {
    if (membership.role !== 'lead' && current.ownerId !== caller.id) {
      throw new TeamError('task mutation requires its owner or Team Lead', 'TEAM_TASK_UNAUTHORIZED')
    }
    const evidence = normalizeCompletionEvidence(request.evidence ?? [])
    assertCompletionEvidence(requirements, evidence)
    const prepared: PreparedCompletion = {
      revision: current.revision,
      requirementsDigest: completionRequirementsDigest(requirements),
      evidence,
    }
    const receipt = await this.completion.authorize({
      teamId: TeamId(membership.root.id),
      taskId: current.id,
      revision: current.revision,
      subject: current.subject,
      description: current.description,
      requirements,
      evidence,
      callerId: caller.id,
      callerName: membership.name,
    })
    return await this.commitCompletion(membership, request, prepared, receipt)
  }

  /**
   * Apply one authorized transition to the current state and append its event.
   * @param caller - exact live Team member authorizing the mutation.
   * @param membership - caller role and exact live Lead.
   * @param state - Team state read inside the current transaction.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed next task view.
   */
  private async mutate(
    caller: Agent,
    membership: TeamMembership,
    state: TeamState,
    request: UpdateTeamTaskRequest,
  ): Promise<TeamTaskView> {
    const { root } = membership
    const current = this.requireCurrent(state, request)
    const lead = membership.role === 'lead'
    const owner = current.ownerId === caller.id
    const authorizeOwner = (): void => {
      if (!lead && !owner) throw new TeamError('task mutation requires its owner or Team Lead', 'TEAM_TASK_UNAUTHORIZED')
    }
    let next: TeamTaskSnapshot
    switch (request.action) {
      case 'claim':
        if (current.ownerId !== undefined && current.ownerId !== caller.id) {
          throw new TeamError(`team task "${current.id}" is owned by another member`, 'TEAM_TASK_ALREADY_CLAIMED')
        }
        if (current.status !== 'pending' || !taskReady(state, current)) {
          throw new TeamError(`team task "${current.id}" is not ready to claim`, 'TEAM_TASK_BLOCKED')
        }
        next = { ...current, status: 'in_progress', ownerId: caller.id }
        break
      case 'release':
        authorizeOwner()
        if (current.status !== 'in_progress') throw new TeamError('only an in-progress task can be released', 'TEAM_TASK_INVALID_TRANSITION')
        next = this.withoutOwner({ ...current, status: 'pending' })
        break
      case 'edit': {
        authorizeOwner()
        if (request.subject === undefined && request.description === undefined
          && request.writeScopes === undefined && request.completionRequirements === undefined) {
          throw new TeamError(
            'task edit requires subject, description, write_scopes, or completion_requirements',
            'TEAM_INVALID_ARGUMENT',
          )
        }
        const requirements = request.completionRequirements === undefined
          ? {}
          : this.replacementRequirements(current, request.completionRequirements)
        next = {
          ...current,
          ...request.subject === undefined ? {} : { subject: requiredText(request.subject, 'subject', 200) },
          ...request.description === undefined
            ? {}
            : { description: requiredText(request.description, 'description', 16_384) },
          ...request.writeScopes === undefined ? {} : { writeScopes: this.writeScopes(request.writeScopes) },
          ...requirements,
        }
        break
      }
      case 'set_dependencies':
        authorizeOwner()
        if (request.blockedBy === undefined) throw new TeamError('set_dependencies requires blocked_by', 'TEAM_INVALID_ARGUMENT')
        next = { ...current, blockedBy: this.dependencies(request.blockedBy, state, current.id) }
        break
      case 'complete':
        authorizeOwner()
        if (current.status !== 'in_progress') throw new TeamError('only an in-progress task can complete', 'TEAM_TASK_INVALID_TRANSITION')
        /* v8 ignore next 6 -- `update` routes every requirement-bearing completion to the gate above. */
        if ((current.completionRequirements?.length ?? 0) > 0) {
          throw new TeamError(
            `team task "${current.id}" declares completion requirements and cannot complete without a completion policy`,
            'TEAM_TASK_COMPLETION_UNAVAILABLE',
          )
        }
        if ((request.evidence?.length ?? 0) > 0) {
          throw new TeamError(
            `team task "${current.id}" declares no completion requirements`,
            'TEAM_INVALID_ARGUMENT',
          )
        }
        next = { ...current, status: 'completed' }
        break
      case 'reopen':
        authorizeOwner()
        if (current.status !== 'completed') throw new TeamError('only a completed task can reopen', 'TEAM_TASK_INVALID_TRANSITION')
        next = this.withoutCompletion(this.withoutOwner({ ...current, status: 'pending' }))
        break
      case 'reassign': {
        if (!lead) throw new TeamError('only the Team Lead can reassign tasks', 'TEAM_LEAD_REQUIRED')
        if (current.status !== 'pending' && current.status !== 'in_progress') {
          throw new TeamError(
            'only a pending or in-progress task can be reassigned',
            'TEAM_TASK_INVALID_TRANSITION',
          )
        }
        if (request.owner === undefined || request.owner.trim().length === 0) {
          next = this.withoutOwner({ ...current, status: 'pending' })
          break
        }
        if (!taskReady(state, current)) throw new TeamError(`team task "${current.id}" is blocked`, 'TEAM_TASK_BLOCKED')
        const assignee = resolveActiveMember(root, state, request.owner)
        next = { ...current, status: 'in_progress', ownerId: assignee.id }
        break
      }
      case 'delete': {
        authorizeOwner()
        const dependent = state.tasks.find(task =>
          task.status !== 'deleted' && task.id !== current.id && task.blockedBy.includes(current.id))
        if (dependent !== undefined) {
          throw new TeamError(`team task "${current.id}" still blocks "${dependent.id}"`, 'TEAM_TASK_HAS_DEPENDENTS')
        }
        next = { ...current, status: 'deleted' }
        break
      }
      /* v8 ignore next 2 -- TeamTaskAction is closed and every member is handled above. */
      default:
        throw new TeamError(`unsupported task action ${String(request.action)}`, 'TEAM_INVALID_ARGUMENT')
    }
    return await this.commit(root, state, current, next)
  }

  /**
   * Commit a policy-accepted completion inside one Lead transaction.
   *
   * The transaction re-reads the task, so `requireCurrent` proves the revision
   * is still the exact revision the policies accepted (it is the same CAS
   * predicate the caller supplied). The requirement digest is rechecked as
   * defence in depth: the durable projection already refuses a requirement
   * change that keeps a revision, so this guard can only fire on a corrupted
   * in-memory state, and it must never commit a completion in that case.
   * @param membership - caller role and exact live Lead.
   * @param request - task identity and expected revision.
   * @param prepared - facts frozen before the policies ran.
   * @param receipt - acceptance receipt the policies produced.
   * @returns the committed next task view.
   */
  private async commitCompletion(
    membership: TeamMembership,
    request: UpdateTeamTaskRequest,
    prepared: PreparedCompletion,
    receipt: TeamTaskCompletionReceipt,
  ): Promise<TeamTaskView> {
    const { root } = membership
    return await this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const current = this.requireCurrent(state, request)
      /* v8 ignore next 5 -- the projection refuses a requirement change that keeps a revision. */
      if (completionRequirementsDigest(current.completionRequirements ?? []) !== prepared.requirementsDigest) {
        throw new TeamError(
          `team task "${current.id}" completion requirements changed during verification`,
          'TEAM_TASK_COMPLETION_CHANGED',
        )
      }
      return await this.commit(root, state, current, { ...current, status: 'completed', completion: receipt })
    })
  }

  /** Read one current task under the strict CAS and lifecycle preconditions. */
  private requireCurrent(state: TeamState, request: UpdateTeamTaskRequest): TeamTaskSnapshot {
    const current = state.tasks.find(task => task.id === request.taskId)
    if (current === undefined) throw new TeamError(`team task "${request.taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
    if (current.revision !== request.expectedRevision) {
      throw new TeamError(
        `stale team task "${current.id}" revision ${request.expectedRevision}; current revision is ${current.revision}`,
        'TEAM_TASK_STALE_REVISION',
      )
    }
    if (current.status === 'deleted') throw new TeamError(`team task "${current.id}" is deleted`, 'TEAM_TASK_DELETED')
    return current
  }

  /** Validate the candidate graph and append its next revision. */
  private async commit(
    root: Agent,
    state: TeamState,
    current: TeamTaskSnapshot,
    next: TeamTaskSnapshot,
  ): Promise<TeamTaskView> {
    const task: TeamTaskSnapshot = {
      ...next,
      revision: current.revision + 1,
    }
    this.assertTaskGraph(state, task)
    await this.journal.appendAndFlush(root, 'team/task', { version: 3, teamId: TeamId(root.id), task })
    return projectTaskView(state, task)
  }

  /** Validate and de-duplicate dependency ids against the current task graph. */
  private dependencies(
    values: readonly TeamTaskId[],
    state: TeamState,
    self?: TeamTaskId,
  ): TeamTaskId[] {
    const seen = new Set<TeamTaskId>()
    const result: TeamTaskId[] = []
    for (const id of values) {
      if (id === self) throw new TeamError('a team task cannot block itself', 'TEAM_TASK_DEPENDENCY_CYCLE')
      if (seen.has(id)) throw new TeamError(`duplicate blocker "${id}"`, 'TEAM_INVALID_ARGUMENT')
      const task = state.tasks.find(candidate => candidate.id === id)
      if (task === undefined || task.status === 'deleted') {
        throw new TeamError(`blocker task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
      }
      seen.add(id)
      result.push(id)
    }
    return result
  }

  /** Normalize and de-duplicate task write scopes. */
  private writeScopes(values: readonly string[]): string[] {
    return [...new Set(values.map(writeScope))]
  }

  /**
   * Validate one replacement requirement set against the durable declaration.
   * Requirements may only grow; dropping or rewriting a declared requirement is
   * refused, and an empty replacement omits the field entirely.
   */
  private replacementRequirements(
    current: TeamTaskSnapshot,
    values: readonly TeamTaskCompletionRequirement[],
  ): { completionRequirements?: TeamTaskCompletionRequirement[] } {
    const normalized = normalizeCompletionRequirements(values)
    try {
      assertCompletionRequirementsStrengthened(current.completionRequirements ?? [], normalized)
    } catch (error: unknown) {
      throw new TeamError(
        `team task "${current.id}" completion requirements cannot be removed or weakened: ${errorMessage(error)}`,
        'TEAM_TASK_COMPLETION_REQUIREMENT_WEAKENED',
        { cause: error },
      )
    }
    return normalized.length === 0 ? {} : { completionRequirements: normalized }
  }

  /** Map shared task-graph validation onto stable command error codes. */
  private assertTaskGraph(state: TeamState, candidate: TeamTaskSnapshot): void {
    try {
      assertTaskGraphCandidate(state.tasks, candidate)
    } catch (error: unknown) {
      /* v8 ignore next -- the shared validator is the only statement in the try and throws this exact error. */
      if (!(error instanceof TeamTaskGraphError)) throw error
      throw new TeamError(error.message, TASK_GRAPH_ERROR_CODES[error.violation], { cause: error })
    }
  }

  /** Remove an optional owner field under exactOptionalPropertyTypes. */
  private withoutOwner(task: TeamTaskSnapshot): TeamTaskSnapshot {
    const { ownerId: _ownerId, ...without } = task
    return without
  }

  /** Remove the acceptance receipt when a completed task reopens. */
  private withoutCompletion(task: TeamTaskSnapshot): TeamTaskSnapshot {
    const { completion: _completion, ...without } = task
    return without
  }
}
