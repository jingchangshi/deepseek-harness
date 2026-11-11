/**
 * Unit + real-load-path coverage for @deepseek-ai/dsh-tool-call-timeout-policy. The
 * timeout-wins cases drive the deadline under fake timers (deterministic — no
 * wall-clock race) and use a COOPERATIVE tool that settles only when its
 * `exec.signal` aborts, mirroring how a real capability forwards the signal and
 * reaches quiescence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId, HarnessError } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, TOOL_ABORTED, type ToolExecutionInput, type ToolExecutionResult, type PostToolDecision } from '@deepseek-ai/dsh-tools'
import * as timeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
import { TOOL_TIMEOUT, quiescentTimeoutOutcome } from '@deepseek-ai/dsh-tool-call-timeout-policy'

const testToolSignal = new AbortController().signal

/** Mount the registry + the zero-config timeout-policy enforcer. */
async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(timeoutPolicy)
  return ctx
}

/** A cooperative tool that settles ONLY when its exec.signal aborts (returns text). */
const cooperativeTool = defineContentToolFixture({
  name: 'slow', description: 'stops when aborted', parameters: {}, timeoutMs: 100,
  execute(_args, exec): Promise<{ type: 'text'; text: string }[]> {
    const done = [{ type: 'text' as const, text: 'stopped cooperatively' }]
    if (exec.signal.aborted) return Promise.resolve(done)
    return new Promise((resolve) => { exec.signal.addEventListener('abort', () => { resolve(done) }) })
  },
})

/** A cooperative tool that THROWS its own upstream-abort error when aborted (web-provider shape). */
const abortThrowingTool = defineContentToolFixture({
  name: 'aborter', description: 'throws WEB_ABORTED when aborted', parameters: {}, timeoutMs: 100,
  execute(_args, exec): Promise<never> {
    if (exec.signal.aborted) return Promise.reject(new HarnessError('web fetch aborted', 'WEB_ABORTED'))
    return new Promise((_resolve, reject) => { exec.signal.addEventListener('abort', () => { reject(new HarnessError('web fetch aborted', 'WEB_ABORTED')) }) })
  },
})

describe('timeout-policy delegation (unconfigured / fast)', () => {
  it('delegates a tool with NO declared budget unchanged and does not touch exec.signal', async () => {
    const ctx = await setup()
    let seenSignal: AbortSignal | undefined
    ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'd', parameters: {},
      async execute(_a, exec) { seenSignal = exec.signal; return [{ type: 'text' as const, text: 'ok' }] } }))
    const upstream = new AbortController().signal
    const result = await ctx.tools.execute({ callId: ToolCallId('c1'), name: 'probe', arguments: {}, signal: upstream })
    expect(result.isError).toBe(false)
    expect(seenSignal).toBe(upstream)
  })

  it('a tool with a budget that returns fast keeps its own result (no timeout)', async () => {
    const ctx = await setup()
    ctx.tools.register(defineContentToolFixture({ name: 'fast', description: 'd', parameters: {}, timeoutMs: 10_000,
      async execute() { return [{ type: 'text' as const, text: 'ok' }] } }))
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c1'), name: 'fast', arguments: {} })
    expect(result).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      value: [{ type: 'text', text: 'ok' }],
    })
  })

  it('a budgeted tool receives the DERIVED deadline signal (not the caller signal) during dispatch', async () => {
    const ctx = await setup()
    let seenSignal: AbortSignal | undefined
    ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'd', parameters: {}, timeoutMs: 10_000,
      async execute(_a, exec) { seenSignal = exec.signal; return [{ type: 'text' as const, text: 'ok' }] } }))
    const upstream = new AbortController().signal
    await ctx.tools.execute({ callId: ToolCallId('c1'), name: 'probe', arguments: {}, signal: upstream })
    expect(seenSignal).toBeDefined()
    expect(seenSignal).not.toBe(upstream)
  })
})

describe('timeout-policy signal restoration', () => {
  it('restores the caller signal for post-execute after wrapping', async () => {
    const ctx = await setup()
    ctx.tools.register(defineContentToolFixture({ name: 'fast', description: 'd', parameters: {}, timeoutMs: 10_000,
      async execute() { return [{ type: 'text' as const, text: 'ok' }] } }))
    let postSignal: AbortSignal | undefined | 'unset' = 'unset'
    ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => { postSignal = exec.signal; return next() })
    const upstream = new AbortController().signal
    await ctx.tools.execute({ callId: ToolCallId('c1'), name: 'fast', arguments: {}, signal: upstream })
    expect(postSignal).toBe(upstream)
  })
})

describe('timeout-policy TOOL_TIMEOUT replacement (deadline wins)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('replaces a cooperative tool result with TOOL_TIMEOUT when its own deadline fires', async () => {
    const ctx = await setup()
    ctx.tools.register(cooperativeTool)
    const pending = ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c1'), name: 'slow', arguments: {} })
    await vi.advanceTimersByTimeAsync(150)
    const result = await pending
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: tool call timed out after 100ms' }],
      isError: true,
      error: {
        message: 'tool call timed out after 100ms',
        info: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' },
      },
    })
  })

  it('replaces a provider-owned abort ERROR result with TOOL_TIMEOUT when the signal was ours', async () => {
    const ctx = await setup()
    ctx.tools.register(abortThrowingTool)
    const pending = ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c1'), name: 'aborter', arguments: {} })
    await vi.advanceTimersByTimeAsync(150)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({
      message: 'tool call timed out after 100ms',
      info: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' },
    })
    expect(result.content[0]).toMatchObject({ text: 'Error: tool call timed out after 100ms' })
  })

  it('preserves registry ABORTED when the caller aborts first (upstream cancel, not our timeout)', async () => {
    const ctx = await setup()
    const entered = Promise.withResolvers<undefined>()
    ctx.tools.register(defineContentToolFixture({
      name: 'slow', description: 'stops when aborted', parameters: {}, timeoutMs: 100,
      execute(_args, exec) {
        entered.resolve(undefined)
        const done = [{ type: 'text' as const, text: 'stopped cooperatively' }]
        if (exec.signal.aborted) return Promise.resolve(done)
        return new Promise((resolve) => {
          exec.signal.addEventListener('abort', () => { resolve(done) }, { once: true })
        })
      },
    }))
    const upstream = new AbortController()
    const pending = ctx.tools.execute({ callId: ToolCallId('c1'), name: 'slow', arguments: {}, signal: upstream.signal })
    await entered.promise
    upstream.abort('user cancelled')
    await vi.advanceTimersByTimeAsync(0)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({
      message: 'tool call aborted',
      info: { name: 'AbortError', code: TOOL_ABORTED },
    })
    expect(result.content[0]).toMatchObject({ text: 'Error: tool call aborted' })
  })

  it('preserves TOOL_TIMEOUT when the deadline wins before a later caller abort', async () => {
    const ctx = await setup()
    const sawAbort = Promise.withResolvers<undefined>()
    const releaseCleanup = Promise.withResolvers<undefined>()
    ctx.tools.register(defineContentToolFixture({
      name: 'slow-cleanup', description: 'settles after abort cleanup', parameters: {}, timeoutMs: 100,
      async execute(_args, exec) {
        if (!exec.signal.aborted) {
          await new Promise<undefined>((resolve) => {
            exec.signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
          })
        }
        sawAbort.resolve(undefined)
        await releaseCleanup.promise
        return [{ type: 'text' as const, text: 'cleanup complete' }]
      },
    }))
    const upstream = new AbortController()
    const pending = ctx.tools.execute({
      callId: ToolCallId('timeout-first'), name: 'slow-cleanup', arguments: {}, signal: upstream.signal,
    })

    await vi.advanceTimersByTimeAsync(100)
    await sawAbort.promise
    upstream.abort('too late to replace timeout')
    releaseCleanup.resolve(undefined)

    await expect(pending).resolves.toMatchObject({
      isError: true,
      error: {
        message: 'tool call timed out after 100ms',
        info: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' },
      },
    })
  })
})

describe('timeout-policy contract', () => {
  it('exposes the owned code constant', () => {
    expect(TOOL_TIMEOUT).toBe('TOOL_TIMEOUT')
  })
})

describe('timeout-policy disposal (HMR safety)', () => {
  it('removes its tools/execute listener when the plugin fiber disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    let seenSignal: AbortSignal | undefined
    ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'd', parameters: {}, timeoutMs: 10_000,
      async execute(_a, exec) { seenSignal = exec.signal; return [{ type: 'text' as const, text: 'ok' }] } }))
    const fiber = await ctx.plugin(timeoutPolicy)
    const upstream = new AbortController().signal
    await ctx.tools.execute({ callId: ToolCallId('c1'), name: 'probe', arguments: {}, signal: upstream })
    expect(seenSignal).not.toBe(upstream)
    await fiber.dispose()
    await ctx.tools.execute({ callId: ToolCallId('c2'), name: 'probe', arguments: {}, signal: upstream })
    expect(seenSignal).toBe(upstream)
  })
})

describe('dsh-tool-call-timeout-policy real-load-path guard', () => {
  it('has no default export and keeps name/inject through unwrapExports', () => {
    expect('default' in timeoutPolicy).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(timeoutPolicy) as Record<string, unknown>
    expect(unwrapped).toBe(timeoutPolicy)
    expect(unwrapped.name).toBe('timeout-policy')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots over ctx.tools through the unwrapped module and wraps a budgeted tool', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(defineContentToolFixture({ name: 'fast', description: 'd', parameters: {}, timeoutMs: 5_000,
      async execute() { return [{ type: 'text' as const, text: 'ok' }] } }))
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(timeoutPolicy) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped)
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c1'), name: 'fast', arguments: {} } satisfies ToolExecutionInput)
    expect(result.isError).toBe(false)
    await fiber.dispose()
  })
})

describe('quiescentTimeoutOutcome (F5, session 757fa075 seq 573)', () => {
  /**
   * Build the success shape a tool returns after it stops at its deadline.
   * `partial` models whether the tool called `exec.declarePartial()`.
   */
  const successWith = (text: string, partial = false): ToolExecutionResult => ({
    isError: false,
    value: text,
    content: [{ type: 'text', text }],
    ...partial ? { partial: true as const } : {},
  })

  it('PRESERVES a CLAIMED partial result instead of replacing it with TOOL_TIMEOUT', () => {
    // The shape a real paging capability has after a deadline: it stopped, it
    // KEPT what it collected, it labelled the result, and it CLAIMED the
    // content is deliberately partial. Before the fix this was overwritten with
    // a bare TOOL_TIMEOUT and every collected match was lost.
    const partial = successWith('Session search results (3):\n1. Session alpha\n\n(WARNING: PARTIAL results.', true)
    const outcome = quiescentTimeoutOutcome(partial, 100)
    expect(outcome).toBe(partial)
    expect(outcome.isError).toBe(false)
    expect(JSON.stringify(outcome.content)).toContain('Session search results (3)')
    expect(JSON.stringify(outcome.content)).toContain('PARTIAL')
  })

  it('REPLACES an UNCLAIMED success, so a give-up placeholder is never presented as a result', () => {
    // The reason the claim exists. This is byte-identical to the preserved case
    // above except that the tool never asserted its content was partial, so the
    // plugin must not guess from content shape: a tool that gave up may have
    // returned exactly this.
    const unclaimed = successWith('Session search results (3):\n1. Session alpha')
    const outcome = quiescentTimeoutOutcome(unclaimed, 100)
    expect(outcome.isError).toBe(true)
    expect(outcome.isError ? outcome.error.info?.code : undefined).toBe(TOOL_TIMEOUT)
    expect(JSON.stringify(outcome.content)).not.toContain('Session alpha')
  })

  it('KEEPS an empty timeout a hard typed TOOL_TIMEOUT, never a silent empty success', () => {
    // A cooperative tool that reached quiescence with nothing to show. "We ran
    // out of time before finding anything" must never be reported as "there is
    // nothing to find".
    const empty: ToolExecutionResult = { isError: false, value: '', content: [] }
    expect(quiescentTimeoutOutcome(empty, 100)).toEqual({
      content: [{ type: 'text', text: 'Error: tool call timed out after 100ms' }],
      isError: true,
      error: {
        message: 'tool call timed out after 100ms',
        info: { name: 'ToolTimeoutError', code: TOOL_TIMEOUT },
      },
    })
  })

  it('does NOT treat a claim on an EMPTY result as a licence to succeed', () => {
    // A claimed-but-empty success still has nothing to show, so the claim cannot
    // rescue it: the model would learn nothing and "no matches" would be a lie.
    const claimedEmpty: ToolExecutionResult = {
      isError: false, value: '', content: [], partial: true as const,
    }
    const outcome = quiescentTimeoutOutcome(claimedEmpty, 250)
    expect(outcome.isError).toBe(true)
    expect(outcome.isError ? outcome.error.info?.code : undefined).toBe(TOOL_TIMEOUT)
  })

  it('does NOT treat a claim on WHITESPACE-only content as a licence to succeed', () => {
    const claimedBlank = successWith('   \n\t ', true)
    const outcome = quiescentTimeoutOutcome(claimedBlank, 250)
    expect(outcome.isError).toBe(true)
    expect(outcome.isError ? outcome.error.info?.code : undefined).toBe(TOOL_TIMEOUT)
  })

  it('replaces a tool\'s OWN error result, so an empty timeout stays typed', () => {
    const failed: ToolExecutionResult = {
      isError: true,
      content: [{ type: 'text', text: 'Error: upstream refused' }],
      error: { message: 'upstream refused', info: { name: 'HarnessError', code: 'WEB_REFUSED' } },
    }
    const outcome = quiescentTimeoutOutcome(failed, 100)
    expect(outcome.isError).toBe(true)
    expect(outcome.isError ? outcome.error.info?.code : undefined).toBe(TOOL_TIMEOUT)
  })

  it('counts NON-TEXT content as empty, because the model cannot see a block it cannot read', () => {
    // An image-only success has nothing the model can act on as search results,
    // so it must not masquerade as a preserved partial result.
    const imageOnly: ToolExecutionResult = {
      isError: false,
      value: '',
      // A well-formed image block; the attachment fields are irrelevant here
      // because the assertion is about the BLOCK TYPE, so the fixture carries
      // the minimum the type demands rather than faking image bytes.
      content: [{
        type: 'image',
        attachment: {
          attachmentId: 'img-1',
          mediaType: 'image/png',
          bytes: 4,
          width: 1,
          height: 1,
        },
      } as never],
    }
    const outcome = quiescentTimeoutOutcome(imageOnly, 100)
    expect(outcome.isError).toBe(true)
  })

  it('a deadline that finds NOTHING still reports TOOL_TIMEOUT through the full registry pipeline', async () => {
    // Integration-level proof of the empty half. The preserved half cannot be
    // asserted here: the registry replaces ANY successful result with ABORTED
    // before this wrapper sees it (see toolAbortedResult in core/tools), so the
    // partial path is proved by the pure cases above plus the session-query
    // suite, which drives the collector directly.
    vi.useFakeTimers()
    try {
      const ctx = await setup()
      ctx.tools.register(defineContentToolFixture({
        name: 'empty', description: 'settles with nothing when aborted', parameters: {}, timeoutMs: 100,
        execute(_args, exec): Promise<{ type: 'text'; text: string }[]> {
          const done: { type: 'text'; text: string }[] = []
          if (exec.signal.aborted) return Promise.resolve(done)
          return new Promise((resolve) => {
            exec.signal.addEventListener('abort', () => { resolve(done) }, { once: true })
          })
        },
      }))
      const pending = ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c1'), name: 'empty', arguments: {} })
      await vi.advanceTimersByTimeAsync(150)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.isError ? result.error.info?.code : undefined).toBe(TOOL_TIMEOUT)
      expect(result.content).toEqual([{ type: 'text', text: 'Error: tool call timed out after 100ms' }])
    } finally {
      vi.useRealTimers()
    }
  })
})
