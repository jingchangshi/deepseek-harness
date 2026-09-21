import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import * as Guard from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { healthyPrefix } from './fixtures.ts'
import {
  ScriptedAdapter,
  admittedMessages,
  degenerateReasoningStream,
  captureWarnings,
  guardBudgetWarnings,
  guardHookCause,
  guardDetections,
  healthyResponse,
  textResponse,
  turnEndReasons,
} from './stream-scripts.ts'
import type { ScriptEntry } from './stream-scripts.ts'

/**
 * Lifecycle suite: the guard driven through a real agent loop with a scripted
 * adapter. Covers trip-once semantics, synchronous cancel reentrancy, the
 * two-phase recovery split, the cross-turn recovery budget, every intervention
 * rung, block-kind isolation, per-attempt state reset, fiber-disposal
 * freshness, and fail-loud config validation.
 */

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
})

interface Harness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly agent: Agent
  /** Every warn captured from the root logger; index-parallel with the guard's structured records. */
  readonly warnings: unknown[][]
}

/** Boot the loop and the guard with only the model scripted. */
async function harness(config: Config, script: ScriptEntry[]): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  const warnings = captureWarnings(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Guard, config)
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(`guard-session-${Math.random()}`), {
    provider: 'mock',
    model: 'mock',
  })
  return { ctx, adapter, agent, warnings }
}

/** Queue one human turn and wait until the whole flow settles: idle, no pending input, and the expected request count. */
async function runTurn(harness: Harness, text: string, expectedRequests: number): Promise<void> {
  harness.agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await vi.waitFor(() => {
    expect(harness.agent.status).toBe('idle')
    expect(harness.adapter.requests).toHaveLength(expectedRequests)
    expect(harness.agent.inbox.nextTurn).toHaveLength(0)
    expect(harness.agent.inbox.nextStep).toHaveLength(0)
  })
}

/** Full request history as one string. */
function requestText(harness: Harness, index: number): string {
  const request = harness.adapter.requests[index]
  if (request === undefined) throw new Error(`missing request ${index}`)
  return request.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** The guard's own notice messages admitted into the log. */
function notices(agent: Agent): Array<Record<string, unknown>> {
  return admittedMessages(agent)
    .filter(message => message.kind === 'plugin' && message.plugin === 'degenerate-output-guard')
    .map(message => message as unknown as Record<string, unknown>)
}

/** Seq of the first session event matching the predicate. */
function eventSeq(harness: Harness, predicate: (event: SessionEvent) => boolean): number | undefined {
  for (const event of harness.agent.session.snapshotEvents()) {
    if (predicate(event)) return event.seq
  }
  return undefined
}

describe('abort-and-continue recovery', () => {
  it('aborts once at detection and recovers with exactly one corrective turn (B)', async () => {
    const test = await harness(
      { onDetect: 'abort-and-continue' },
      [degenerateReasoningStream(), textResponse('report written')],
    )
    await runTurn(test, 'write the report', 2)

    const reasons = turnEndReasons(test.agent)
    expect(reasons).toHaveLength(2)
    const detections = guardDetections(test.warnings)
    expect(detections).toHaveLength(1)
    expect(detections[0]).toMatchObject({
      block: 'reasoning',
      action: 'abort-and-continue',
      period: 6,
      recoveryDepth: 0,
    })
    // The abort cause is the guard's hook reason, derived from the detection id.
    expect(reasons[0]).toEqual({
      kind: 'aborted',
      reason: { kind: 'hook', reason: `degenerate-output-guard:${detections[0]!.detection}` },
    })
    expect(reasons[1]).toEqual({ kind: 'completed' })
    // Exactly one notice, admitted as plugin context after the human message.
    const log = admittedMessages(test.agent)
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ kind: 'user' })
    expect(log[1]).toMatchObject({ kind: 'plugin', plugin: 'degenerate-output-guard' })
    expect(log[1]!.text).toContain('short repetition cycle')
    // The corrective turn's request carried the notice.
    expect(requestText(test, 1)).toContain('short repetition cycle')
    expect(requestText(test, 1)).not.toContain('Let me write.')
  })

  it('persists the interrupted prefix and stays reentrant through the synchronous cancel (C)', async () => {
    const test = await harness(
      { onDetect: 'abort-and-continue' },
      [degenerateReasoningStream(), textResponse('recovered')],
    )
    await runTurn(test, 'write the report', 2)

    // The interrupted generation persisted its streamed prefix as an
    // interrupted assistant message carrying the degenerate content.
    const interrupted = test.agent.session.snapshotEvents().find(event =>
      event.type === 'assistant/message' && (event.data as { interrupted?: boolean }).interrupted === true)
    expect(interrupted).toBeDefined()
    const content = (interrupted!.data as { message: { content: Array<{ type: string; text?: string }> } }).message.content
    const text = content.filter(block => block.type === 'text' || block.type === 'reasoning')
      .map(block => block.text ?? '').join('\n')
    expect(text).toContain('Let me write.')
    expect(text).toContain('Writing.')

    // The abort cause identifies the guard, and the loop settled: the test
    // completing at all proves no deadlock around the synchronous cancel.
    expect(turnEndReasons(test.agent)[0]).toMatchObject({
      kind: 'aborted',
      reason: { kind: 'hook', reason: guardHookCause() },
    })
  })

  it('queues the corrective turn only after the aborted turn settles (D)', async () => {
    const test = await harness(
      { onDetect: 'abort-and-continue' },
      [degenerateReasoningStream(), textResponse('recovered')],
    )
    await runTurn(test, 'write the report', 2)

    // Phase order in the durable log: the aborted turn ends before the
    // guard's notice is admitted into its own followup turn.
    const abortedEndSeq = eventSeq(test, event =>
      event.type === 'turn/end' && (event.data as { reason: { kind: string } }).reason.kind === 'aborted')
    const noticeSeq = eventSeq(test, event =>
      event.type === 'user/message'
      && (event.data as { source: { kind: string; plugin?: string } }).source.kind === 'plugin'
      && (event.data as { source: { plugin?: string } }).source.plugin === 'degenerate-output-guard')
    expect(abortedEndSeq).toBeDefined()
    expect(noticeSeq).toBeDefined()
    expect(noticeSeq!).toBeGreaterThan(abortedEndSeq!)
  })

  it('stops after the corrective turn degenerates again: no third turn, one notice total (E)', async () => {
    const test = await harness(
      { onDetect: 'abort-and-continue' },
      [degenerateReasoningStream(), degenerateReasoningStream(), textResponse('never reached')],
    )
    await runTurn(test, 'write the report', 2)

    expect(turnEndReasons(test.agent)).toEqual([
      { kind: 'aborted', reason: { kind: 'hook', reason: guardHookCause() } },
      { kind: 'aborted', reason: { kind: 'hook', reason: guardHookCause() } },
    ])
    const detections = guardDetections(test.warnings)
    expect(detections).toHaveLength(2)
    // The chain deepened across the two consecutive guard-notice generations.
    expect(detections[0]).toMatchObject({ recoveryDepth: 0 })
    expect(detections[1]).toMatchObject({ recoveryDepth: 1 })
    expect(guardBudgetWarnings(test.warnings)).toHaveLength(1)
    // Exactly one notice was ever admitted; the exhausted budget queued none.
    expect(notices(test.agent)).toHaveLength(1)
    expect(test.adapter.requests).toHaveLength(2)
    expect(test.agent.inbox.nextTurn).toHaveLength(0)
    expect(test.agent.inbox.nextStep).toHaveLength(0)
  })

  it('renews the budget when a human turn interrupts the chain', async () => {
    const test = await harness(
      { onDetect: 'abort-and-continue', maxRecoveryAttempts: 1 },
      [
        degenerateReasoningStream(),
        textResponse('took a break'),
        degenerateReasoningStream(),
        textResponse('finished later'),
      ],
    )
    await runTurn(test, 'write the report', 2)
    // A human turn resets the chain, so the next degeneration recovers again.
    await runTurn(test, 'now do the other thing', 4)

    const detections = guardDetections(test.warnings)
    expect(detections).toHaveLength(2)
    expect(detections[1]).toMatchObject({ recoveryDepth: 0 })
    expect(notices(test.agent)).toHaveLength(2)
    expect(guardBudgetWarnings(test.warnings)).toHaveLength(0)
    expect(turnEndReasons(test.agent)).toHaveLength(4)
  })
})

describe('intervention rungs', () => {
  it('observe records the detection but never touches the conversation (F)', async () => {
    const test = await harness({ onDetect: 'observe' }, [degenerateReasoningStream()])
    await runTurn(test, 'write the report', 1)

    // The generation ran to its natural max-tokens end; the guard only logged.
    expect(turnEndReasons(test.agent)).toEqual([{ kind: 'max-tokens' }])
    const detections = guardDetections(test.warnings)
    expect(detections).toHaveLength(1)
    expect(detections[0]).toMatchObject({ action: 'observe', block: 'reasoning', period: 6 })
    expect(notices(test.agent)).toHaveLength(0)
    expect(admittedMessages(test.agent)).toHaveLength(1)
    // The persisted generation holds the full streamed text: nothing was cut.
    const generated = test.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
    expect(generated).toHaveLength(1)
    expect((generated[0]!.data as { interrupted?: boolean }).interrupted).toBeUndefined()
  })

  it('abort-only cancels the generation and queues no followup (G)', async () => {
    const test = await harness({ onDetect: 'abort-only' }, [degenerateReasoningStream()])
    await runTurn(test, 'write the report', 1)

    expect(turnEndReasons(test.agent)).toEqual([
      { kind: 'aborted', reason: { kind: 'hook', reason: guardHookCause() } },
    ])
    const detections = guardDetections(test.warnings)
    expect(detections).toHaveLength(1)
    expect(detections[0]).toMatchObject({ action: 'abort-only' })
    expect(notices(test.agent)).toHaveLength(0)
    expect(test.agent.inbox.nextTurn).toHaveLength(0)
    expect(test.agent.inbox.nextStep).toHaveLength(0)
  })

  it('defaults to the observe rung when config omits onDetect', async () => {
    const test = await harness({}, [degenerateReasoningStream()])
    await runTurn(test, 'write the report', 1)
    expect(turnEndReasons(test.agent)).toEqual([{ kind: 'max-tokens' }])
    expect(guardDetections(test.warnings)).toHaveLength(1)
    expect(notices(test.agent)).toHaveLength(0)
  })
})

describe('block-kind isolation and applyTo', () => {
  it('ignores reasoning blocks when applyTo is text (H1)', async () => {
    const test = await harness({ onDetect: 'abort-and-continue', applyTo: 'text' }, [degenerateReasoningStream()])
    await runTurn(test, 'write the report', 1)
    expect(guardDetections(test.warnings)).toHaveLength(0)
    expect(turnEndReasons(test.agent)).toEqual([{ kind: 'max-tokens' }])
  })

  it('watches both block kinds independently and trips on the degenerate one (H2)', async () => {
    const healthy = healthyPrefix(3_000, 0x2bad57)
    const text = healthyPrefix(10_000, 0x3bad57)
      + (() => {
        const unit = ['Let me write.', 'Writing.', 'Go.', 'OK.', 'Next.', 'Again.'].join('\n') + '\n'
        let body = ''
        while (body.length < 12_000) body += unit
        return body
      })()
    const mixed: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: healthy },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: healthy } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text },
      { type: 'block-end', index: 1, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]
    const test = await harness(
      { onDetect: 'abort-and-continue', applyTo: 'both' },
      [mixed, textResponse('recovered')],
    )
    await runTurn(test, 'write the report', 2)

    const detections = guardDetections(test.warnings)
    expect(detections).toHaveLength(1)
    // The healthy reasoning block closed clean; the text block tripped.
    expect(detections[0]).toMatchObject({ block: 'text', period: 6 })
    expect(turnEndReasons(test.agent)[0]).toMatchObject({ kind: 'aborted' })
  })

  it('resets detector state per attempt (H3)', async () => {
    const test = await harness({ onDetect: 'observe' }, [healthyResponse(), degenerateReasoningStream()])
    await runTurn(test, 'first', 1)
    await runTurn(test, 'second', 2)

    const detections = guardDetections(test.warnings)
    expect(detections).toHaveLength(1)
    // The detection belongs to the second attempt with a fresh character
    // count: no state leaked from the first attempt's healthy stream.
    expect(detections[0]!.charsSeen as number).toBeLessThan(14_000)
  })
})

describe('state ownership and cleanup', () => {
  it('starts with fresh chain state after the guard fiber is disposed and remounted (I)', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const warnings = captureWarnings(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new ScriptedAdapter([
      degenerateReasoningStream(),
      degenerateReasoningStream(),
      degenerateReasoningStream(),
      textResponse('finally'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId(`guard-dispose-${Math.random()}`), {
      provider: 'mock',
      model: 'mock',
    })
    const config: Config = { onDetect: 'abort-and-continue' }

    // First mount: the corrective turn degenerates and exhausts the budget.
    const first = await ctx.plugin(Guard, config)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'write the report' }], source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(agent.status).toBe('idle')
      expect(adapter.requests).toHaveLength(2)
      expect(agent.inbox.nextTurn).toHaveLength(0)
    })
    expect(guardBudgetWarnings(warnings)).toHaveLength(1)

    // Dispose and remount: the exhausted chain must not survive the fiber.
    await first.dispose()
    await ctx.plugin(Guard, config)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go again' }], source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(agent.status).toBe('idle')
      expect(adapter.requests).toHaveLength(4)
      expect(agent.inbox.nextTurn).toHaveLength(0)
    })
    expect(guardDetections(warnings)).toHaveLength(3)
    // The remounted instance recovered: a second notice was queued and served.
    expect(notices(agent)).toHaveLength(2)
  })

  it('rejects out-of-range config fail-loud at load', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(Guard, { windowChars: 0 })).rejects.toThrow(/invalid windowChars/)
    await expect(ctx.plugin(Guard, { checkEveryChars: 8000, windowChars: 4000 })).rejects.toThrow(/invalid checkEveryChars/)
    await expect(ctx.plugin(Guard, { distinctLineRatio: 0 })).rejects.toThrow(/invalid distinctLineRatio/)
    await expect(ctx.plugin(Guard, { distinctLineRatio: 1.5 })).rejects.toThrow(/invalid distinctLineRatio/)
    await expect(ctx.plugin(Guard, { cycleMatchRatio: 0 })).rejects.toThrow(/invalid cycleMatchRatio/)
    await expect(ctx.plugin(Guard, { minWindowLines: 1 })).rejects.toThrow(/invalid minWindowLines/)
    await expect(ctx.plugin(Guard, { cyclePeriodMax: 0 })).rejects.toThrow(/invalid cyclePeriodMax/)
    await expect(ctx.plugin(Guard, { maxRecoveryAttempts: -1 })).rejects.toThrow(/invalid maxRecoveryAttempts/)
    await expect(ctx.plugin(Guard, { onDetect: 'notify' } as unknown as Config)).rejects.toThrow()
    await expect(ctx.plugin(Guard, { applyTo: 'reasoning-and-text' } as unknown as Config)).rejects.toThrow()
  })
})

describe('goal-state edges', () => {
  /** Boot the loop, the guard, and the goal service (no round driver). */
  async function goalHarness(config: Config, script: ScriptEntry[]): Promise<Harness & { readonly goals: GoalService }> {
    const ctx = new Context()
    contexts.push(ctx)
    const warnings = captureWarnings(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(GoalService)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Guard, config)
    const adapter = new ScriptedAdapter(script)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId(`guard-goal-edge-${Math.random()}`), {
      provider: 'mock',
      model: 'mock',
    })
    return { ctx, adapter, agent, warnings, goals: ctx.goals }
  }

  /**
   * Replace the goal service's read with one that throws or reports drifted
   * state on demand; returns the untouched read for final assertions.
   */
  function breakGet(
    goals: GoalService,
    mode: 'always' | 'after-first' | 'undefined-after-first' | 'mutated-after-first' | 'paused-after-first',
  ): (agent: Parameters<GoalService['get']>[0]) => GoalView | undefined {
    let calls = 0
    const real = goals.get.bind(goals)
    const patched: (agent: Parameters<GoalService['get']>[0]) => GoalView | undefined = (agent) => {
      calls += 1
      const view = real(agent)
      if (mode === 'always' || (mode === 'after-first' && calls > 1)) throw new Error('goal state unreadable')
      if (mode === 'undefined-after-first' && calls > 1) return undefined
      if (mode === 'mutated-after-first' && calls > 1 && view !== undefined) {
        return { ...view, revision: view.revision + 1 }
      }
      if (mode === 'paused-after-first' && calls > 1 && view !== undefined) {
        return { ...view, phase: 'paused' as const }
      }
      return view
    }
    goals.get = patched
    return real
  }

  /** All captured warnings whose format string starts with the prefix. */
  function warnsStarting(warnings: unknown[][], prefix: string): unknown[][] {
    return warnings.filter(args => typeof args[0] === 'string' && args[0].startsWith(prefix))
  }

  it('treats absent, disarmed, and paused goals as nothing to restore, and still recovers', async () => {
    const test = await goalHarness(
      { onDetect: 'abort-and-continue' },
      [degenerateReasoningStream(), textResponse('one'), degenerateReasoningStream(), textResponse('two'),
        degenerateReasoningStream(), textResponse('three')],
    )
    const { goals } = test

    // No goal at all: the service is mounted but has nothing for this agent.
    await runTurn(test, 'first attempt', 2)
    expect(notices(test.agent)).toHaveLength(1)

    // A goal that is active but disarmed: the snapshot must not capture it.
    const second = await test.ctx.agentLoop.create(SessionId(`guard-goal-edge-2-${Math.random()}`), {
      provider: 'mock',
      model: 'mock',
    })
    goals.create(second, { objective: 'edge two', maxGoalRounds: 4 })
    goals.disarm(second)
    second.followup(createUserMessage({ content: [{ type: 'text', text: 'second attempt' }], source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(second.status).toBe('idle')
      expect(test.adapter.requests).toHaveLength(4)
    })

    // A paused goal: not active, so nothing to restore.
    const third = await test.ctx.agentLoop.create(SessionId(`guard-goal-edge-3-${Math.random()}`), {
      provider: 'mock',
      model: 'mock',
    })
    const pausedGoal = goals.create(third, { objective: 'edge three', maxGoalRounds: 4 })
    goals.pause(third, { id: pausedGoal.id, revision: pausedGoal.revision })
    third.followup(createUserMessage({ content: [{ type: 'text', text: 'third attempt' }], source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(third.status).toBe('idle')
      expect(test.adapter.requests).toHaveLength(6)
    })

    expect(guardDetections(test.warnings)).toHaveLength(3)
    expect(notices(test.agent)).toHaveLength(1)
    expect(warnsStarting(test.warnings, 'degenerate-output-guard: could not')).toHaveLength(0)
  })

  it('records unreadable goal state at detection and still recovers', async () => {
    const test = await goalHarness(
      { onDetect: 'abort-and-continue' },
      [degenerateReasoningStream(), textResponse('recovered anyway')],
    )
    test.goals.create(test.agent, { objective: 'unreadable at detection', maxGoalRounds: 4 })
    breakGet(test.goals, 'always')

    await runTurn(test, 'degenerate with unreadable goal', 2)

    expect(warnsStarting(test.warnings, 'degenerate-output-guard: could not read goal state')).toHaveLength(1)
    expect(guardDetections(test.warnings)).toHaveLength(1)
    expect(notices(test.agent)).toHaveLength(1)
    expect(turnEndReasons(test.agent)).toEqual([
      { kind: 'aborted', reason: { kind: 'hook', reason: guardHookCause() } },
      { kind: 'completed' },
    ])
  })

  it('records unreadable goal state at restore and leaves the goal as found', async () => {
    const test = await goalHarness(
      { onDetect: 'abort-and-continue' },
      [degenerateReasoningStream(), textResponse('recovered')],
    )
    test.goals.create(test.agent, { objective: 'unreadable at restore', maxGoalRounds: 4 })
    const realGet = breakGet(test.goals, 'after-first')

    test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'degenerate turn' }], source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(test.agent.status).toBe('idle')
      expect(test.adapter.requests).toHaveLength(1)
      // The armed-goal branch parks the notice as next-step context for the
      // goal driver's next round; with no driver mounted, a human turn wakes it.
      expect(test.agent.inbox.nextStep).toHaveLength(1)
    })

    test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(test.agent.status).toBe('idle')
      expect(test.adapter.requests).toHaveLength(2)
      expect(test.agent.inbox.nextTurn).toHaveLength(0)
      expect(test.agent.inbox.nextStep).toHaveLength(0)
    })

    expect(warnsStarting(test.warnings, 'degenerate-output-guard: could not re-read goal state')).toHaveLength(1)
    expect(notices(test.agent)).toHaveLength(1)
    expect(realGet(test.agent)).toMatchObject({ phase: 'active', activation: 'armed' })
  })

  it('skips the restore when the goal state drifted between detection and recovery', async () => {
    // Each mode simulates one interleaving the restore fence must refuse:
    // the goal vanished, another actor advanced it, or a human paused it.
    for (const mode of ['undefined-after-first', 'mutated-after-first', 'paused-after-first'] as const) {
      const test = await goalHarness(
        { onDetect: 'abort-and-continue' },
        [degenerateReasoningStream(), textResponse('recovered')],
      )
      test.goals.create(test.agent, { objective: `drifted (${mode})`, maxGoalRounds: 4 })
      breakGet(test.goals, mode)

      test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'degenerate turn' }], source: { kind: 'user' } }))
      await vi.waitFor(() => {
        expect(test.agent.status).toBe('idle')
        expect(test.adapter.requests).toHaveLength(1)
        expect(test.agent.inbox.nextStep).toHaveLength(1)
      })

      test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await vi.waitFor(() => {
        expect(test.agent.status).toBe('idle')
        expect(test.adapter.requests).toHaveLength(2)
        expect(test.agent.inbox.nextTurn).toHaveLength(0)
        expect(test.agent.inbox.nextStep).toHaveLength(0)
      })

      // The fence refused the restore, so no goal automation was re-armed.
      expect(warnsStarting(test.warnings, 'degenerate-output-guard: could not restore')).toHaveLength(0)
      expect(notices(test.agent)).toHaveLength(1)
    }
  })

  it('records a refused goal restore as a fail-safe skip', async () => {
    const test = await goalHarness(
      { onDetect: 'abort-and-continue' },
      [degenerateReasoningStream(), textResponse('recovered')],
    )
    test.goals.create(test.agent, { objective: 'refused resume', maxGoalRounds: 4 })
    test.goals.resume = () => {
      throw new Error('resume refused')
    }

    test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'degenerate turn' }], source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(test.agent.status).toBe('idle')
      expect(test.adapter.requests).toHaveLength(1)
      expect(test.agent.inbox.nextStep).toHaveLength(1)
    })

    test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(test.agent.status).toBe('idle')
      expect(test.adapter.requests).toHaveLength(2)
      expect(test.agent.inbox.nextTurn).toHaveLength(0)
      expect(test.agent.inbox.nextStep).toHaveLength(0)
    })

    expect(warnsStarting(test.warnings, 'degenerate-output-guard: could not restore goal automation')).toHaveLength(1)
    expect(notices(test.agent)).toHaveLength(1)
  })

  it('skips the restore when the goal service unmounts mid-recovery', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const warnings = captureWarnings(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const goalsFiber = await ctx.plugin(GoalService)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Guard, { onDetect: 'abort-and-continue' })
    // Drop the goal service the moment the guard queues its notice: the
    // recovery's restore step then finds no service to talk to.
    ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.source.kind === 'plugin' && message.source.plugin === 'degenerate-output-guard') {
        void goalsFiber.dispose()
      }
    })
    const adapter = new ScriptedAdapter([degenerateReasoningStream(), textResponse('continued by hand')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId(`guard-goal-edge-unmount-${Math.random()}`), {
      provider: 'mock',
      model: 'mock',
    })
    ctx.goals.create(agent, { objective: 'vanishes mid-recovery', maxGoalRounds: 4 })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'degenerate turn' }], source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(agent.status).toBe('idle')
      expect(adapter.requests).toHaveLength(1)
      // The injected notice is parked next-step; the goal service is gone.
      expect(agent.inbox.nextStep).toHaveLength(1)
      expect(ctx.get('goals')).toBeUndefined()
    })
    expect(warnsStarting(warnings, 'degenerate-output-guard: could not')).toHaveLength(0)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue by hand' }], source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(agent.status).toBe('idle')
      expect(adapter.requests).toHaveLength(2)
      expect(agent.inbox.nextTurn).toHaveLength(0)
      expect(agent.inbox.nextStep).toHaveLength(0)
    })
    // The parked notice rode the human turn it was batched with.
    expect(notices(agent)).toHaveLength(1)
  })

  it('records a discarded corrective notice and releases the chain slot', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const warnings = captureWarnings(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Guard, { onDetect: 'abort-and-continue' })
    // Drop the notice the moment it is queued, before the latched wake can
    // claim it: the removal appends to the session log, which is legal here
    // because the spliced append's publication has already returned.
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (message.source.kind === 'plugin' && message.source.plugin === 'degenerate-output-guard') {
        agent.inbox.remove(message.id)
      }
    })
    const adapter = new ScriptedAdapter([degenerateReasoningStream()])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId(`guard-discard-${Math.random()}`), {
      provider: 'mock',
      model: 'mock',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'degenerate turn' }], source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(agent.status).toBe('idle')
      expect(agent.inbox.nextTurn).toHaveLength(0)
      expect(agent.inbox.nextStep).toHaveLength(0)
    })

    expect(adapter.requests).toHaveLength(1)
    expect(warnsStarting(warnings, 'degenerate-output-guard: pending corrective notice discarded')).toHaveLength(1)
    // The discarded notice was never admitted to the log.
    expect(notices(agent)).toHaveLength(0)
  })

  it('starts a fresh recovery chain when another producer rides after a notice', async () => {
    const otherNotice = createUserMessage({
      content: [{ type: 'text', text: 'another producer context' }],
      source: { kind: 'plugin', plugin: 'another-plugin', form: 'notice', summary: 'another producer context' },
    })
    const test = await harness(
      { onDetect: 'abort-and-continue' },
      [degenerateReasoningStream(), textResponse('first recovery'),
        textResponse('ride-along'), degenerateReasoningStream(), textResponse('second recovery')],
    )
    await runTurn(test, 'degenerate turn', 2)
    expect(guardDetections(test.warnings)).toHaveLength(1)

    // The other producer's notice is claimed in its own turn: not the guard's
    // pending notice, not the guard's own notice — a fresh chain at depth 0.
    test.agent.followup(otherNotice)
    await vi.waitFor(() => {
      expect(test.agent.status).toBe('idle')
      expect(test.adapter.requests).toHaveLength(3)
      expect(test.agent.inbox.nextTurn).toHaveLength(0)
      expect(test.agent.inbox.nextStep).toHaveLength(0)
    })
    expect(notices(test.agent)).toHaveLength(1)

    // The next degeneration recovers again: the budget was renewed.
    await runTurn(test, 'degenerate again', 5)
    const detections = guardDetections(test.warnings)
    expect(detections).toHaveLength(2)
    expect(detections[1]).toMatchObject({ recoveryDepth: 0 })
    expect(notices(test.agent)).toHaveLength(2)
  })

  it('records a failed recovery delivery and leaves the turn aborted', async () => {
    const test = await harness(
      { onDetect: 'abort-and-continue' },
      [degenerateReasoningStream(), textResponse('first recovery'), degenerateReasoningStream()],
    )
    await runTurn(test, 'degenerate turn', 2)
    // Only the guard's recovery delivery fails; human turns still wake the loop.
    const realFollowup: (message: Parameters<typeof test.agent.followup>[0]) => void = test.agent.followup.bind(test.agent)
    test.agent.followup = (message) => {
      if (message.source.kind === 'plugin' && message.source.plugin === 'degenerate-output-guard') {
        throw new Error('injected delivery failure')
      }
      realFollowup(message)
    }

    // The second degeneration is a human turn: a fresh chain at depth 0, so
    // the recovery is attempted — and its delivery fails.
    test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second degenerate turn' }], source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(test.agent.status).toBe('idle')
      expect(test.adapter.requests).toHaveLength(3)
      expect(test.agent.inbox.nextTurn).toHaveLength(0)
    })

    expect(warnsStarting(test.warnings, 'degenerate-output-guard: recovery failed')).toHaveLength(1)
    expect(guardDetections(test.warnings)).toHaveLength(2)
    expect(notices(test.agent)).toHaveLength(1)
    expect(turnEndReasons(test.agent)).toEqual([
      { kind: 'aborted', reason: { kind: 'hook', reason: guardHookCause() } },
      { kind: 'completed' },
      { kind: 'aborted', reason: { kind: 'hook', reason: guardHookCause() } },
    ])
  })

  it('ignores turn endings of sessions without a registry agent', async () => {
    const test = await harness({ onDetect: 'abort-and-continue' }, [textResponse('unused')])
    const foreign = test.ctx.sessions.create(SessionId(`foreign-session-${Math.random()}`))
    foreign.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // The guard's correlation requires a registry agent; a foreign session's
    // events never reach chain or trip state.
    expect(guardDetections(test.warnings)).toHaveLength(0)
  })

  it('ignores stream frames for an attempt the guard never saw start', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const warnings = captureWarnings(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new ScriptedAdapter([
      { chunks: degenerateReasoningStream(), stallAfter: 1 },
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId(`guard-late-${Math.random()}`), {
      provider: 'mock',
      model: 'mock',
    })

    // Start the turn, let the stream begin, and only then mount the guard:
    // its state map has no attempt for the in-flight stream.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'late mount' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    await ctx.plugin(Guard, { onDetect: 'abort-and-continue' })
    adapter.resume()
    await vi.waitFor(() => {
      expect(agent.status).toBe('idle')
      expect(agent.inbox.nextTurn).toHaveLength(0)
      expect(agent.inbox.nextStep).toHaveLength(0)
    })

    // No detection, no abort: the guard never saw the attempt it would judge.
    expect(guardDetections(warnings)).toHaveLength(0)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'max-tokens' }])
  })

  it('trips from the final block-boundary evaluation when no mid-stream window suspects', async () => {
    // With the amortized mid-stream check as wide as the window, no mid-stream
    // evaluation fires for this short stream: the block boundary is the only
    // evaluation, and its window is dominated by the one-line cycle.
    const test = await harness(
      { onDetect: 'abort-and-continue', windowChars: 8000, checkEveryChars: 8000 },
      [degenerateReasoningStream({ prefixChars: 500, cycleChars: 3600, cycle: 'OK.\n' }), textResponse('recovered')],
    )
    await runTurn(test, 'degenerate only at the boundary', 2)

    const detections = guardDetections(test.warnings)
    expect(detections).toHaveLength(1)
    expect(detections[0]).toMatchObject({ block: 'reasoning', period: 1 })
    expect(turnEndReasons(test.agent)).toEqual([
      { kind: 'aborted', reason: { kind: 'hook', reason: guardHookCause() } },
      { kind: 'completed' },
    ])
  })

  it('ignores discards of messages other than the pending notice', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const warnings = captureWarnings(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Guard, { onDetect: 'abort-and-continue' })
    const removed: string[] = []
    let userInserts = 0
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      // Drop every user message after the first: foreign discards must leave
      // the guard's chain state untouched.
      if (message.source.kind === 'user' && ++userInserts >= 2) {
        removed.push(message.id)
        agent.inbox.remove(message.id)
      }
    })
    const adapter = new ScriptedAdapter([degenerateReasoningStream(), textResponse('recovered')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId(`guard-discard-other-${Math.random()}`), {
      provider: 'mock',
      model: 'mock',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'degenerate turn' }], source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(agent.status).toBe('idle')
      expect(adapter.requests).toHaveLength(2)
      expect(agent.inbox.nextTurn).toHaveLength(0)
      expect(agent.inbox.nextStep).toHaveLength(0)
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'queued then dropped' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(agent.status).toBe('idle') })
    await vi.waitFor(() => { expect(agent.inbox.nextTurn).toHaveLength(0) })

    // A discard for an agent the guard never streamed (no turn ran) finds no
    // guard state at all.
    const fresh = await ctx.agentLoop.create(SessionId(`guard-discard-fresh-${Math.random()}`), {
      provider: 'mock',
      model: 'mock',
    })
    fresh.followup(createUserMessage({ content: [{ type: 'text', text: 'dropped before any turn' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(fresh.status).toBe('idle') })

    // The foreign discards stayed silent, and the notice still reached the log.
    expect(removed).toHaveLength(2)
    expect(adapter.requests).toHaveLength(2)
    expect(warnsStarting(warnings, 'degenerate-output-guard: pending corrective notice discarded')).toHaveLength(0)
    expect(notices(agent)).toHaveLength(1)
  })
})
