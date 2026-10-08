/**
 * Token-budgeted tool content with recoverable text and image addresses.
 * Post-execute policies settle before retention; canonical program values
 * remain intact. Missing recovery storage or image pricing keeps the original
 * content and reports the reason through the logger.
 * @module @deepseek-ai/dsh-spill-policy
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageBlock, LlmImageRequestPrice, ToolCallId } from '@deepseek-ai/dsh-llm'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import { SpillLocator } from '@deepseek-ai/dsh-spill'
import type { ReadTextSpill, SpillRead, SpillRef, SpillStore } from '@deepseek-ai/dsh-spill'
import { defineTool, type PostToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import type { SpillPolicyExec } from './types.ts'
import { formatSpillNotice } from './notice.ts'
import { retainContent } from './retention.ts'
import type { RetainableBlock } from './retention.ts'

export type { SpillPolicyExec } from './types.ts'

/** Optional result-retention budget. */
export interface Config {
  /** Maximum estimated tokens in a retained result, including image descriptors and omission notices. Omitted disables retention. */
  maxInlineTokens?: number
  /** Maximum UTF-8 bytes of one model-visible `spill_read` result, including rendered metadata. */
  readMaxOutputBytes?: number
}

/** Cordis plugin identity. */
export const name = 'spill-policy'
/** Tools own both model-facing results and PTC dispatch logs. */
export const inject = ['tools']
export const Config: z<Config> = z.object({ maxInlineTokens: z.number(), readMaxOutputBytes: z.number().min(512).step(1).default(65536) })

/** Narrow the model's ordered content without rewriting unsupported blocks. */
function retainable(content: readonly ContentBlock[]): content is RetainableBlock[] {
  return content.every(block => block.type === 'text' || block.type === 'image')
}

const GAP = { type: 'text', text: '\n\n[...]\n\n' } as const

const MIN_READ_PAGE_BYTES = 4

function renderRead(value: Pick<SpillRead, 'lines' | 'offset' | 'totalLines' | 'truncated' | 'nextByteOffset'>): string {
  const footer = value.truncated
    ? `(Partial content of ${value.totalLines} lines. Use byteOffset=${value.nextByteOffset} to continue.)`
    : `(End of file - total ${value.totalLines} lines)`
  return value.lines.length > 0
    ? `${value.lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}`
    : footer
}

function modelReadBytes(read: SpillRead): number {
  const value = {
    locator: read.locator,
    offset: read.offset,
    lines: read.lines,
    totalLines: read.totalLines,
    bytes: read.bytes,
    truncated: read.truncated,
    nextByteOffset: read.nextByteOffset,
  }
  return Math.max(Buffer.byteLength(renderRead(read), 'utf8'), Buffer.byteLength(JSON.stringify(value), 'utf8'))
}

async function readBoundedPage(store: SpillStore, input: ReadTextSpill, outputBytes: number): Promise<SpillRead> {
  let low = MIN_READ_PAGE_BYTES
  let high = outputBytes
  let best: SpillRead | undefined
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2)
    const read = await store.readText({ ...input, maxBytes: candidate })
    if (modelReadBytes(read) <= outputBytes) {
      best = read
      low = candidate + 1
    } else {
      high = candidate - 1
    }
  }
  if (best === undefined) throw new Error(`spill_read result cannot fit readMaxOutputBytes=${outputBytes}`)
  return best
}

/**
 * Mount token retention for accepted tool results and PTC log copies.
 * @param ctx - tool registry and optional pricing, filesystem, attachment, and spill services.
 * @param config - maximum estimated result tokens; omission disables the plugin.
 */
export function apply(ctx: Context, config: Config): void {
  const cap = config.maxInlineTokens
  if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 0)) {
    throw new Error(`spill-policy: maxInlineTokens must be a non-negative integer (got ${cap})`)
  }
  if (config.readMaxOutputBytes !== undefined && (!Number.isSafeInteger(config.readMaxOutputBytes) || config.readMaxOutputBytes < 512)) {
    throw new Error(`spill-policy: readMaxOutputBytes must be at least 512 bytes (got ${config.readMaxOutputBytes})`)
  }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'spill_read',
    sideEffects: 'read-only',
    description: 'Read a bounded page of spilled text by its opaque locator, including locators inherited in a fork or received as context. Follow the returned byteOffset to continue within long lines.',
    parameters: {
      locator: { type: 'string', required: true, description: 'Opaque full-result locator from the spill notice. Do not parse or make one up.' },
      offset: { type: 'integer', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'integer', description: 'Maximum number of lines to return. The spill backend applies its own cap when omitted.' },
      byteOffset: { type: 'integer', description: 'Absolute UTF-8 byte cursor from the previous page; overrides offset.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          locator: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          totalLines: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          nextByteOffset: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderRead(value) }],
    },
    async execute(args, exec) {
      const store = ctx.get('spillStore')
      if (store === undefined) throw new Error('spill_read is unavailable: no ctx.spillStore backend is loaded')
      if (exec.agent === undefined) throw new Error('spill_read requires a calling session')
      const read = await readBoundedPage(store, {
        locator: SpillLocator(args.locator),
        ...(args.offset === undefined ? {} : { offset: args.offset }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.byteOffset === undefined ? {} : { byteOffset: args.byteOffset }),
        signal: exec.signal,
      }, config.readMaxOutputBytes ?? 65536)
      return {
        locator: read.locator,
        offset: read.offset,
        lines: read.lines,
        totalLines: read.totalLines,
        bytes: read.bytes,
        truncated: read.truncated,
        nextByteOffset: read.nextByteOffset,
      }
    },
  })))
  if (cap === undefined) return
  const maxTokens = cap

  /** Price actual request images and their accompanying descriptor text. */
  function pricing(exec: ToolExecution, images: ImageBlock[]): (block: RetainableBlock) => number {
    const costs = new Map<ImageBlock, number>()
    if (images.length > 0) {
      const routed = exec.agent?.session.requestHeader()?.config
      const provider = routed?.provider ?? exec.agent?.options.provider
      const model = routed?.model ?? exec.agent?.options.model
      const calculator = provider === undefined || model === undefined
        ? undefined
        : ctx.get('llm')?.imageRequestPricing(provider, model)
      if (calculator === undefined) throw new Error('the current model has no image token calculator')
      const prices = calculator.priceImages(images)
      if (prices.length !== images.length) throw new Error('image token calculator returned an inconsistent occurrence count')
      for (const [index, image] of images.entries()) {
        const cost = prices[index] as LlmImageRequestPrice
        costs.set(image, cost.visualTokens + estimateContent([{ type: 'text', text: cost.text }]))
      }
    }
    return block => block.type === 'image' ? costs.get(block) as number : estimateContent([block])
  }

  /** Full ordered text with an execution-readable attachment path at each image position. */
  function fullText(content: RetainableBlock[]): string {
    return content.map((block) => {
      if (block.type === 'text') return block.text
      const attachments = ctx.get('attachments')
      const fs = ctx.get('fs')
      const access = attachments === undefined || fs === undefined ? undefined : resolveImageAttachmentAccess(
        attachments, path => fs.processPathFromHostPath(path), block.attachment)
      if (access === undefined) throw new Error(`image ${block.attachment.attachmentId} has no readable attachment path`)
      return `\n[Image: ${JSON.stringify(access.readonlyPath)}; ${block.attachment.mediaType}; ${block.attachment.width}x${block.attachment.height}. Use read_image to view it.]\n`
    }).join('')
  }

  /** Recoverably bound one display copy; failures leave successful tool content visible. */
  async function bound(
    exec: ToolExecution, content: ContentBlock[], toolName: string, callId: ToolCallId, label: 'result' | 'dispatch',
  ): Promise<ContentBlock[] | undefined> {
    if (toolName === 'spill_read') return undefined
    if (!retainable(content)) return undefined
    try {
      const images = content.filter((block): block is ImageBlock => block.type === 'image')
      const price = pricing(exec, images)
      if (content.reduce((total, block) => total + price(block), 0) <= maxTokens) return undefined
      const owner = (exec as SpillPolicyExec).agent?.session.header.id
      if (owner === undefined) throw new Error(`no session owner for ${toolName} ${label}`)
      const spillStore = ctx.get('spillStore')
      if (spillStore === undefined) throw new Error('no ctx.spillStore backend loaded')
      const ref: SpillRef = await spillStore.saveText({
        owner: { sessionId: owner }, source: { kind: 'tool', toolName, callId, label },
        suggestedName: `${toolName}.txt`, content: fullText(content),
      })
      const totalBytes = content.reduce((total, block) => total + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0), 0)
      const notice = (bytes: number, count: number): Extract<RetainableBlock, { type: 'text' }> => ({
        type: 'text', text: formatSpillNotice({ kind: 'exact', count: bytes }, ref, count),
      })
      const worstNotice = notice(totalBytes, images.length)
      const reserved = price(GAP) + price({ type: 'text', text: `\n\n${worstNotice.text}` })
      if (price(worstNotice) > maxTokens) throw new Error(`spill notice for ${toolName} exceeds maxInlineTokens`)
      const retained = retainContent(content, Math.max(0, maxTokens - reserved), price)
      const footer = notice(retained.omittedBytes, retained.omittedImages)
      const result = retained.head.length + retained.tail.length === 0
        ? [footer]
        : [...retained.head, GAP, ...retained.tail, { type: 'text' as const, text: `\n\n${footer.text}` }]
      // Adjacent text has one framing cost on the wire and in the spill preview.
      const merged: ContentBlock[] = []
      for (const block of result) {
        const previous = merged.at(-1)
        if (block.type === 'text' && previous?.type === 'text') previous.text += block.text
        else merged.push(block.type === 'text' ? { ...block } : block)
      }
      return merged
    } catch (error: unknown) {
      ctx.logger.warn(`spill-policy: ${String(error)}; keeping the inline content`)
      return undefined
    }
  }

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const decision = await next()
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value') || exec.name === 'read') return decision
    const content = decision.content ?? result.content
    const hasImages = content.some(block => block.type === 'image')
    // Text-only PTC bindings retain their asynchronous log-only spill path.
    if (exec.parent !== undefined && !hasImages) return decision
    const retained = await bound(exec, content, exec.name, exec.callId, exec.parent === undefined ? 'result' : 'dispatch')
    if (retained === undefined) return decision
    const additionalContexts = [...decision.additionalContexts ?? []]
    if (exec.parent !== undefined && !result.isError && hasImages && !retained.some(block => block.type === 'image')) {
      additionalContexts.push(createUserMessage({ content: retained, source: { kind: 'ptc-mode' } }))
    }
    return {
      kind: 'accept', content: retained,
      ...additionalContexts.length > 0 ? { additionalContexts } : {},
    }
  }, { prepend: true })

  ctx.on('tools/ptc-dispatch-log', async (dispatch, next): Promise<ContentBlock[]> => {
    const content = await next()
    return await bound(dispatch.exec, content, dispatch.name, dispatch.subCallId, 'dispatch') ?? content
  }, { prepend: true })
}
