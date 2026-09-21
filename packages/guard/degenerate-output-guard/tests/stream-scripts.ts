import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect } from 'vitest'
import { healthyPrefix } from './fixtures.ts'

/**
 * Shared integration harness for the guard's lifecycle suite: a scripted
 * request-recording adapter (the loop checks the abort signal between chunk
 * pushes, so a cancel mid-stream closes the generator before the next chunk)
 * plus deterministic stream builders shaped like the recorded collapse.
 */

/**
 * Replace the context's warn sink with a capture array. Install before
 * mounting any plugin: plugin fibers resolve `ctx.logger` back to the root
 * service, so the stub observes every plugin warning.
 */
export function captureWarnings(ctx: Context): unknown[][] {
  const warnings: unknown[][] = []
  ctx.logger.warn = ((...args: unknown[]) => { warnings.push(args) }) as typeof ctx.logger.warn
  return warnings
}

/** One scripted adapter entry: a chunk list, a thrown error, a hang, or a list that stalls after N chunks. */
export type ScriptEntry = StreamChunk[] | Error | 'hang' | { chunks: StreamChunk[]; stallAfter: number }

/** Request-recording adapter whose responses follow a fixed script. */
export class ScriptedAdapter extends LlmAdapter {
  /** Every model request in dispatch order. */
  readonly requests: GenerateOptions[] = []

  private release: (() => void) | undefined

  constructor(private readonly script: ScriptEntry[]) {
    super()
  }

  /** Release a stream stalled by a `stallAfter` entry. */
  resume(): void {
    this.release?.()
    this.release = undefined
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (entry instanceof Error) throw entry
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    const chunks = entry instanceof Array ? entry : entry.chunks
    const stallAfter = entry instanceof Array ? undefined : entry.stallAfter
    for (const [index, chunk] of chunks.entries()) {
      if (stallAfter !== undefined && index === stallAfter) {
        await new Promise<void>((resolve) => { this.release = resolve })
      }
      yield chunk
    }
  }
}

/** One successful text answer. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A short healthy reasoning block followed by a text answer. */
export function healthyResponse(text = 'Checks passed.'): StreamChunk[] {
  const prefix = healthyPrefix(3_000, 0x1c0ffee)
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: prefix },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: prefix } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text },
    { type: 'block-end', index: 1, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * A scripted reasoning stream that collapses into a small phrase cycle. The
 * healthy prefix runs `prefixChars`, then the cycle repeats until the stream
 * holds `cycleChars` in total; the guard fires a few hundred to ~2,500 chars
 * after the collapse onset, well before the tail.
 */
export function degenerateReasoningStream(options?: {
  prefixChars?: number
  cycleChars?: number
  chunkChars?: number
  /** The exact repeated cycle unit; defaults to the recorded six-phrase cycle. */
  cycle?: string
}): StreamChunk[] {
  const prefixChars = options?.prefixChars ?? 10_000
  const cycleChars = options?.cycleChars ?? 12_000
  const chunkChars = options?.chunkChars ?? 256
  const cycleUnit = options?.cycle ?? 'Let me write.\nWriting.\nGo.\nOK.\nNext.\nAgain.\n'
  let body = ''
  while (body.length < cycleChars) body += cycleUnit
  body = body.slice(0, cycleChars)
  const text = healthyPrefix(prefixChars, 0x51a2b3) + body
  const chunks: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'reasoning' }]
  for (let offset = 0; offset < text.length; offset += chunkChars) {
    chunks.push({ type: 'reasoning-delta', index: 0, text: text.slice(offset, offset + chunkChars) })
  }
  chunks.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text } })
  chunks.push({ type: 'finish', reason: { kind: 'max-tokens' } })
  return chunks
}

/** All `turn/end` reasons in session-log order. */
export function turnEndReasons(agent: {
  session: { snapshotEvents(): readonly { type: string; data: unknown }[] }
}): Array<Record<string, unknown>> {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'turn/end')
    .map(event => (event.data as { reason: Record<string, unknown> }).reason)
}

/** All admitted user messages in session-log order. */
export function admittedMessages(agent: {
  session: { snapshotEvents(): readonly { type: string; data: unknown }[] }
}): Array<{
  id: string
  kind: string
  plugin: string | undefined
  round: number | undefined
  text: string
}> {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'user/message')
    .map((event) => {
      const data = event.data as {
        id: string
        source: { kind: string; plugin?: string; round?: number }
        content: Array<{ type: string; text?: string }>
      }
      return {
        id: data.id,
        kind: data.source.kind,
        plugin: data.source.plugin,
        round: data.source.round,
        text: data.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n'),
      }
    })
}

/** Guard detection records captured from the stubbed `ctx.logger.warn`. */
export function guardDetections(warnings: unknown[][]): Array<Record<string, unknown>> {
  return warnings
    .filter(args => typeof args[0] === 'string' && args[0].startsWith('degenerate-output-guard: detected'))
    .map(args => args[1] as Record<string, unknown>)
}

/** Guard budget-exhaustion records captured from the stubbed `ctx.logger.warn`. */
export function guardBudgetWarnings(warnings: unknown[][]): Array<Record<string, unknown>> {
  return warnings
    .filter(args => typeof args[0] === 'string' && args[0].startsWith('degenerate-output-guard: recovery budget exhausted'))
    .map(args => args[1] as Record<string, unknown>)
}

/**
 * Asymmetric matcher for the guard's hook cause prefix. The matcher factory
 * returns `any`; wrapping here keeps that `any` out of assertion literals.
 */
export function guardHookCause(): unknown {
  return expect.stringMatching(/^degenerate-output-guard:/)
}
