/**
 * Browser Harness screenshot projection: a real PNG path becomes durable image
 * content for an image-capable route, and stays a diagnostic path otherwise.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { McpResultProjectionContext } from '@deepseek-ai/dsh-mcp-client'
import { createScreenshotProjection, screenshotPayload } from '../src/screenshot.ts'

/** Smallest valid PNG (4x4, solid red), accepted by the store's real image validation. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==',
  'base64',
)

/** Adapter reporting fixed input modalities for the image-capable route. */
class StubAdapter extends LlmAdapter {
  constructor(private readonly modalities: readonly string[] | undefined) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    // The `plain` model stands in for a non-image route: the provider route is
    // the same, but this model does not declare image input.
    const modalities = model === 'plain' ? ['text'] : this.modalities
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...modalities === undefined ? {} : { inputModalities: [...modalities] as never },
    })
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('screenshot projection never streams')
  }
}

let home: string
/** The image-capable route context; every mounting test projects through it. */
let ctx: Context

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-bh-shot-'))
  ctx = await mountRoute(['text', 'image'])
}, 30_000)

afterAll(async () => {
  await ctx?.fiber.dispose()
  await rm(home, { recursive: true, force: true })
})

/**
 * Mount the image-capable provider context this suite projects through.
 *
 * The modality set is fixed here rather than per test because a live LLM
 * runtime is a single service per worker: mounting more than one would make
 * `ctx.get('llm')` resolve the most recent mount regardless of which provider
 * route a call names. The non-image route is exercised through a separate
 * adapter in its own test.
 */
async function mountRoute(modalities: readonly string[] | undefined): Promise<Context> {
  const context = new Context()
  await context.plugin(LocalAttachmentStore, { dshHome: await mkdtemp(join(tmpdir(), 'dsh-bh-home-')) })
  await context.plugin(LlmRuntime)
  // Register through `ctx.get('llm')`, the same lookup the projection performs,
  // so the adapter under test is provably the one admission consults.
  const llm = context.get('llm')
  if (llm === undefined) throw new Error('the test composition mounted no LLM runtime')
  llm.registerAdapter(['visual'], new StubAdapter(modalities))
  return context
}

/** Minimal projection context standing in for one browser_screenshot call. */
function projection(route: string, model: string, text: string): McpResultProjectionContext {
  return {
    rawName: 'browser_screenshot',
    result: { content: [{ type: 'text', text }] },
    execution: {
      agent: {
        options: { provider: route, model },
        session: { requestHeader: () => undefined },
      },
      signal: new AbortController().signal,
      callId: ToolCallId('shot'),
    },
  } as unknown as McpResultProjectionContext
}

/** Text of a projected block, failing the test on any non-text shape. */
function textOf(blocks: readonly { type: string }[]): string {
  const block = blocks[0]
  if (block === undefined || block.type !== 'text') throw new Error(`expected a text block, got ${JSON.stringify(blocks)}`)
  return (block as unknown as { text: string }).text
}

/** Write a real PNG and describe it the way upstream does. */
async function screenshotResult(): Promise<{ text: string; path: string }> {
  const path = join(home, `shot-${Math.random().toString(16).slice(2)}.png`)
  await writeFile(path, PNG_1X1)
  return { text: JSON.stringify({ path, width: 4, height: 4, size_bytes: PNG_1X1.byteLength }), path }
}

it('projects a real screenshot path into durable image content for an image-capable route', async () => {
  const { text, path } = await screenshotResult()
  const projected = await createScreenshotProjection(ctx)(projection('visual', 'vision', text))
  expect(projected).toHaveLength(1)
  const block = projected[0]!
  expect(block.type).toBe('image')
  if (block.type !== 'image') throw new Error('expected an image block')
  // The stored attachment really holds the PNG bytes, not just a reference.
  const stored = await ctx.attachments.readImage(block.attachment)
  expect(Buffer.from(stored.data).equals(PNG_1X1)).toBe(true)
  expect(block.attachment.mediaType).toBe('image/png')
  expect(path.endsWith('.png')).toBe(true)
})

it('keeps a text diagnostic with the path when the route is not image-capable', async () => {
  const { text, path } = await screenshotResult()
  const projected = await createScreenshotProjection(ctx)(projection('visual', 'plain', text))
  expect(projected).toHaveLength(1)
  expect(projected[0]!.type).toBe('text')
  const rendered = textOf(projected)
  expect(rendered).toContain('does not declare image input')
  expect(rendered).toContain(path)
})

it('reports a missing attachment store instead of failing the completed action', async () => {
  // Deliberately a fresh context with NO attachment store. It mounts an LLM
  // runtime so the admission check can get past route resolution and reach the
  // missing-store branch; `ctx.get('llm')` then resolves this runtime.
  const bare = new Context()
  await bare.plugin(LlmRuntime)
  const { text } = await screenshotResult()
  const projected = await createScreenshotProjection(bare)(projection('visual', 'vision', text))
  expect(textOf(projected)).toContain('no attachment store is mounted')
  await bare.fiber.dispose()
})

it('degrades to a diagnostic when the screenshot file has disappeared', async () => {
  const missing = join(home, 'gone.png')
  const projected = await createScreenshotProjection(ctx)(projection('visual', 'vision', JSON.stringify({ path: missing })))
  const rendered = textOf(projected)
  expect(rendered).toContain('could not be read')
  expect(rendered).toContain(missing)
})

it('ignores unrelated tools, upstream errors, and non-JSON payloads', async () => {
  const projector = createScreenshotProjection(ctx)
  const other = { ...projection('visual', 'vision', '{}'), rawName: 'browser_goto' }
  expect(await projector(other)).toEqual([])
  expect(await projector(projection('visual', 'vision', '{"error":"daemon down"}'))).toEqual([])
  expect(await projector(projection('visual', 'vision', 'not json'))).toEqual([])
  expect(await projector(projection('visual', 'vision', '{"path":""}'))).toEqual([])
})

it('reads the path and dimensions out of the upstream payload', () => {
  const payload = screenshotPayload(projection('visual', 'vision', JSON.stringify({ path: '/tmp/a.png', width: 1920, height: 1080 })))
  expect(payload).toEqual({ path: '/tmp/a.png', width: 1920, height: 1080 })
  // Width and height are optional; a path alone is still projectable.
  expect(screenshotPayload(projection('visual', 'vision', JSON.stringify({ path: '/tmp/b.png' })))).toEqual({ path: '/tmp/b.png' })
})

it('reads exactly the reported path and stores those bytes', async () => {
  const { text, path } = await screenshotResult()
  expect((await readFile(path)).equals(PNG_1X1)).toBe(true)
  const projected = await createScreenshotProjection(ctx)(projection('visual', 'vision', text))
  expect(projected[0]!.type).toBe('image')
  if (projected[0]!.type !== 'image') throw new Error('expected an image block')
  const stored = await ctx.attachments.readImage(projected[0]!.attachment)
  expect(Buffer.from(stored.data).equals(PNG_1X1)).toBe(true)
})
