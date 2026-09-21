/**
 * Degenerate-output guard: watches the live assistant stream for short-period
 * line cycles in reasoning and text blocks, marks the detection atomically,
 * cancels the generating step, and — at the turn boundary, never inside the
 * stream listener — recovers with a bounded corrective followup. The phase
 * split, the recovery-chain budget, and the observe/abort ladder are owned by
 * the degenerate-output-guard Agent Note; configuration semantics live in the
 * package README.
 * @module @deepseek-ai/dsh-degenerate-output-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId, MessageSource, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { RepetitionDetector } from './detector.ts'

export { RepetitionDetector, evaluateWindow } from './detector.ts'
export type { Degeneration, DetectorTuning } from './detector.ts'

export const name = 'degenerate-output-guard'

/** What the guard does when a window is judged degenerate. */
export type OnDetectMode = 'observe' | 'abort-only' | 'abort-and-continue'

/** Which streamed block kinds the detector watches. */
export type ApplyTo = 'reasoning' | 'text' | 'both'

/**
 * Plugin config. Every field is a validated `Config` entry: the schemastery
 * schema supplies types, enums, and defaults, and `apply` re-checks ranges
 * fail-loud (misconfiguration throws at load, never a silent fallback). The
 * shipped base-bundle default is the conservative rollout rung: watch
 * `reasoning` only, in `observe` mode.
 */
export interface Config {
  /** Size in characters of the trailing window inspected per check (default 4000). */
  windowChars?: number
  /** Characters between evaluations, amortizing the scan (default 512). */
  checkEveryChars?: number
  /** Minimum non-empty trimmed lines before a window is judged (default 24). */
  minWindowLines?: number
  /** Windows whose distinct-line ratio exceeds this are healthy (default 0.20). */
  distinctLineRatio?: number
  /** Largest line period scanned for a cycle (default 12). */
  cyclePeriodMax?: number
  /** Period match fraction required to fire (default 0.90). */
  cycleMatchRatio?: number
  /** Intervention rung; `observe` records without touching the conversation (default `observe`). */
  onDetect?: OnDetectMode
  /**
   * Corrective followups allowed per recovery chain — consecutive turns whose
   * input was this guard's own notice — not per turn (default 1). A recovery
   * turn that degenerates again may still be aborted, but no further automatic
   * followup is queued, so the guard can never retry-loop itself.
   */
  maxRecoveryAttempts?: number
  /** Block kinds watched; `reasoning` first, `text` calibrates separately (default `reasoning`). */
  applyTo?: ApplyTo
}

export const Config: z<Config> = z.object({
  windowChars: z.number().default(4000),
  checkEveryChars: z.number().default(512),
  minWindowLines: z.number().default(24),
  distinctLineRatio: z.number().default(0.20),
  cyclePeriodMax: z.number().default(12),
  cycleMatchRatio: z.number().default(0.90),
  onDetect: z.union(['observe', 'abort-only', 'abort-and-continue'] as const).default('observe'),
  maxRecoveryAttempts: z.number().default(1),
  applyTo: z.union(['reasoning', 'text', 'both'] as const).default('reasoning'),
})

/** Fully validated config values, resolved once at load. */
interface ResolvedConfig {
  windowChars: number
  checkEveryChars: number
  minWindowLines: number
  distinctLineRatio: number
  cyclePeriodMax: number
  cycleMatchRatio: number
  onDetect: OnDetectMode
  maxRecoveryAttempts: number
  applyTo: ApplyTo
}

/** Detector tuning derived from the resolved config. */
interface Tuning {
  windowChars: number
  checkEveryChars: number
  minWindowLines: number
  distinctLineRatio: number
  cyclePeriodMax: number
  cycleMatchRatio: number
}

/**
 * Structural view of the agent registry, declared locally so the guard carries
 * no build-time dependency on the registry package. The registry is optional:
 * without it there are no agent turns, so there is nothing to guard.
 */
interface AgentRegistryService {
  get(id: SessionId): Agent | undefined
}

/**
 * Structural view of the optional goal service, declared locally so the guard
 * carries no build-time dependency on the goal package. When the service is
 * absent the guard simply never restores automation.
 */
interface GoalAutomationService {
  get(agent: Agent): { readonly id: string; readonly revision: number; readonly phase: string; readonly activation: string } | undefined
  disarm(agent: Agent): unknown
  resume(agent: Agent, ref: { readonly id: string; readonly revision: number }): unknown
}

/** Goal identity snapshot proving the goal was armed when the guard tripped. */
interface ArmedGoalSnapshot {
  readonly id: string
  readonly revision: number
}

/** Facts of one detection, retained until the aborted turn settles. */
interface Trip {
  readonly detectionId: string
  readonly attemptId: string
  readonly turn: number
  readonly step: number
  readonly blockKind: 'reasoning' | 'text'
  readonly bestPeriod: number
  readonly matchRatio: number
  readonly windowLines: number
  readonly distinctRatio: number
  readonly charsSeen: number
  /** Exact `agent.cancel` hook cause; the turn-end reason must match it verbatim. */
  readonly causeReason: string
  /** Recovery-chain depth of the turn being aborted. */
  readonly recoveryDepth: number
  readonly armedGoal: ArmedGoalSnapshot | undefined
}

/** Detector state for one open streamed block. */
interface BlockState {
  readonly kind: 'reasoning' | 'text'
  readonly detector: RepetitionDetector
}

/** Detector state for the one live attempt of an agent. */
interface AttemptState {
  readonly attemptId: string
  readonly turn: number
  readonly step: number
  readonly blocks: Map<number, BlockState>
  tripped: boolean
}

/** Cross-turn recovery budget for one agent. */
interface RecoveryChain {
  /**
   * Corrective recoveries already spent in the current chain: consecutive
   * turns whose claimed input was this guard's own notice. Any other claimed
   * message — human, goal round, another plugin — starts a new chain at 0.
   */
  depth: number
  /** Identity, depth, and detection of the queued notice awaiting its turn claim. */
  pending: { readonly id: MessageId; readonly depth: number; readonly detection: string } | undefined
  /**
   * Turn that claimed the pending notice. A non-notice message claimed in the
   * same turn (the notice rides another producer's batch) starts a fresh
   * chain: that turn is the other producer's, bounded by its own budget.
   */
  noticeTurn: number | undefined
}

/** All guard state for one exact Agent lifecycle. */
interface AgentState {
  attempt: AttemptState | undefined
  trip: Trip | undefined
  chain: RecoveryChain
}

/** Whether a message source is a notice this guard queued. */
function isOwnNotice(source: MessageSource): boolean {
  return source.kind === 'plugin' && source.plugin === name
}

/** Model-facing correction delivered after a guard abort. Pinned by the README's Model Experience section. */
function correctiveNotice(trip: Trip): UserMessage {
  const text = 'The previous generation entered a short repetition cycle '
    + `(period ${trip.bestPeriod}, ~${trip.windowLines} repeated lines in the final window) `
    + 'and was stopped before it exhausted the output budget.\n'
    + 'Do not restate the plan or continue the stopped reasoning. '
    + 'Continue from the useful context and either:\n'
    + '1. execute the required tool/action, or\n'
    + '2. provide the requested result.'
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: boundContextSummary(`stopped a repetition cycle (period ${trip.bestPeriod})`),
    },
  })
}

/**
 * Validate the config ranges that the schema cannot express, fail loud on any
 * violation, and resolve defaults into concrete numbers.
 * @param config - schema-validated config.
 * @returns the resolved values used for the plugin's lifetime.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const fail = (field: string, detail: string): never => {
    throw new Error(`degenerate-output-guard: invalid ${field} — ${detail}`)
  }
  const integer = (field: string, value: number, min: number): number => {
    if (!Number.isInteger(value) || value < min) fail(field, `must be an integer >= ${min}`)
    return value
  }
  const windowChars = integer('windowChars', config.windowChars as number, 1)
  const checkEveryChars = integer('checkEveryChars', config.checkEveryChars as number, 1)
  if (checkEveryChars > windowChars) {
    fail('checkEveryChars', `must not exceed windowChars (${windowChars})`)
  }
  const distinctLineRatio = config.distinctLineRatio as number
  if (!(distinctLineRatio > 0) || distinctLineRatio > 1) {
    fail('distinctLineRatio', 'must be a number in (0, 1]')
  }
  const cycleMatchRatio = config.cycleMatchRatio as number
  if (!(cycleMatchRatio > 0) || cycleMatchRatio > 1) {
    fail('cycleMatchRatio', 'must be a number in (0, 1]')
  }
  return {
    windowChars,
    checkEveryChars,
    minWindowLines: integer('minWindowLines', config.minWindowLines as number, 2),
    distinctLineRatio,
    cyclePeriodMax: integer('cyclePeriodMax', config.cyclePeriodMax as number, 1),
    cycleMatchRatio,
    onDetect: config.onDetect as OnDetectMode,
    maxRecoveryAttempts: integer('maxRecoveryAttempts', config.maxRecoveryAttempts as number, 0),
    applyTo: config.applyTo as ApplyTo,
  }
}

/** The streamed block kinds the guard watches. */
type BlockKind = 'reasoning' | 'text'

/** The streamed block kinds this config watches. */
function watches(kind: BlockKind, applyTo: ApplyTo): boolean {
  if (applyTo === 'both') return true
  return kind === applyTo
}

/** The block-kind fields of one streamed delta chunk, or undefined for other chunks. */
function deltaFields(chunk: StreamChunk): { kind: BlockKind; index: number; text: string } | undefined {
  if (chunk.type === 'reasoning-delta') return { kind: 'reasoning', index: chunk.index, text: chunk.text }
  if (chunk.type === 'text-delta') return { kind: 'text', index: chunk.index, text: chunk.text }
  return undefined
}

/**
 * Snapshot the agent's armed goal, if the goal service is mounted and a goal is
 * currently active and armed. `undefined` — no service, no goal, or not armed —
 * means the guard's abort tears down nothing worth restoring, so recovery will
 * not touch goal state.
 */
function snapshotArmedGoal(ctx: Context, agent: Agent): ArmedGoalSnapshot | undefined {
  const goals = ctx.get('goals') as GoalAutomationService | undefined
  if (goals === undefined) return undefined
  let goal: ReturnType<GoalAutomationService['get']>
  try {
    goal = goals.get(agent)
  } catch (error: unknown) {
    ctx.logger.warn('degenerate-output-guard: could not read goal state for agent "%s": %s', agent.id, String(error))
    return undefined
  }
  if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return undefined
  return { id: goal.id, revision: goal.revision }
}

/**
 * Restore automatic goal continuation that the guard's own abort tore down.
 *
 * The abort runs through `agent.cancel`, so the goal-round-driver treats the
 * turn exactly like a human stop: it disarms the goal (and pauses it at idle
 * when the aborted turn was a claimed goal round). Recovery must undo that —
 * but only what the guard itself caused. The detection-time snapshot gates it:
 * the goal must still be the same revision (no other actor mutated it), still
 * `active` (a human pause or the round budget bumped the revision or changed
 * the phase), and it must have been armed at detection. Disarming first clears
 * the process-local activation edge so `resume` can re-record it regardless of
 * listener order, and the revision bump also defeats the driver's pending
 * pause fence.
 */
function restoreGoalAutomation(ctx: Context, agent: Agent, armedGoal: ArmedGoalSnapshot | undefined): void {
  if (armedGoal === undefined) return
  const goals = ctx.get('goals') as GoalAutomationService | undefined
  if (goals === undefined) return
  let current: ReturnType<GoalAutomationService['get']>
  try {
    current = goals.get(agent)
  } catch (error: unknown) {
    ctx.logger.warn('degenerate-output-guard: could not re-read goal state for agent "%s": %s', agent.id, String(error))
    return
  }
  if (current === undefined || current.id !== armedGoal.id) return
  if (current.revision !== armedGoal.revision) return
  if (current.phase !== 'active') return
  try {
    goals.disarm(agent)
    goals.resume(agent, { id: armedGoal.id, revision: armedGoal.revision })
  } catch (error: unknown) {
    // Fail-safe direction: a refused resume leaves the goal stopped rather
    // than fighting another owner; the human decides what happens next.
    ctx.logger.warn('degenerate-output-guard: could not restore goal automation for agent "%s": %s', agent.id, String(error))
  }
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - schema-validated {@link Config}; ranges re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const tuning: Tuning = {
    windowChars: resolved.windowChars,
    checkEveryChars: resolved.checkEveryChars,
    minWindowLines: resolved.minWindowLines,
    distinctLineRatio: resolved.distinctLineRatio,
    cyclePeriodMax: resolved.cyclePeriodMax,
    cycleMatchRatio: resolved.cycleMatchRatio,
  }
  // Keyed by the exact live Agent object: entries vanish with the agent, so
  // disposal and replacement never leak attempt state.
  const states = new WeakMap<Agent, AgentState>()

  function stateFor(agent: Agent): AgentState {
    let state = states.get(agent)
    if (state === undefined) {
      state = {
        attempt: undefined,
        trip: undefined,
        chain: { depth: 0, pending: undefined, noticeTurn: undefined },
      }
      states.set(agent, state)
    }
    return state
  }

  /** Structured detection record. Counts only — no reasoning or text content. */
  function reportDetection(agent: Agent, trip: Trip, action: string): void {
    ctx.logger.warn('degenerate-output-guard: detected %o', {
      detection: trip.detectionId,
      agent: agent.id,
      attempt: trip.attemptId,
      turn: trip.turn,
      step: trip.step,
      block: trip.blockKind,
      charsSeen: trip.charsSeen,
      windowLines: trip.windowLines,
      distinctRatio: Number(trip.distinctRatio.toFixed(4)),
      period: trip.bestPeriod,
      matchRatio: Number(trip.matchRatio.toFixed(4)),
      action,
      recoveryDepth: trip.recoveryDepth,
    })
  }

  /**
   * Mark the detection once, record the trip facts, then cancel — in that
   * order. Both call sites run after the chunk-frame guard, so the attempt is
   * live and not yet tripped; the cancel is what stops further frames.
   */
  function trip(agent: Agent, state: AgentState, attempt: AttemptState, block: BlockState, degeneration: {
    bestPeriod: number
    matchRatio: number
    windowLines: number
    distinctRatio: number
  }): void {
    attempt.tripped = true
    const detectionId = `${attempt.attemptId}/${block.kind}/${block.detector.charsSeen}`
    const trip: Trip = {
      detectionId,
      attemptId: attempt.attemptId,
      turn: attempt.turn,
      step: attempt.step,
      blockKind: block.kind,
      bestPeriod: degeneration.bestPeriod,
      matchRatio: degeneration.matchRatio,
      windowLines: degeneration.windowLines,
      distinctRatio: degeneration.distinctRatio,
      charsSeen: block.detector.charsSeen,
      causeReason: `degenerate-output-guard:${detectionId}`,
      recoveryDepth: state.chain.depth,
      armedGoal: resolved.onDetect === 'abort-and-continue' ? snapshotArmedGoal(ctx, agent) : undefined,
    }
    state.trip = trip
    reportDetection(agent, trip, resolved.onDetect)
    if (resolved.onDetect === 'observe') return
    agent.cancel({ kind: 'hook', reason: trip.causeReason }, { keepInbox: true })
  }

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') {
      const state = stateFor(agent)
      state.attempt = {
        attemptId: frame.attemptId,
        turn: frame.turn,
        step: frame.step,
        blocks: new Map(),
        tripped: false,
      }
      return
    }
    const state = states.get(agent)
    if (state === undefined) return
    if (frame.type === 'end') {
      // The loop retires one attempt before the next starts, so this end
      // frame belongs to the attempt the guard saw start.
      state.attempt = undefined
      return
    }
    // chunk frame
    const attempt = state.attempt
    if (attempt === undefined || attempt.attemptId !== frame.attemptId || attempt.tripped) return
    const chunk = frame.chunk
    if (chunk.type === 'block-end') {
      // Final window evaluation at the block boundary, then drop the state:
      // blocks are deleted as they close, so per-attempt state stays bounded
      // by concurrently open blocks.
      const block = attempt.blocks.get(chunk.index)
      if (block === undefined) return
      attempt.blocks.delete(chunk.index)
      const degeneration = block.detector.evaluate()
      if (degeneration !== undefined) trip(agent, state, attempt, block, degeneration)
      return
    }
    const delta = deltaFields(chunk)
    if (delta === undefined || !watches(delta.kind, resolved.applyTo)) return
    let block = attempt.blocks.get(delta.index)
    if (block === undefined) {
      block = { kind: delta.kind, detector: new RepetitionDetector(tuning) }
      attempt.blocks.set(delta.index, block)
    }
    block.detector.push(delta.text)
    if (!block.detector.due()) return
    const degeneration = block.detector.evaluate()
    if (degeneration !== undefined) trip(agent, state, attempt, block, degeneration)
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const state = states.get(agent)
    if (state === undefined) return
    const chain = state.chain
    const pending = chain.pending
    if (pending !== undefined && message.id === pending.id) {
      chain.depth = pending.depth
      chain.pending = undefined
      chain.noticeTurn = turn
      return
    }
    if (isOwnNotice(message.source)) return
    if (chain.noticeTurn !== turn) chain.depth = 0
  })

  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    const state = states.get(agent)
    const pending = state?.chain.pending
    if (state === undefined || pending === undefined || pending.id !== message.id) return
    state.chain.pending = undefined
    // A discarded notice never reaches the model, so its correction is lost;
    // record the loss and release the chain slot it reserved.
    ctx.logger.warn('degenerate-output-guard: pending corrective notice discarded %o', {
      detection: pending.detection,
      agent: agent.id,
    })
  })

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'turn/end') return
    const agents = ctx.get('agents') as AgentRegistryService | undefined
    const agent = agents?.get(session.id)
    if (agent === undefined || agent.session !== session) return
    const state = states.get(agent)
    if (state === undefined) return
    // Consume the trip exactly once, whatever the ending turns out to be.
    const trip = state.trip
    state.trip = undefined
    if (state.chain.noticeTurn === event.data.turn) state.chain.noticeTurn = undefined
    if (trip === undefined) return
    const reason = event.data.reason
    // The cause reason embeds the attempt id, so a match pins this ending to
    // the exact abort the guard issued for its own detection.
    if (reason.kind !== 'aborted' || reason.reason.kind !== 'hook'
      || reason.reason.reason !== trip.causeReason) return
    if (resolved.onDetect !== 'abort-and-continue') return
    if (state.chain.depth >= resolved.maxRecoveryAttempts) {
      ctx.logger.warn('degenerate-output-guard: recovery budget exhausted %o', {
        detection: trip.detectionId,
        agent: agent.id,
        turn: trip.turn,
        recoveryDepth: state.chain.depth,
        maxRecoveryAttempts: resolved.maxRecoveryAttempts,
      })
      return
    }
    // Phase B runs one microtask after the turn/end publication settles: the
    // recovery appends to the same session log, and a session append cannot
    // reenter while another append is being published. The deferral is still
    // ahead of the loop driver's retirement (an `await` continuation), so the
    // goal restore below lands before the goal-round-driver's idle pause
    // check, and the queued notice lands before it requests its next drive.
    queueMicrotask(() => {
      // The recovery may outlive the agent or the guard fiber; both make the
      // turn unreachable, so recovery drops instead of touching dead state.
      const live = (ctx.get('agents') as AgentRegistryService | undefined)?.get(agent.id)
      /* v8 ignore next 3 -- the registry detaches an agent only after disposal quiescence, which this microtask precedes */
      if (live !== agent) {
        return
      }
      try {
        const notice = correctiveNotice(trip)
        state.chain.pending = { id: notice.id, depth: state.chain.depth + 1, detection: trip.detectionId }
        if (trip.armedGoal === undefined) {
          // No armed goal: the notice is the next turn's sole ordinary message.
          agent.followup(notice)
        } else {
          // Waking input submitted while the aborted driver converges is
          // reclassified to `next-turn` by the loop, which would take the
          // earlier turn and leave the goal driver's next round reservation
          // un-admitted across a turn — the driver answers that by pausing
          // the goal. Injecting instead parks the notice as `next-step`
          // context without waking: the driver's own round reservation
          // supplies the wake, the next turn claims both in one batch, and
          // the correction reaches the model together with the round prompt.
          // If the driver does not reserve (goal blocked or paused), the
          // notice joins whatever turn comes next.
          agent.inject(notice)
        }
        restoreGoalAutomation(ctx, agent, trip.armedGoal)
      } catch (error: unknown) {
        ctx.logger.warn('degenerate-output-guard: recovery failed for agent "%s": %s', agent.id, String(error))
      }
    })
  })
}
