/**
 * Project a Browser Harness screenshot path into durable model-visible content.
 *
 * `browser_screenshot` returns `{"path", "width", "height", "size_bytes"}` as
 * text, because the upstream server writes a PNG to disk instead of returning
 * MCP `ImageContent`. DSH's MCP bridge only stores an image when the result
 * already contains an `image` block, so without this projection the model
 * receives a local path and never the picture.
 *
 * The provider owns that convention, so it supplies the projection through the
 * shared MCP client's `projectResult` seam rather than teaching the bridge about
 * one upstream server.
 *
 * @module
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { isImageAdmissionError } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageMediaType, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { McpResultProjectionContext, McpResultProjector } from '@deepseek-ai/dsh-mcp-client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** The only upstream tool this provider projects. */
const SCREENSHOT_TOOL = 'browser_screenshot'

/** Raster formats the durable attachment vocabulary accepts, by PNG signature. */
const PNG_MEDIA_TYPE: ImageMediaType = 'image/png'

/** Bound a screenshot before reading it, so a rogue path cannot exhaust memory. */
const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024

/**
 * Read the PNG path and image dimensions out of one raw screenshot result.
 *
 * The upstream text is JSON, and its exact shape is the upstream contract; a
 * missing or malformed field degrades to a diagnostic instead of failing the
 * completed browser action.
 *
 * @param context - the raw result and its upstream tool name.
 * @returns the absolute path plus declared dimensions, or undefined when this result is not a screenshot payload.
 */
export function screenshotPayload(context: McpResultProjectionContext): { path: string; width?: number; height?: number } | undefined {
  if (context.rawName !== SCREENSHOT_TOOL) return undefined
  const text = context.result.content
    .map(block => isTextBlock(block) ? block.text : '')
    .join('\n')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  // Upstream reports failures as `{"error": ...}` text; those carry no image.
  if (typeof record.path !== 'string' || record.path === '' || 'error' in record) return undefined
  return {
    path: record.path,
    ...typeof record.width === 'number' ? { width: record.width } : {},
    ...typeof record.height === 'number' ? { height: record.height } : {},
  }
}

function isTextBlock(block: JsonValue): block is JsonValue & { type: 'text'; text: string } {
  return typeof block === 'object' && block !== null && !Array.isArray(block)
    && (block as { type?: unknown }).type === 'text'
    && typeof (block as { text?: unknown }).text === 'string'
}

/**
 * Resolve the attachment store and prove the active model route accepts images.
 *
 * This mirrors the shared bridge's admission rule: an image is stored only when
 * the calling Agent's resolved model declares image input. The route is read
 * from the exact tool execution so a Session that switched models mid-turn is
 * judged by the route actually serving it.
 *
 * @param ctx - provider context carrying optional attachment, LLM, and logger services.
 * @param context - the exact tool execution whose Agent supplies the route.
 * @returns the attachment store after positive image-capability proof.
 */
async function resolveAdmission(ctx: Context, context: McpResultProjectionContext): Promise<AttachmentStore> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('no attachment store is mounted')
  const { execution } = context
  const routed = execution.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? execution.agent?.options.provider
  const model = routed?.model ?? execution.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('the current model route could not be resolved')
  }
  let info: Awaited<ReturnType<typeof llm.resolveModelInfo>>
  try {
    info = await llm.resolveModelInfo(provider, model, execution.signal)
  } catch {
    throw new Error('the current model route could not be verified')
  }
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`model "${model}" does not declare image input`)
  }
  if (execution.signal.aborted) throw new Error('the tool call was canceled before image storage')
  return attachments
}

/** Stable diagnostic text for a screenshot that stayed a path. */
function pathDiagnostic(payload: { path: string }, reason: string): ContentBlock[] {
  return [{
    type: 'text',
    text: `[screenshot not shown: ${reason}; the PNG remains at ${payload.path}]`,
  }]
}

/**
 * Build the projection that turns a screenshot path into a durable image block.
 *
 * Every failure path returns text instead of throwing: the screenshot itself
 * succeeded, so the model should still learn where the file is.
 *
 * @param ctx - provider context carrying optional attachment and LLM services.
 * @returns a projector for the shared MCP client's `projectResult` seam.
 */
export function createScreenshotProjection(ctx: Context): McpResultProjector {
  return async (context) => {
    const payload = screenshotPayload(context)
    if (payload === undefined) return []
    let attachments: AttachmentStore
    try {
      attachments = await resolveAdmission(ctx, context)
    } catch (error: unknown) {
      return pathDiagnostic(payload, reasonOf(error))
    }
    let data: Buffer
    try {
      data = await readFile(payload.path)
    } catch {
      return pathDiagnostic(payload, 'the screenshot file could not be read')
    }
    if (data.byteLength > MAX_SCREENSHOT_BYTES) {
      return pathDiagnostic(payload, `the screenshot exceeds ${String(MAX_SCREENSHOT_BYTES)} bytes`)
    }
    try {
      const [ref] = await attachments.saveImages([{ data, mediaType: PNG_MEDIA_TYPE }])
      return [{ type: 'image', attachment: ref as ImageAttachmentRef }]
    } catch (error: unknown) {
      const reason = isImageAdmissionError(error)
        ? `image admission rejected the screenshot: ${error.message}`
        : 'durable image storage rejected the screenshot'
      return pathDiagnostic(payload, reason)
    }
  }
}

/** Render an unknown failure as a diagnostic fragment. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
