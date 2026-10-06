/** Clock/UUID fixture and external model script for initial Session recording. */
import crypto from 'node:crypto'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { automaticResponse } from '../../../tools/agent/tests/fixtures/automatic-provider.ts'
import * as Engineering from '../../../tools/agent/runtime/index.ts'

export const inject = ['llm', 'tools', 'subagents', 'systemPrompt']

class ScriptedModel extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, reasoning: { efforts: ['low', 'medium', 'high', 'max'].map(id => ({ id: ReasoningEffortId(id), name: id })), defaultEffort: ReasoningEffortId('medium') } }
  }
  async *stream(options) {
    const response = automaticResponse({ model: options.model, messages: options.messages.map(message => ({
      role: message.role,
      content: message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
      tool_calls: message.content.filter(block => block.type === 'tool-call').map(block => ({ function: { name: block.name } })),
    })), tools: options.tools.map(tool => ({ function: { name: tool.name } })) })
    if ('content' in response) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: response.content }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: response.content } }
    } else {
      const call = response.tool_calls[0]
      const id = ToolCallId(call.id)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: call.function.name, argumentsDelta: call.function.arguments }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.function.name, arguments: call.function.arguments } }
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'content' in response ? 'stop' : 'tool-calls' } }
  }
}

/** Install deterministic nondeterministic boundaries only inside the snapshot subprocess. */
export async function apply(ctx, config) {
  const OriginalDate = Date
  const originalUUID = crypto.randomUUID
  let sequence = 0
  ctx.effect(() => {
    globalThis.Date = class extends OriginalDate {
      constructor(...args) { super(...(args.length === 0 ? [946684800000] : args)) }
      static now() { return 946684800000 }
    }
    crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
    syncBuiltinESMExports()
    return () => { globalThis.Date = OriginalDate; crypto.randomUUID = originalUUID; syncBuiltinESMExports() }
  })
  if (config.record) ctx.llm.registerAdapter(['fixture'], new ScriptedModel())
  await ctx.plugin(Engineering, { deploymentRoot: join(process.cwd(), '.dsh', 'deployment'), roleTimeoutMs: 30000 })
}
