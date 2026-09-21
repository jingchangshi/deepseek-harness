import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import * as Guard from '../src/index.ts'
import type { Config } from '../src/index.ts'
import {
  captureWarnings,
  ScriptedAdapter,
  admittedMessages,
  degenerateReasoningStream,
  guardBudgetWarnings,
  guardHookCause,
  guardDetections,
  textResponse,
  turnEndReasons,
} from './stream-scripts.ts'
import type { ScriptEntry } from './stream-scripts.ts'

/**
 * Goal integration: a guard abort during an armed goal round must not strand
 * the automation. The guard's cancel looks like a human stop to the
 * goal-round-driver, so the guard restores what it tore down — and delivers
 * its corrective notice as next-step context that rides the driver's next
 * round instead of displacing the reservation.
 */

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
})

interface Harness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly agent: Agent
  readonly warnings: unknown[][]
}

/** Boot the goal stack, the loop, and the guard with only the model scripted. */
async function harness(config: Config, script: ScriptEntry[]): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  const warnings = captureWarnings(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GoalService)
  await ctx.plugin(GoalRoundDriver)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Guard, config)
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(`guard-goal-${Math.random()}`), {
    provider: 'mock',
    model: 'mock',
  })
  return { ctx, adapter, agent, warnings }
}

/** Wait until the goal projection satisfies the predicate and return its view. */
async function waitForGoal(ctx: Context, agent: Agent, predicate: (goal: GoalView | undefined) => boolean): Promise<GoalView | undefined> {
  await vi.waitFor(() => {
    expect(predicate(ctx.goals.get(agent))).toBe(true)
  })
  return ctx.goals.get(agent)
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
function notices(harness: Harness): number {
  return admittedMessages(harness.agent)
    .filter(message => message.kind === 'plugin' && message.plugin === 'degenerate-output-guard')
    .length
}

/** Admitted goal-round numbers in order. */
function admittedRounds(harness: Harness): number[] {
  return harness.agent.session.snapshotEvents()
    .filter(event => event.type === 'user/message'
      && (event.data as { source: { kind: string; round?: number } }).source.kind === 'goal'
      && ((event.data as { source: { round?: number } }).source.round ?? 0) > 0)
    .map(event => (event.data as { source: { round: number } }).source.round)
}

describe('goal continuation through a guard abort', () => {
  it('keeps the goal running: the correction rides the next round and the budget advances (J)', async () => {
    const test = await harness(
      { onDetect: 'abort-and-continue' },
      [degenerateReasoningStream(), textResponse('the work is done')],
    )
    const created = test.ctx.goals.create(test.agent, { objective: 'keep the workspace green', maxGoalRounds: 2 })

    const final = await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'blocked')

    // Both rounds ran: the guard abort ended round 1, the goal was re-armed,
    // and round 2 was admitted with the corrective notice riding its batch.
    expect(final).toMatchObject({
      id: created.id,
      roundsStarted: 2,
      activation: 'disarmed',
    })
    expect(final?.blockedReason).toEqual({
      code: 'round-limit',
      message: 'Goal reached its configured limit of 2 rounds.',
    })
    expect(admittedRounds(test)).toEqual([1, 2])
    expect(turnEndReasons(test.agent)).toEqual([
      { kind: 'aborted', reason: { kind: 'hook', reason: guardHookCause() } },
      { kind: 'completed' },
    ])
    // The notice reached the model inside the continued round — no separate
    // corrective turn displaced the reservation.
    expect(requestText(test, 1)).toContain('<goal_round>')
    expect(requestText(test, 1)).toContain('Round: 2/2')
    expect(requestText(test, 1)).toContain('short repetition cycle')
    expect(notices(test)).toBe(1)
    expect(guardDetections(test.warnings)).toHaveLength(1)
    // The guard's notice is plugin context, never a human request.
    const notice = admittedMessages(test.agent).find(message => message.kind === 'plugin')
    expect(notice).toMatchObject({ kind: 'plugin', plugin: 'degenerate-output-guard' })
  })

  it('stops the goal after the corrective round degenerates again: budget exhausted, goal paused', async () => {
    const test = await harness(
      { onDetect: 'abort-and-continue' },
      [degenerateReasoningStream(), degenerateReasoningStream()],
    )
    test.ctx.goals.create(test.agent, { objective: 'hopeless task', maxGoalRounds: 5 })

    const final = await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'paused')

    // Two consecutive degenerate generations: the guard aborted round 1,
    // restored automation, and its notice rode round 2; round 2 degenerated
    // too, the budget was already spent, so the guard queued no second notice
    // and the driver's own cancelled-attempt policy paused the goal instead
    // of retry-looping.
    expect(final?.roundsStarted).toBe(2)
    expect(turnEndReasons(test.agent)).toEqual([
      { kind: 'aborted', reason: { kind: 'hook', reason: guardHookCause() } },
      { kind: 'aborted', reason: { kind: 'hook', reason: guardHookCause() } },
    ])
    expect(guardDetections(test.warnings)).toHaveLength(2)
    expect(guardBudgetWarnings(test.warnings)).toHaveLength(1)
    expect(notices(test)).toBe(1)
    expect(test.adapter.requests).toHaveLength(2)
  })

  it('restores automation torn down by an abort on a non-goal turn', async () => {
    const test = await harness(
      { onDetect: 'abort-and-continue' },
      [degenerateReasoningStream(), textResponse('recovered with the goal'), textResponse('second round done')],
    )
    // Queue the human turn first so the goal is created against a pending
    // competing message: the driver waits, and turn 1 is the human's.
    test.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'write the report' }],
      source: { kind: 'user' },
    }))
    test.ctx.goals.create(test.agent, { objective: 'keep the workspace green', maxGoalRounds: 2 })

    const final = await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'blocked')

    // The abort tore down the armed goal (disarm on a non-goal turn); the
    // guard restored it, and both rounds still ran to the round budget.
    expect(final?.roundsStarted).toBe(2)
    expect(final?.blockedReason?.code).toBe('round-limit')
    expect(admittedRounds(test)).toEqual([1, 2])
    expect(turnEndReasons(test.agent)).toEqual([
      { kind: 'aborted', reason: { kind: 'hook', reason: guardHookCause() } },
      { kind: 'completed' },
      { kind: 'completed' },
    ])
    expect(requestText(test, 1)).toContain('Round: 1/2')
    expect(requestText(test, 1)).toContain('short repetition cycle')
    expect(notices(test)).toBe(1)
  })

  it('keeps the recovery chain through a restored notice re-claim', async () => {
    const test = await harness(
      { onDetect: 'abort-and-continue' },
      [degenerateReasoningStream(), textResponse('unused'), textResponse('recovered by hand')],
    )
    test.ctx.goals.create(test.agent, { objective: 'paused before the round claim', maxGoalRounds: 5 })
    // Pause the goal when the driver queues its SECOND round reservation (the
    // first one starts round 1): that claim then finds a stale reservation,
    // the driver restores the other claimed messages, and the guard's notice
    // is claimed a second time later.
    let goalInserts = 0
    let paused = false
    test.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (message.source.kind !== 'goal') return
      goalInserts += 1
      if (!paused && goalInserts === 2) {
        paused = true
        const goal = test.ctx.goals.get(agent)
        if (goal !== undefined) test.ctx.goals.pause(agent, { id: goal.id, revision: goal.revision })
      }
    })

    const final = await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'paused')
    expect(final?.roundsStarted).toBe(1)

    // The rejected reservation turned into a blocked turn; the restored notice
    // waited, and the human turn re-claimed it as ordinary context.
    test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue by hand' }], source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(test.agent.status).toBe('idle')
      expect(test.adapter.requests).toHaveLength(2)
      expect(test.agent.inbox.nextTurn).toHaveLength(0)
      expect(test.agent.inbox.nextStep).toHaveLength(0)
    })

    expect(turnEndReasons(test.agent)).toEqual([
      { kind: 'aborted', reason: { kind: 'hook', reason: guardHookCause() } },
      { kind: 'blocked' },
      { kind: 'completed' },
    ])
    // Round 1 ran before the pause; its reservation was admitted. Round 2's
    // reservation was rejected before any admission.
    expect(admittedRounds(test)).toEqual([1])
    expect(notices(test)).toBe(1)
    expect(requestText(test, 1)).toContain('short repetition cycle')
    expect(guardDetections(test.warnings)).toHaveLength(1)
  })
})
