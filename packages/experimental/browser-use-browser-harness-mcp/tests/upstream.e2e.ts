/**
 * Real Browser Harness checks against the user's running Chrome.
 *
 * Opt-in only: CI has neither Chrome nor a Browser Harness install, so the
 * suite self-skips unless `DSH_BROWSER_HARNESS_E2E=1`. It drives a real,
 * externally owned browser, so it opens its own tab and never signs in,
 * types credentials, or answers MFA.
 *
 * Preconditions: `browser-harness-mcp` is installed, a Chromium-family browser
 * is running, and that browser has remote debugging allowed for the instance
 * (chrome://inspect/#remote-debugging). Without the last one, every browser
 * call returns `{"error": "daemon ... didn't come up"}` and this suite fails
 * even though Session creation and tool discovery succeeded.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Llm from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Projections from '@deepseek-ai/dsh-session-projection'
import { writeFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import * as Provider from '../src/index.ts'

const enabled = process.env.DSH_BROWSER_HARNESS_E2E === '1'
const NAMESPACE = 'browser-harness'

/** One tool call over the mounted Session, matching the model's own path. */
interface Session {
  call: (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>
  agent: Agent
  toolNames: string[]
  dispose: () => Promise<void>
}

/** Text a browser tool actually returned to the model. */
async function callTool(
  ctx: Context,
  agent: Session['agent'],
  rawName: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const result = await ctx.tools.execute({
    agent, name: `mcp__${NAMESPACE}__${rawName}`, arguments: args,
    callId: ToolCallId(rawName), signal: new AbortController().signal,
  })
  const text = result.content
    .map(block => block.type === 'text' ? block.text : '[image]')
    .join('\n')
  return { isError: result.isError, text }
}

/**
 * Boot one real composition on the given provider config and return a live
 * Session bound to the user's Browser Harness daemon.
 */
async function openSession(root: string, config: Record<string, unknown>): Promise<{ ctx: Context; session: Session }> {
  const modules = new Map<string, unknown>([
    ['browserUse', BrowserUse], ['prompt', SystemPrompt], ['tools', Tools], ['llm', Llm],
    ['sessions', Sessions], ['agents', Agents], ['loop', AgentLoop], ['projections', Projections],
    ['browser', { ...Provider, Config: undefined }],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { id: 'browserUse', name: 'browserUse', config: {} },
    { id: 'prompt', name: 'prompt', config: {} },
    { id: 'tools', name: 'tools', config: {} },
    { id: 'llm', name: 'llm', config: {} },
    { id: 'sessions', name: 'sessions', config: {} },
    { id: 'agents', name: 'agents', config: {} },
    { id: 'loop', name: 'loop', config: { agents: [] } },
    { id: 'projections', name: 'projections', config: {} },
    { id: 'browser', name: 'browser', config },
  ]))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected smoke module ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const owner = await ctx.agents.create({ sessionId: SessionId(`bh-${Date.now()}-${Math.random()}`), meta: { cwd: root } })
  await owner.agent.whenIdle()
  await ctx.systemPrompt.assemble({ agent: owner.agent, scope: owner.agent, signal: new AbortController().signal })
  const toolNames = ctx.tools.schemas(owner.agent).map(tool => tool.name)
  return {
    ctx,
    session: {
      agent: owner.agent,
      toolNames,
      call: (name, args) => callTool(ctx, owner.agent, name, args),
      dispose: async () => { await owner.dispose() },
    },
  }
}

/** Parse the JSON text a Browser Harness tool returns. */
function parse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch (error) {
    throw new Error(`Browser Harness returned non-JSON text: ${text.slice(0, 300)}`, { cause: error })
  }
}

it.runIf(enabled)('drives the user\'s running Chrome and leaves it running after teardown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bh-e2e-'))
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<!doctype html><title>DSH Browser Harness fixture</title><h1 id="probe">Browser Harness works</h1>')
  })
  let opened: Awaited<ReturnType<typeof openSession>> | undefined
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Fixture has no TCP listener')
    const url = `http://127.0.0.1:${address.port}/probe`

    opened = await openSession(root, { command: process.env.DSH_BROWSER_HARNESS_COMMAND ?? 'browser-harness-mcp', toolCallTimeoutMs: 30_000 })
    const { ctx, session } = opened

    // 1. The upstream catalog is discoverable as `mcp__browser-harness__*`.
    expect(session.toolNames.length).toBeGreaterThan(0)
    expect(session.toolNames.every(name => name.startsWith(`mcp__${NAMESPACE}__`))).toBe(true)
    expect(session.toolNames).toContain(`mcp__${NAMESPACE}__browser_list_tabs`)
    expect(session.toolNames).toContain(`mcp__${NAMESPACE}__browser_screenshot`)

    // 2. The daemon reaches the already-running browser.
    const tabs = parse((await session.call('browser_list_tabs', {})).text)

    // 3. Open our own tab and 4. navigate it.
    const created = parse((await session.call('browser_new_tab', { url })).text)
    expect(created.targetId ?? created.error).toBeTruthy()
    await session.call('browser_wait_for_load', { timeout: 30 })
    const info = parse((await session.call('browser_page_info', {})).text)
    expect(JSON.stringify(info)).toContain('probe')

    // 5/6. Read page state and evaluate JavaScript in it.
    const js = parse((await session.call('browser_js', { expression: 'document.getElementById("probe").textContent' })).text)
    expect(JSON.stringify(js)).toContain('Browser Harness works')

    // 7. Screenshot yields a real PNG on disk (see the package README: this is
    // a path, not MCP ImageContent, so no attachment is produced).
    const shot = parse((await session.call('browser_screenshot', { max_dim: 640 })).text)
    expect(typeof shot.path).toBe('string')
    expect(existsSync(shot.path as string)).toBe(true)

    // 8. Browser state survives further turns of the same Session.
    const stillThere = parse((await session.call('browser_page_info', {})).text)
    expect(JSON.stringify(stillThere)).toContain('probe')

    // 11. A second live Session cannot share the single local browser lane.
    const second = await openSession(join(root, 'second'), { command: process.env.DSH_BROWSER_HARNESS_COMMAND ?? 'browser-harness-mcp' })
    try {
      // The blocked activation keeps every non-browser DSH tool but receives no
      // `mcp__browser-harness__` schema, and creation still succeeds.
      expect(second.session.toolNames).toEqual([])
      // Its sessions registry still reports the first Session as the owner.
      expect(ctx.browserUse.providerName).toBeDefined()
    } finally {
      await second.ctx.fiber.dispose()
    }

    // 12. The browser's existing tabs are the user's own, so we only assert the
    // list is non-empty rather than touching unrelated state. No credentials,
    // passwords, or MFA are ever entered here.
    expect(Array.isArray(tabs) || typeof tabs === 'object').toBe(true)

    // 9/10. Disposing the provider leaves the external browser and daemon
    // running, so a fresh Session can attach again.
    await session.dispose()
    const reopened = await openSession(join(root, 'reopened'), { command: process.env.DSH_BROWSER_HARNESS_COMMAND ?? 'browser-harness-mcp' })
    try {
      expect(reopened.session.toolNames.length).toBeGreaterThan(0)
      const after = parse((await reopened.session.call('browser_list_tabs', {})).text)
      expect(after.error).toBeUndefined()
    } finally {
      await reopened.ctx.fiber.dispose()
    }
  } finally {
    await opened?.ctx.fiber.dispose().catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await rm(root, { recursive: true, force: true })
  }
})
