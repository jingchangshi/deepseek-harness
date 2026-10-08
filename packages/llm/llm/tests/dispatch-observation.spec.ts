import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  return { promise, resolve }
}

class ObservedAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, defaultMaxTokens: 64, inputModalities: ['text'] })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    return (async function* () {
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } } satisfies StreamChunk
      yield { type: 'finish', reason: { kind: 'stop' } } satisfies StreamChunk
    })()
  }
}

async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new ObservedAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  return { ctx, adapter, options: { provider: 'fixture', model: 'text-model', messages: [createUserMessage({ content: [{ type: 'text', text: 'Inspect the fixture' }], source: { kind: 'user' } })] } satisfies GenerateOptions }
}

describe('actual adapter dispatch observation', () => {
  it('does not enter the adapter when cancellation arrives during async admission', async () => {
    const { ctx, adapter, options } = await fixture()
    const controller = new AbortController()
    let postDispatches = 0
    ctx.on('llm/pre-dispatch', async () => {
      await Promise.resolve()
      controller.abort(new Error('Cancelled during admission'))
    })
    ctx.on('llm/post-dispatch', () => { postDispatches++ })
    try {
      await collect(ctx.llm.stream({ ...options, signal: controller.signal })).then(() => {}, () => {})
      expect(controller.signal.aborted).toBe(true)
      expect(adapter.calls).toHaveLength(0)
      expect(postDispatches).toBe(0)
    } finally { await ctx.fiber.dispose() }
  })

  it('awaits async admission before entering the adapter and assigns a unique request identity', async () => {
    const { ctx, adapter, options } = await fixture()
    const entered = deferred()
    const release = deferred()
    const ids: string[] = []
    ctx.on('llm/pre-dispatch', async ({ requestId }) => {
      ids.push(requestId)
      entered.resolve()
      await release.promise
    })
    const pending = collect(ctx.llm.stream(options))
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Adapter completed without async dispatch admission') })])
      expect(adapter.calls).toHaveLength(0)
      release.resolve()
      await pending
      await collect(ctx.llm.stream(options))
      expect(adapter.calls).toHaveLength(2)
      expect(ids).toHaveLength(2)
      expect(ids[0]).toBeTruthy()
      expect(ids[1]).not.toBe(ids[0])
    } finally {
      release.resolve()
      await Promise.allSettled([pending])
      await ctx.fiber.dispose()
    }
  })

  it('propagates admission failure without a provider chunk or adapter side effect', async () => {
    const { ctx, adapter, options } = await fixture()
    const denied = new Error('Task provider-request budget exhausted')
    ctx.on('llm/pre-dispatch', () => { throw denied })
    try {
      await expect(collect(ctx.llm.stream(options))).rejects.toBe(denied)
      expect(adapter.calls).toHaveLength(0)
    } finally { await ctx.fiber.dispose() }
  })

  it('does not count a replay stream that short-circuits the adapter', async () => {
    const { ctx, adapter, options } = await fixture()
    let observations = 0
    ctx.on('llm/pre-dispatch', () => { observations++ })
    ctx.on('llm/post-dispatch', () => { observations++ })
    ctx.on('llm/stream', async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })
    try {
      expect(await collect(ctx.llm.stream(options))).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
      expect(observations).toBe(0)
      expect(adapter.calls).toHaveLength(0)
    } finally { await ctx.fiber.dispose() }
  })

  it.each([undefined, 'compaction'] as const)('observes the final prepared request and real usage for purpose %s', async (purpose) => {
    const { ctx, adapter, options } = await fixture()
    const before: Array<{ requestId: string; options: GenerateOptions }> = []
    const after: Array<{
      requestId: string
      options: GenerateOptions
      usage?: { inputTokens: number; outputTokens: number; totalTokens?: number }
      outcome: string
    }> = []
    ctx.on('llm/pre-dispatch', (payload) => { before.push(payload) })
    ctx.on('llm/post-dispatch', (payload) => { after.push(payload) })
    try {
      const prepared = await ctx.llm.prepareCall({ provider: options.provider, model: options.model })
      await collect(prepared.stream({ ...options, ...prepared.config, sessionId: SessionId('dispatch-owner'), ...purpose === undefined ? {} : { purpose } }))
      expect(before).toHaveLength(1)
      expect(after).toHaveLength(1)
      expect(before[0]?.options).toBe(adapter.calls[0])
      expect(before[0]?.options).toMatchObject({ maxTokens: 64, sessionId: 'dispatch-owner', ...purpose === undefined ? {} : { purpose } })
      expect(after[0]).toMatchObject({ requestId: before[0]?.requestId, outcome: 'SUCCESS', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } })
    } finally { await ctx.fiber.dispose() }
  })
})
