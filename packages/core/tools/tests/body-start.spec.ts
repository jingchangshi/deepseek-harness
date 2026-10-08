/** Dispatch observations identify validated body starts rather than policy attempts. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import ToolRuntime, {
  defineTool, RUN_CODE_NAME, TOOL_ABORTED_BEFORE_DISPATCH,
  type ToolBodyStartObserver, type ToolDefinition, type ToolExecutionInput,
} from '@deepseek-ai/dsh-tools'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(mode: 'native' | 'ptc' = 'native'): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode })
  return ctx
}

function call(name = 'probe', arguments_: unknown = {}, extras: Partial<ToolExecutionInput> = {}): ToolExecutionInput {
  return { callId: ToolCallId('body-start'), name, arguments: arguments_, signal: new AbortController().signal, ...extras }
}

function raw(execute = vi.fn(async () => null)): ToolDefinition {
  return {
    name: 'probe', description: 'Dispatch probe', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'null' }, render: () => [] }, execute,
  }
}

async function agentScope(ctx: Context): Promise<{ scope: Scope; agent: Agent }> {
  const agent = {} as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools', 'systemPrompt'] }))
  return { scope, agent }
}

describe('validated tool body-start observation', () => {
  it('runs synchronously after policy and guards, immediately before the body', async () => {
    const ctx = await setup()
    const order: string[] = []
    ctx.tools.register(raw(vi.fn(async () => { order.push('body'); return null })))
    ctx.on('tools/pre-execute', async (_exec, next) => { order.push('pre'); return next() })
    ctx.tools.guard(() => { order.push('guard'); return undefined })
    ctx.on('tools/execute', async (_exec, next) => { order.push('wrapper'); return next() })
    ctx.tools.observeBodyStart((exec, effect) => {
      order.push('observer')
      expect(exec.name).toBe('probe')
      expect(effect).toBe('potentially-mutating')
    })
    expect((await ctx.tools.execute(call())).isError).toBe(false)
    expect(order).toEqual(['pre', 'guard', 'wrapper', 'observer', 'body'])
  })

  it.each(['policy', 'guard', 'wrapper'] as const)('does not observe a %s short circuit', async (stage) => {
    const ctx = await setup()
    const body = vi.fn(async () => null)
    const observer = vi.fn<ToolBodyStartObserver>()
    ctx.tools.register(raw(body))
    ctx.tools.observeBodyStart(observer)
    if (stage === 'policy') ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'blocked' }))
    if (stage === 'guard') ctx.tools.guard(() => 'blocked')
    if (stage === 'wrapper') ctx.on('tools/execute', async () => ({ isError: true, error: { message: 'blocked' }, content: [] }))
    expect((await ctx.tools.execute(call())).isError).toBe(true)
    expect(observer).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
  })

  it.each(['unknown', 'hidden', 'aborted'] as const)('does not observe an %s call', async (kind) => {
    const ctx = await setup()
    const body = vi.fn(async () => null)
    const observer = vi.fn<ToolBodyStartObserver>()
    const { scope, agent } = await agentScope(ctx)
    if (kind !== 'unknown') ctx.tools.register(raw(body))
    if (kind === 'hidden') scope.ctx.tools.restrict({ deny: ['probe'] })
    const controller = new AbortController()
    if (kind === 'aborted') controller.abort()
    ctx.tools.observeBodyStart(observer)
    expect((await ctx.tools.execute(call('probe', {}, { agent, signal: controller.signal }))).isError).toBe(true)
    expect(observer).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
  })

  it('rejects invalid defineTool arguments before observation', async () => {
    const ctx = await setup()
    const body = vi.fn(async () => null)
    const observer = vi.fn<ToolBodyStartObserver>()
    ctx.tools.register(defineTool({ name: 'probe', description: 'Typed probe',
      parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'null' }, render: () => [] }, execute: body,
    }))
    ctx.tools.observeBodyStart(observer)
    expect((await ctx.tools.execute(call('probe', { path: 7 }))).isError).toBe(true)
    expect(observer).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'required property', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } }, args: {} },
    { label: 'pattern constraint',
      parameters: { type: 'object', properties: { path: { type: 'string', pattern: '^safe/' } } }, args: { path: 'outside/file' } },
    { label: 'invalid schema', parameters: { type: 'object', properties: { path: { type: 'not-a-type' } } }, args: {} },
    { label: 'unresolved reference', parameters: { $ref: 'https://invalid.example/schema.json' }, args: {} },
  ])('rejects raw $label before observation', async ({ parameters, args }) => {
    const ctx = await setup()
    const body = vi.fn(async () => null)
    const observer = vi.fn<ToolBodyStartObserver>()
    ctx.tools.register({ ...raw(body), parameters })
    ctx.tools.observeBodyStart(observer)
    expect((await ctx.tools.execute(call('probe', args))).isError).toBe(true)
    expect(observer).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
  })

  it('accepts a full raw JSON Schema and observes valid arguments', async () => {
    const ctx = await setup()
    const body = vi.fn(async () => null)
    const observer = vi.fn<ToolBodyStartObserver>()
    ctx.tools.register({ ...raw(body), sideEffects: 'read-only', parameters: {
      type: 'object', required: ['path'], properties: { path: { type: 'string', pattern: '^safe/' } }, additionalProperties: false,
    } })
    ctx.tools.observeBodyStart(observer)
    expect((await ctx.tools.execute(call('probe', { path: 'safe/file' }))).isError).toBe(false)
    expect(observer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'probe' }), 'read-only')
    expect(body).toHaveBeenCalledTimes(1)
  })

  it('retains the captured defineTool validator when presentation parameters change', async () => {
    const ctx = await setup()
    const body = vi.fn(async () => null)
    const observer = vi.fn<ToolBodyStartObserver>()
    const tool = defineTool({ name: 'probe', description: 'Captured validator', sideEffects: 'read-only',
      parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'null' }, render: () => [] }, execute: body,
    })
    Object.defineProperty(tool, 'parameters', { get: () => ({ type: 'object', properties: {} }) })
    expect(() => { tool.validateArguments!({}) }).toThrow()
    expect(() => { tool.validateArguments!({ path: 'valid' }) }).not.toThrow()
    ctx.tools.register(tool)
    ctx.tools.observeBodyStart(observer)
    expect((await ctx.tools.execute(call('probe', {}))).isError).toBe(true)
    expect(observer).not.toHaveBeenCalled()
    expect((await ctx.tools.execute(call('probe', { path: 'valid' }))).isError).toBe(false)
    expect(observer).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'read-only')
    expect(body).toHaveBeenCalledTimes(1)
  })

  it('prevents observers from replacing execution identity or arguments', async () => {
    const ctx = await setup()
    const body = vi.fn(async () => null)
    ctx.tools.register(raw(body))
    ctx.tools.observeBodyStart((exec) => {
      expect(Reflect.set(exec, 'name', 'other')).toBe(false)
      expect(Reflect.set(exec, 'arguments', { changed: true })).toBe(false)
      expect(Reflect.set(exec, 'token', Symbol('replacement'))).toBe(false)
      expect(Object.isFrozen(exec.arguments)).toBe(true)
    })
    expect((await ctx.tools.execute(call('probe', { path: 'original' }))).isError).toBe(false)
    expect(body).toHaveBeenCalledExactlyOnceWith({ path: 'original' }, expect.objectContaining({ name: 'probe' }))
  })

  it('validates the live raw schema after an earlier successful dispatch', async () => {
    const ctx = await setup()
    const body = vi.fn(async () => null)
    const observer = vi.fn<ToolBodyStartObserver>()
    const parameters = {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', pattern: '^old/' } },
    }
    ctx.tools.register({ ...raw(body), parameters })
    ctx.tools.observeBodyStart(observer)
    expect((await ctx.tools.execute(call('probe', { path: 'old/file' }))).isError).toBe(false)
    parameters.properties.path.pattern = '^new/'
    expect((await ctx.tools.execute(call('probe', { path: 'old/file' }))).isError).toBe(true)
    expect(observer).toHaveBeenCalledTimes(1)
    expect(body).toHaveBeenCalledTimes(1)
    expect((await ctx.tools.execute(call('probe', { path: 'new/file' }))).isError).toBe(false)
    expect(observer).toHaveBeenCalledTimes(2)
    expect(body).toHaveBeenCalledTimes(2)
  })

  it('validates a changed raw schema while retaining its declared schema ID', async () => {
    const ctx = await setup()
    const body = vi.fn(async () => null)
    const observer = vi.fn<ToolBodyStartObserver>()
    const parameters = {
      $id: 'https://fixture.invalid/tool-input', type: 'object', required: ['old'],
      properties: { old: { type: 'string' }, updated: { type: 'string' } },
    }
    ctx.tools.register({ ...raw(body), parameters })
    ctx.tools.observeBodyStart(observer)
    expect((await ctx.tools.execute(call('probe', { old: 'before' }))).isError).toBe(false)
    parameters.required = ['updated']
    expect((await ctx.tools.execute(call('probe', { old: 'stale' }))).isError).toBe(true)
    expect(observer).toHaveBeenCalledTimes(1)
    expect((await ctx.tools.execute(call('probe', { updated: 'after' }))).isError).toBe(false)
    expect(observer).toHaveBeenCalledTimes(2)
    expect(body).toHaveBeenCalledTimes(2)
  })

  it('accepts a replacement raw tool with the same declared schema ID', async () => {
    const ctx = await setup()
    const original = vi.fn(async () => null)
    const replacement = vi.fn(async () => null)
    const schemaId = 'https://fixture.invalid/tool-input'
    const unregister = ctx.tools.register({ ...raw(original), parameters: {
      $id: schemaId, type: 'object', required: ['old'], properties: { old: { type: 'string' } },
    } })
    expect((await ctx.tools.execute(call('probe', { old: 'before' }))).isError).toBe(false)
    unregister()
    ctx.tools.register({ ...raw(replacement), parameters: {
      $id: schemaId, type: 'object', required: ['updated'], properties: { updated: { type: 'string' } },
    } })
    expect((await ctx.tools.execute(call('probe', { updated: 'after' }))).isError).toBe(false)
    expect(original).toHaveBeenCalledTimes(1)
    expect(replacement).toHaveBeenCalledTimes(1)
  })

  it('keeps schemas with the same ID independent across concurrent tools', async () => {
    const ctx = await setup()
    const first = vi.fn(async () => null)
    const second = vi.fn(async () => null)
    const schemaId = 'https://fixture.invalid/tool-input'
    ctx.tools.register({ ...raw(first), name: 'first', parameters: {
      $id: schemaId, type: 'object', required: ['first'], properties: { first: { type: 'string' } }, additionalProperties: false,
    } })
    ctx.tools.register({ ...raw(second), name: 'second', parameters: {
      $id: schemaId, type: 'object', required: ['second'], properties: { second: { type: 'number' } }, additionalProperties: false,
    } })
    const results = await Promise.all([
      ctx.tools.execute(call('first', { first: 'valid' })),
      ctx.tools.execute(call('second', { second: 7 })),
    ])
    expect(results.map(result => result.isError)).toEqual([false, false])
    const invalid = await Promise.all([
      ctx.tools.execute(call('first', { second: 7 })),
      ctx.tools.execute(call('second', { first: 'valid' })),
    ])
    expect(invalid.map(result => result.isError)).toEqual([true, true])
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('keeps the captured body when an observer replaces its registration', async () => {
    const ctx = await setup()
    const original = vi.fn(async () => null)
    const replacement = vi.fn(async () => null)
    const unregister = ctx.tools.register(raw(original))
    let replaced = false
    ctx.tools.observeBodyStart(() => {
      if (replaced) return
      replaced = true
      unregister()
      ctx.tools.register(raw(replacement))
    })
    expect((await ctx.tools.execute(call())).isError).toBe(false)
    expect(original).toHaveBeenCalledTimes(1)
    expect(replacement).not.toHaveBeenCalled()
    expect((await ctx.tools.execute(call())).isError).toBe(false)
    expect(original).toHaveBeenCalledTimes(1)
    expect(replacement).toHaveBeenCalledTimes(1)
  })

  it('fails closed when an observer returns asynchronous work', async () => {
    const ctx = await setup()
    const body = vi.fn(async () => null)
    ctx.tools.register(raw(body))
    // A void callback accepts async functions; dispatch must reject their returned promises.
    // oxlint-disable-next-line typescript/no-misused-promises
    ctx.tools.observeBodyStart(async () => {})
    expect((await ctx.tools.execute(call())).isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
  })

  it('notifies every matching observer before one body invocation', async () => {
    const ctx = await setup()
    const body = vi.fn(async () => null)
    const first = vi.fn<ToolBodyStartObserver>()
    const second = vi.fn<ToolBodyStartObserver>()
    ctx.tools.register(raw(body))
    ctx.tools.observeBodyStart(first)
    ctx.tools.observeBodyStart(second)
    await ctx.tools.execute(call())
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first.mock.calls[0]![0]).toBe(second.mock.calls[0]![0])
    expect(body).toHaveBeenCalledTimes(1)
  })

  it('fails closed when an observer throws', async () => {
    const ctx = await setup()
    const body = vi.fn(async () => null)
    ctx.tools.register(raw(body))
    ctx.tools.observeBodyStart(() => { throw new Error('observer rejected dispatch') })
    expect((await ctx.tools.execute(call())).isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
  })

  it('rechecks cancellation after synchronous observers', async () => {
    const ctx = await setup()
    const controller = new AbortController()
    const body = vi.fn(async () => null)
    const observer = vi.fn(() => { controller.abort() })
    ctx.tools.register(raw(body))
    ctx.tools.observeBodyStart(observer)
    const result = await ctx.tools.execute(call('probe', {}, { signal: controller.signal }))
    expect(observer).toHaveBeenCalledTimes(1)
    expect(body).not.toHaveBeenCalled()
    expect(result).toMatchObject({ isError: true, error: { info: { code: TOOL_ABORTED_BEFORE_DISPATCH } } })
  })

  it('observes each body retry with the same call identity', async () => {
    const ctx = await setup()
    const body = vi.fn(async () => null).mockRejectedValueOnce(new Error('retry me'))
    const observer = vi.fn<ToolBodyStartObserver>()
    ctx.tools.register(raw(body))
    ctx.tools.observeBodyStart(observer)
    ctx.on('tools/execute', async (_exec, next) => { const result = await next(); return result.isError ? next() : result })
    expect((await ctx.tools.execute(call())).isError).toBe(false)
    expect(body).toHaveBeenCalledTimes(2)
    expect(observer).toHaveBeenCalledTimes(2)
    expect(observer.mock.calls[0]![0].token).toBe(observer.mock.calls[1]![0].token)
  })

  it('isolates scoped observers and removes them on disposal', async () => {
    const ctx = await setup()
    const a = await agentScope(ctx)
    const b = await agentScope(ctx)
    const global = vi.fn<ToolBodyStartObserver>()
    const scoped = vi.fn<ToolBodyStartObserver>()
    ctx.tools.register(raw())
    ctx.tools.observeBodyStart(global)
    a.scope.ctx.tools.observeBodyStart(scoped)
    await ctx.tools.execute(call('probe', {}, { agent: b.agent }))
    await ctx.tools.execute(call())
    expect(scoped).not.toHaveBeenCalled()
    await ctx.tools.execute(call('probe', {}, { agent: a.agent }))
    expect(scoped).toHaveBeenCalledTimes(1)
    await a.scope.dispose()
    await ctx.tools.execute(call('probe', {}, { agent: a.agent }))
    expect(scoped).toHaveBeenCalledTimes(1)
    expect(global).toHaveBeenCalledTimes(4)
  })

  it('returns an idempotent disposer for the exact observer registration', async () => {
    const ctx = await setup()
    const observer = vi.fn<ToolBodyStartObserver>()
    ctx.tools.register(raw())
    const dispose = ctx.tools.observeBodyStart(observer)
    ctx.tools.observeBodyStart(observer)
    dispose()
    dispose()
    await ctx.tools.execute(call())
    expect(observer).toHaveBeenCalledTimes(1)
  })
})

class NestedRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }
  async run(request: PtcRunRequest) {
    await request.bindings[0]!.functions.probe!({})
    return { logs: [] }
  }
}

describe('PTC body-start effects', () => {
  it('marks the transport mutating and observes the nested read body separately', async () => {
    const ctx = await setup('ptc')
    await ctx.plugin(NestedRuntime)
    const body = vi.fn(async () => null)
    const observer = vi.fn<ToolBodyStartObserver>()
    ctx.tools.register({ ...raw(body), sideEffects: 'read-only' })
    ctx.tools.observeBodyStart(observer)
    const result = await ctx.tools.execute(call(RUN_CODE_NAME, { code: 'await tools.probe({})', description: 'Nested read' }))
    expect(result.isError).toBe(false)
    expect(observer.mock.calls.map(([exec, effect]) => [exec.name, effect])).toEqual([
      [RUN_CODE_NAME, 'potentially-mutating'], ['probe', 'read-only'],
    ])
    expect(body).toHaveBeenCalledTimes(1)
  })
})
