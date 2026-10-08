/** Pure transition rules for the repository-owned engineering task protocol. */

import type { CheckStatus, ReviewDecision, TaskStateRecord } from './types.ts'

const MAX_FIX_ATTEMPTS = 2

/** Input actions that may change a task state. */
export type TaskAction =
  | { type: 'baseline' }
  | { type: 'investigate' }
  | { type: 'freeze-plan' }
  | { type: 'start-implementation'; writerToken: string }
  | { type: 'release-implementation'; writerToken: string }
  | { type: 'begin-verification'; writerToken: string }
  | { type: 'complete-verification'; status: CheckStatus }
  | { type: 'begin-review' }
  | { type: 'complete-review'; decision: ReviewDecision; blocker?: string }
  | { type: 'accept' }
  | { type: 'replan'; confirmedStopped?: boolean }
  | { type: 'block'; blocker: string }

/** Error raised when an action is not legal for the current state. */
export class TransitionError extends Error {
  /** Create a transition diagnostic naming the attempted action and current state. */
  constructor(action: TaskAction['type'], state: TaskStateRecord['state'], detail?: string) {
    super(`cannot ${action} from ${state}${detail === undefined ? '' : `: ${detail}`}`)
    this.name = 'TransitionError'
  }
}

function requireState(current: TaskStateRecord, action: TaskAction['type'], allowed: TaskStateRecord['state'][]): void {
  if (!allowed.includes(current.state)) throw new TransitionError(action, current.state)
}

function requireNoWriter(current: TaskStateRecord, action: TaskAction['type']): void {
  if (current.writer !== null) throw new TransitionError(action, current.state, 'a writer lease is already active')
}

/**
 * Return whether durable state records uncertain work that needs operator confirmation.
 * @param current - authoritative task state.
 * @returns true when an active writer or stop-confirmation blocker remains.
 */
export function taskRequiresStopConfirmation(current: TaskStateRecord): boolean {
  if (current.writer !== null) return true
  const blocker = current.blocker ?? ''
  return /interrupted writer|Docker cancellation|termination is uncertain|confirm.*stopped|all command writes have stopped|previous agent and container|post-verification worktree/i.test(blocker)
}

function nextRevision(current: TaskStateRecord, now: string): TaskStateRecord {
  const { blocker: _blocker, ...withoutBlocker } = current
  return { ...withoutBlocker, revision: current.revision + 1, updatedAt: now }
}

function failedRepair(current: TaskStateRecord, now: string): TaskStateRecord {
  const fixAttempts = current.fixAttempts + 1
  const next = nextRevision(current, now)
  return fixAttempts >= MAX_FIX_ATTEMPTS
    ? { ...next, state: 'REPLAN', fixAttempts, writer: null }
    : { ...next, state: 'IMPLEMENTING', fixAttempts, writer: null }
}

/**
 * Apply one validated state action without performing I/O.
 * @param current - latest authoritative state.
 * @param action - requested transition and its required evidence summary.
 * @param now - ISO timestamp recorded on the successor.
 * @returns a new state with revision incremented exactly once.
 */
export function transition(current: TaskStateRecord, action: TaskAction, now: string): TaskStateRecord {
  if (current.state === 'ACCEPTED') throw new TransitionError(action.type, current.state, 'accepted tasks are terminal')

  switch (action.type) {
    case 'baseline': {
      requireState(current, action.type, ['NEW'])
      return { ...nextRevision(current, now), state: 'BASELINED' }
    }
    case 'investigate': {
      requireState(current, action.type, ['BASELINED', 'REPLAN'])
      return { ...nextRevision(current, now), state: 'INVESTIGATED' }
    }
    case 'freeze-plan': {
      requireState(current, action.type, ['INVESTIGATED'])
      return {
        ...nextRevision(current, now),
        state: 'PLAN_FROZEN',
        workRevision: current.workRevision + 1,
        fixAttempts: 0,
        writer: null,
      }
    }
    case 'start-implementation': {
      requireState(current, action.type, ['PLAN_FROZEN', 'IMPLEMENTING'])
      requireNoWriter(current, action.type)
      if (action.writerToken.trim().length === 0) throw new TransitionError(action.type, current.state, 'writer token is empty')
      const next = nextRevision(current, now)
      return {
        ...next,
        state: 'IMPLEMENTING',
        writer: { role: 'implementer', token: action.writerToken, baseRevision: next.revision },
      }
    }
    case 'begin-verification': {
      requireState(current, action.type, ['IMPLEMENTING'])
      if (current.writer?.token !== action.writerToken) {
        throw new TransitionError(action.type, current.state, 'writer token does not own the active lease')
      }
      return { ...nextRevision(current, now), state: 'VERIFYING', writer: null }
    }
    case 'release-implementation': {
      requireState(current, action.type, ['IMPLEMENTING'])
      if (current.writer?.token !== action.writerToken) throw new TransitionError(action.type, current.state, 'writer token does not own the active lease')
      return { ...nextRevision(current, now), writer: null }
    }
    case 'complete-verification': {
      requireState(current, action.type, ['VERIFYING'])
      return action.status === 'PASS'
        ? { ...nextRevision(current, now), state: 'VERIFIED', writer: null }
        : failedRepair(current, now)
    }
    case 'begin-review': {
      requireState(current, action.type, ['VERIFIED'])
      requireNoWriter(current, action.type)
      return { ...nextRevision(current, now), state: 'REVIEWING' }
    }
    case 'complete-review': {
      requireState(current, action.type, ['REVIEWING'])
      if (action.decision === 'ACCEPT') return { ...nextRevision(current, now), state: 'REVIEWED' }
      if (action.decision === 'FIX_BOUNDED') return failedRepair(current, now)
      if (action.decision === 'REPLAN') return { ...nextRevision(current, now), state: 'REPLAN', writer: null }
      if (action.blocker === undefined || action.blocker.trim().length === 0) {
        throw new TransitionError(action.type, current.state, 'BLOCKED review requires a blocker')
      }
      return { ...nextRevision(current, now), state: 'BLOCKED', writer: null, blocker: action.blocker }
    }
    case 'accept': {
      requireState(current, action.type, ['REVIEWED'])
      requireNoWriter(current, action.type)
      return { ...nextRevision(current, now), state: 'ACCEPTED' }
    }
    case 'replan': {
      requireNoWriter(current, action.type)
      if (taskRequiresStopConfirmation(current) && action.confirmedStopped !== true) {
        throw new TransitionError(action.type, current.state, 'confirm that all agent and command work has stopped')
      }
      requireState(current, action.type, ['BASELINED', 'INVESTIGATED', 'PLAN_FROZEN', 'IMPLEMENTING', 'VERIFYING', 'VERIFIED', 'REVIEWING', 'REVIEWED', 'REPLAN', 'BLOCKED'])
      return { ...nextRevision(current, now), state: 'REPLAN', writer: null }
    }
    case 'block': {
      requireNoWriter(current, action.type)
      if (taskRequiresStopConfirmation(current)) {
        throw new TransitionError(action.type, current.state, 'cannot replace a stop-confirmation blocker before recovery')
      }
      if (action.blocker.trim().length === 0) throw new TransitionError(action.type, current.state, 'blocker is empty')
      return { ...nextRevision(current, now), state: 'BLOCKED', writer: null, blocker: action.blocker }
    }
  }
}
