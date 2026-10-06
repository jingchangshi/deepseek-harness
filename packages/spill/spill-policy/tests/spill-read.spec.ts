/**
 * End-to-end recovery through the model-facing `spill_read` tool: the policy
 * spills to `LocalSpillStore`, the inline preview omits part of the full text,
 * and the model retrieves that omitted content from the opaque locator. Also
 * pins the clear failure behavior when no backend is mounted and when a
 * save-only backend does not implement retrieval.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { ReadTextSpill, SaveTextSpill, SpillRead, SpillRef } from '@deepseek-ai/dsh-spill'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as SpillPolicy from '../src/index.ts'

function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function textTool(name: string, text: string) {
  return defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute(): Promise<ContentBlock[]> {
      return [{ type: 'text', text }]
    },
  })
}

function exec(name: string, session = 's1'): ToolExecution {
  const agent = { session: { header: { id: SessionId(session) } } }
  return { callId: ToolCallId(`call-${name}`), name, arguments: {}, agent, signal: new AbortController().signal } as ToolExecution
}

function savedRef(input: SaveTextSpill): SpillRef {
  return {
    locator: SpillLocator(`/spill/${input.suggestedName}`),
    bytes: Buffer.byteLength(input.content, 'utf8'),
    retrievalHint: 'Use spill_read with this locator.',
  }
}

async function localContext(readMaxBytes = 65536, readMaxOutputBytes = 65536) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-spill-read-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSpillStore, { root: join(root, 'spill'), cleanupPeriodDays: 0, readMaxBytes })
  await ctx.plugin(SpillPolicy, { maxInlineTokens: 96, readMaxOutputBytes })
  onTestFinished(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  return { ctx }
}

async function localContextWithPolicyDefaults() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-spill-read-default-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSpillStore, { root: join(root, 'spill'), cleanupPeriodDays: 0 })
  SpillPolicy.apply(ctx, { maxInlineTokens: 96 })
  onTestFinished(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  return { ctx }
}

async function spillRead(ctx: Context, locator: string, session = 's1', byteOffset?: number) {
  return ctx.tools.execute({
    ...exec('spill_read', session),
    callId: ToolCallId('spill-read-call'),
    name: 'spill_read',
    arguments: { locator, ...(byteOffset === undefined ? {} : { byteOffset }) },
    signal: new AbortController().signal,
  })
}

describe('spill_read end-to-end recovery', () => {
  it('advertises retrieval without enabling retention and releases its registration on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const policy = await ctx.plugin(SpillPolicy, {})
    onTestFinished(() => ctx.fiber.dispose())
    expect(ctx.tools.get('spill_read')?.name).toBe('spill_read')
    await policy.dispose()
    expect(ctx.tools.get('spill_read')).toBeUndefined()
  })

  it('retrieves an oversized single line through byte pages without re-spilling', async () => {
    const { ctx } = await localContext(128, 512)
    const content = '😀界'.repeat(1000)
    const ref = await ctx.spillStore.saveText({
      owner: { sessionId: SessionId('parent') },
      source: { kind: 'session-reference', sessionId: SessionId('referenced-source'), label: 'context' },
      suggestedName: 'context.txt', content,
    })
    let byteOffset = 0
    let recovered = ''
    for (let page = 0; page < 100; page += 1) {
      const result = await spillRead(ctx, ref.locator, 'fork-child', byteOffset)
      expect(result.isError).toBe(false)
      const body = textOf(result.content)
      const pageText = /^1: ([\s\S]*)\n\n\(/.exec(body)?.[1]
      expect(pageText).toBeTypeOf('string')
      if (pageText === undefined) throw new Error('missing retrieved page text')
      expect(Buffer.byteLength(pageText)).toBeLessThanOrEqual(128)
      expect(body).not.toContain('Full formatted result stored at:')
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(512)
      recovered += pageText
      const continuation = /Use byteOffset=(\d+) to continue/.exec(body)?.[1]
      if (continuation === undefined) break
      expect(Number(continuation)).toBeGreaterThan(byteOffset)
      byteOffset = Number(continuation)
    }
    expect(recovered).toBe(content)
  })

  it('rejects a read output cap that cannot hold the minimum result envelope', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(SpillPolicy, { readMaxOutputBytes: 128 })).rejects.toThrow(/readMaxOutputBytes.*512/)
    await ctx.fiber.dispose()
  })

  it('applies the output-cap validation when the plugin entry is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    expect(() => {
      SpillPolicy.apply(ctx, { readMaxOutputBytes: 128 })
    }).toThrow(/readMaxOutputBytes.*512/)
    await ctx.fiber.dispose()
  })

  it('applies the default output cap when the plugin entry receives no value', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    SpillPolicy.apply(ctx, {})
    expect(ctx.tools.get('spill_read')?.name).toBe('spill_read')
    await ctx.fiber.dispose()
  })

  it('retrieves a spill-omitted line from a saved LocalSpillStore artifact', async () => {
    const { ctx } = await localContext()
    const full = Array.from({ length: 300 }, (_, index) => `line-${String(index).padStart(3, '0')}-${'x'.repeat(20)}`).join('\n')
    ctx.tools.register(textTool('big', full))
    const preview = await ctx.tools.execute(exec('big'))

    expect(preview.isError).toBe(false)
    const previewText = textOf(preview.content)
    expect(previewText).not.toContain('line-150-')
    const locator = /Full formatted result stored at: (.+?)\. Use spill_read with this locator/.exec(previewText)?.[1]
    expect(locator).toBeTypeOf('string')

    const read = await spillRead(ctx, locator!)
    expect(read.isError).toBe(false)
    const readText = textOf(read.content)
    expect(readText).toContain('line-150-')
    expect(readText).toContain('End of file - total 300 lines')
  })

  it('renders an empty artifact through the advertised read tool', async () => {
    const { ctx } = await localContext()
    const ref = await ctx.spillStore.saveText({
      owner: { sessionId: SessionId('s1') },
      source: { kind: 'tool', toolName: 'empty', callId: ToolCallId('empty'), label: 'result' },
      suggestedName: 'empty.txt', content: '',
    })
    const result = await spillRead(ctx, ref.locator)
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toContain('End of file - total 0 lines')
  })

  it('passes explicit line-window arguments to the backend', async () => {
    const { ctx } = await localContext()
    const ref = await ctx.spillStore.saveText({
      owner: { sessionId: SessionId('s1') },
      source: { kind: 'tool', toolName: 'window', callId: ToolCallId('window'), label: 'result' },
      suggestedName: 'window.txt', content: 'one\ntwo\nthree',
    })
    const result = await ctx.tools.execute({
      ...exec('spill_read'),
      callId: ToolCallId('spill-read-window'),
      name: 'spill_read',
      arguments: { locator: ref.locator, offset: 2, limit: 1 },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toContain('2: two')
    expect(textOf(result.content)).not.toContain('3: three')
  })

  it('uses the default output cap when no policy value is configured', async () => {
    const { ctx } = await localContextWithPolicyDefaults()
    const ref = await ctx.spillStore.saveText({
      owner: { sessionId: SessionId('s1') },
      source: { kind: 'tool', toolName: 'default-cap', callId: ToolCallId('default-cap'), label: 'result' },
      suggestedName: 'default-cap.txt', content: 'default',
    })
    const result = await spillRead(ctx, ref.locator)
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toContain('default')
  })

  it('reports a missing backend clearly', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SpillPolicy, {})
    onTestFinished(() => ctx.fiber.dispose())

    const result = await spillRead(ctx, 'any-opaque-locator')
    expect(result.isError).toBe(true)
    expect(textOf(result.content)).toContain('no ctx.spillStore backend is loaded')
  })

  it('requires a calling session before reading', async () => {
    const { ctx } = await localContext()
    const result = await ctx.tools.execute({
      callId: ToolCallId('spill-read-no-agent'),
      name: 'spill_read',
      arguments: { locator: '/spill/missing.txt' },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(textOf(result.content)).toContain('spill_read requires a calling session')
  })

  it('forwards caller cancellation into the backend read', async () => {
    let observedSignal: AbortSignal | undefined
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    class BlockingStore extends SpillStore {
      async saveText(): Promise<SpillRef> {
        throw new Error('save is not used by this test')
      }

      override readText(input: ReadTextSpill): Promise<SpillRead> {
        observedSignal = input.signal
        markEntered()
        return new Promise((_resolve, reject) => {
          const signal = input.signal
          if (signal === undefined) {
            reject(new Error('missing cancellation signal'))
            return
          }
          const abort = () => {
            reject(new Error('spill read canceled', { cause: signal.reason }))
          }
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        })
      }
    }

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(BlockingStore)
    await ctx.plugin(SpillPolicy, {})
    onTestFinished(() => ctx.fiber.dispose())

    const controller = new AbortController()
    const pending = ctx.tools.execute({
      ...exec('spill_read'),
      callId: ToolCallId('spill-read-cancel'),
      arguments: { locator: '/spill/cancel.txt' },
      signal: controller.signal,
    })
    const observed = await Promise.race([
      entered.then(() => 'entered' as const),
      pending.then(result => `settled:${textOf(result.content)}` as const),
    ])
    expect(observed).toBe('entered')
    controller.abort()
    const result = await pending
    expect(observedSignal).toBe(controller.signal)
    expect(result.isError).toBe(true)
  })

  it('fails loudly when a backend result cannot fit the configured output cap', async () => {
    class OversizedStore extends SpillStore {
      async saveText(input: SaveTextSpill): Promise<SpillRef> {
        return savedRef(input)
      }

      override async readText(input: ReadTextSpill): Promise<SpillRead> {
        return {
          locator: input.locator,
          path: String(input.locator),
          offset: 1,
          lines: [{ number: 1, text: 'x'.repeat(1024) }],
          totalLines: 1,
          bytes: 1024,
          truncated: false,
          nextByteOffset: 1024,
        }
      }
    }

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(OversizedStore)
    await ctx.plugin(SpillPolicy, { readMaxOutputBytes: 512 })
    onTestFinished(() => ctx.fiber.dispose())

    const result = await spillRead(ctx, '/spill/oversized.txt')
    expect(result.isError).toBe(true)
    expect(textOf(result.content)).toContain('cannot fit readMaxOutputBytes=512')
  })

  it('does not re-spill retrieved content even when it exceeds the retention budget', async () => {
    const { ctx } = await localContext()
    const content = 'retrievable '.repeat(1000)
    const ref = await ctx.spillStore.saveText({
      owner: { sessionId: SessionId('s1') },
      source: { kind: 'tool', toolName: 'large', callId: ToolCallId('large'), label: 'result' },
      suggestedName: 'large.txt', content,
    })
    const result = await spillRead(ctx, ref.locator)
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toContain(content)
    expect(textOf(result.content)).not.toContain('Full formatted result stored at:')
    const inherited = await spillRead(ctx, ref.locator, 'fork-child')
    expect(inherited.isError).toBe(false)
    expect(textOf(inherited.content)).toContain(content)
  })

  it('reports a save-only backend as unsupported', async () => {
    class SaveOnlyStore extends SpillStore {
      async saveText(input: SaveTextSpill): Promise<SpillRef> {
        return savedRef(input)
      }
    }

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SaveOnlyStore)
    await ctx.plugin(SpillPolicy, {})
    onTestFinished(() => ctx.fiber.dispose())

    const result = await spillRead(ctx, '/spill/any.txt')
    expect(result.isError).toBe(true)
    expect(textOf(result.content)).toContain('spillStore.readText is not supported')
  })
})
