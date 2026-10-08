/** Clock/UUID fixture and external model script for initial Session recording. */
import crypto from 'node:crypto'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { automaticResponse } from '../../../tools/agent/tests/fixtures/automatic-provider.ts'
import * as Engineering from '../../../tools/agent/runtime/index.ts'

export const inject = ['llm', 'tools', 'subagents', 'systemPrompt']

class ScriptedModel extends LlmAdapter {
  developmentResult

  async resolveModel(provider, model) {
    return { provider, id: model, name: model, reasoning: { efforts: ['low', 'medium', 'high', 'max'].map(id => ({ id: ReasoningEffortId(id), name: id })), defaultEffort: ReasoningEffortId('medium') } }
  }
  async *stream(options) {
    const request = { model: options.model, messages: options.messages.map(message => ({
      role: message.role,
      content: message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
      tool_calls: message.content.filter(block => block.type === 'tool-call').map(block => ({ function: { name: block.name } })),
    })), tools: options.tools.map(tool => ({ function: { name: tool.name } })) }
    const called = request.messages.flatMap(message => message.tool_calls.map(call => call.function.name))
    const scriptedCall = (name, args) => ({ tool_calls: [{ id: `phase0-${called.length}`, function: { name, arguments: JSON.stringify(args) } }] })
    const reviewOnly = options.model === 'reviewer' && request.tools.some(tool => tool.function.name === 'git_snapshot')
    const actualEvidenceIds = request.messages.filter(message => message.role === 'tool').flatMap(message => {
      if (typeof message.content !== 'string') return []
      try {
        const value = JSON.parse(message.content)
        return typeof value === 'object' && value !== null && typeof value.evidenceId === 'string' ? [value.evidenceId] : []
      } catch { return [] }
    })
    const toolResults = request.messages.filter(message => message.role === 'tool' && typeof message.content === 'string').map(message => message.content)
    if (options.model === 'coordinator') {
      this.developmentResult = toolResults.find(content => {
        try { return JSON.parse(content).status === 'ACCEPTED' } catch { return false }
      }) ?? this.developmentResult
    }
    const response = options.model === 'coordinator' && called.includes('engineering_run') && !called.includes('engineering_review')
      ? scriptedCall('engineering_review', { targetKind: 'commit', target: 'HEAD' })
      : options.model === 'coordinator' && called.includes('engineering_review') && this.developmentResult !== undefined
        ? { content: this.developmentResult }
      : reviewOnly && !called.includes('git_snapshot')
        ? scriptedCall('git_snapshot', {})
        : reviewOnly && !called.includes('git_show')
          ? scriptedCall('git_show', { path: 'existing.txt' })
          : reviewOnly && !called.includes('git_diff')
            ? scriptedCall('git_diff', { path: 'existing.txt' })
            : reviewOnly
              ? scriptedCall('structured_output', {
                summary: 'The pinned existing.txt change preserves its required content.', findings: [],
                inspectedEvidenceIds: actualEvidenceIds, unresolvedQuestions: [],
              })
              : options.model === 'scout-secondary' && !called.includes('bash')
      ? scriptedCall('bash', { command: 'printf unexpected > forbidden.txt' })
      : options.model === 'scout-secondary' && !called.includes('structured_output')
        ? scriptedCall('structured_output', { findings: 7 })
        : automaticResponse(request)
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
  const originalCreateHash = crypto.createHash
  let sequence = 0
  ctx.effect(() => {
    globalThis.Date = class extends OriginalDate {
      constructor(...args) { super(...(args.length === 0 ? [946684800000] : args)) }
      static now() { return 946684800000 }
    }
    crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
    crypto.createHash = (algorithm, ...options) => {
      const hash = originalCreateHash(algorithm, ...options)
      const update = hash.update.bind(hash)
      hash.update = (value, ...args) => {
        if (algorithm === 'sha256' && typeof value === 'string') {
          let tuple
          try { tuple = JSON.parse(value) }
          catch (error) {
            // Non-JSON hash inputs retain their original bytes.
            void error
            return update(value, ...args)
          }
          if (Array.isArray(tuple) && tuple.length === 4 && tuple[0] === process.cwd()
            && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tuple[1]) && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tuple[2])
            && (tuple[3] === 'sha1' || tuple[3] === 'sha256')) {
            tuple[0] = '<fixture-repository-root>'
            value = JSON.stringify(tuple)
          }
        }
        return update(value, ...args)
      }
      return hash
    }
    syncBuiltinESMExports()
    return () => { globalThis.Date = OriginalDate; crypto.randomUUID = originalUUID; crypto.createHash = originalCreateHash; syncBuiltinESMExports() }
  })
  if (config.record) ctx.llm.registerAdapter(['fixture'], new ScriptedModel())
  await ctx.plugin(Engineering, { deploymentRoot: join(process.cwd(), '.dsh', 'deployment'), roleTimeoutMs: 30000 })
}
