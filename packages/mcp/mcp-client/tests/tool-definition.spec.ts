import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { createMcpToolDefinition } from '../src/index.ts'
import type { McpResultProjectionContext } from '../src/index.ts'

describe('MCP result callback adaptation', () => {
  it('preserves the exact execution, arguments and canonical structured results', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      let execution: ToolExecution | undefined
      ctx.on('tools/execute', (exec, next) => {
        execution = exec
        return next()
      })
      const call = vi.fn(async () => ({
        content: [{ type: 'text', text: 'Observed window.' }],
        structuredContent: { window: 7 },
      }))
      ctx.tools.register(createMcpToolDefinition(ctx, {
        name: 'native_window', rawName: 'window', description: 'Read the selected window.',
        inputSchema: { type: 'object', properties: { window: { type: 'integer' } } },
        outputSchema: { type: 'object', properties: { window: { type: 'integer' } }, required: ['window'] },
        call,
      }))
      const signal = new AbortController().signal
      const result = await ctx.tools.execute({
        name: 'native_window', callId: ToolCallId('window-call'), arguments: { window: 7 }, signal,
      })
      expect(call).toHaveBeenCalledWith({ window: 7 }, execution)
      expect(execution?.signal).toBe(signal)
      expect(result.isError).toBe(false)
      expect(result.value).toEqual({
        content: [{ type: 'text', text: 'Observed window.' }], structuredContent: { window: 7 },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([null, { content: [42] }, { content: [{ type: 'image' }] }])(
    'rejects invalid external results before exposing content (%j)', async (invalid) => {
      const ctx = new Context()
      try {
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRuntime)
        ctx.tools.register(createMcpToolDefinition(ctx, {
          name: 'invalid_result', rawName: 'invalid', description: 'External result fixture.',
          inputSchema: { type: 'object' }, call: async () => invalid,
        }))
        const result = await ctx.tools.execute({
          name: 'invalid_result', callId: ToolCallId('invalid-call'), arguments: {},
          signal: new AbortController().signal,
        })
        expect(result.isError).toBe(true)
        expect(result.value).toBeUndefined()
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )
})

describe('caller-supplied result projection', () => {
  /** Mount the minimum registries a tool definition needs. */
  async function mount(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    return ctx
  }

  it('appends projected content and keeps it model-visible through finalizeContent', async () => {
    const ctx = await mount()
    try {
      const projected = vi.fn(async (_context: McpResultProjectionContext) => [
        { type: 'text' as const, text: 'referenced resource' },
      ])
      ctx.tools.register(createMcpToolDefinition(ctx, {
        name: 'projected', rawName: 'projected', description: 'Projects a referenced resource.',
        inputSchema: { type: 'object' }, projectResult: projected,
        call: async () => ({ content: [{ type: 'text', text: '{"path":"/tmp/x.bin"}' }] }),
      }))
      const result = await ctx.tools.execute({
        name: 'projected', callId: ToolCallId('projected-call'), arguments: {},
        signal: new AbortController().signal,
      })
      expect(projected).toHaveBeenCalledOnce()
      // The hook sees the canonical value and the raw upstream name.
      expect(projected.mock.calls[0]![0]).toMatchObject({
        rawName: 'projected',
        result: { content: [{ type: 'text', text: '{"path":"/tmp/x.bin"}' }] },
      })
      expect(result.isError).toBe(false)
      // The model-visible content is the projection, not the plain-text fallback.
      expect(JSON.stringify(result.content)).toContain('referenced resource')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('degrades a failing projection to a diagnostic instead of failing the tool call', async () => {
    const ctx = await mount()
    try {
      ctx.tools.register(createMcpToolDefinition(ctx, {
        name: 'broken_projection', rawName: 'broken', description: 'Projection throws.',
        inputSchema: { type: 'object' },
        projectResult: () => Promise.reject(new Error('reader exploded')),
        call: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      }))
      const result = await ctx.tools.execute({
        name: 'broken_projection', callId: ToolCallId('broken-call'), arguments: {},
        signal: new AbortController().signal,
      })
      // The upstream call succeeded, so the result must not become an error.
      expect(result.isError).toBe(false)
      expect(JSON.stringify(result.content)).toContain('reader exploded')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves the standard projection untouched when no projector is supplied', async () => {
    const ctx = await mount()
    try {
      ctx.tools.register(createMcpToolDefinition(ctx, {
        name: 'plain_result', rawName: 'plain', description: 'No projector.',
        inputSchema: { type: 'object' },
        call: async () => ({ content: [{ type: 'text', text: 'unchanged' }] }),
      }))
      const result = await ctx.tools.execute({
        name: 'plain_result', callId: ToolCallId('plain-call'), arguments: {},
        signal: new AbortController().signal,
      })
      expect(result.isError).toBe(false)
      expect(JSON.stringify(result.content)).toContain('unchanged')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
