/**
 * Real-Loader composition for the Browser Harness provider's skill bridge.
 *
 * The provider reads the skill registry through `ctx.get('skills')` and never
 * declares `skills` in `inject`, so activation must survive a composition that
 * mounts the registry AND one that omits it. A hand-built
 * `Provider.apply(ctx, config)` call proves neither: on a root context the
 * Cordis service proxy takes its direct global-store lookup, so an undeclared
 * `ctx.skills` read succeeds there and throws only inside a plugin fiber.
 *
 * The skill CLI is derived from the MCP command and runs argument-free, so a
 * node script fixture cannot be handed to it through `config.args`. Instead a
 * preload module turns plain `node` into the stand-in: it synchronously writes
 * the upstream document to fd 1 and exits before node resolves the `skill`
 * entry argument. The gate on `BH_SKILL_FIXTURE` keeps a leaked preload a
 * no-op import for any other node process, and the bridge forwards that
 * variable from `process.env`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import Llm from '@deepseek-ai/dsh-llm'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Provider from '../src/index.ts'

/** A genuine upstream document, shaped exactly like `browser-harness skill`. */
const UPSTREAM = `---
name: browser-harness
description: "Control a real browser via CDP: clicking, typing, navigation."
---

# browser-harness

Direct browser control via CDP.
`

/** Stand-in skill CLI: a preload that prints the document and exits. */
const PRELOADER = `import { writeSync } from 'node:fs'
const document = process.env.BH_SKILL_FIXTURE
if (document !== undefined) {
  writeSync(1, document)
  process.exit(0)
}
`

const contexts: Context[] = []
const roots: string[] = []
const previousNodeOptions = process.env.NODE_OPTIONS
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  delete process.env.BH_SKILL_FIXTURE
  if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
  else process.env.NODE_OPTIONS = previousNodeOptions
})

/**
 * Boot one composition through the real Loader.
 * @param withSkills - whether the composition mounts the skill registry.
 * @returns the booted context.
 */
async function boot(withSkills: boolean): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bh-composition-'))
  roots.push(root)
  const preloader = join(root, 'skill-preloader.mjs')
  await writeFile(preloader, PRELOADER)
  // The bridge forwards `process.env` to the skill CLI, and the provider's own
  // config cannot carry the document, so both variables travel this way.
  process.env.BH_SKILL_FIXTURE = UPSTREAM
  process.env.NODE_OPTIONS = `--import=${pathToFileURL(preloader).href}`
  const modules = new Map<string, unknown>([
    ['browserUse', BrowserUse], ['prompt', SystemPrompt], ['tools', Tools], ['llm', Llm],
    ['sessions', Sessions], ['agents', Agents], ['loop', AgentLoop], ['projections', Projections],
    // The registry mounts before the provider, matching a composition whose
    // base bundle supplies skills and whose provider layer is inserted after it.
    ...withSkills ? [['skills', SkillRegistry] as const] : [],
    ['browser', Provider],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    ...[...modules.keys()].map(name => ({
      id: name,
      name,
      config: name === 'loop'
        ? { agents: [] }
        // No Agent is created, so the MCP server never starts; the bare node
        // command only feeds the skill CLI, which `resolveSkillCommand` leaves
        // untouched because it is not the MCP server name.
        : name === 'browser' ? { command: process.execPath } : {},
    })),
  ]))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected composition module: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

it('activates through the real Loader and publishes the skill into the catalog', async () => {
  const ctx = await boot(true)
  // The skill reaches the model through the same registry every other skill uses.
  const catalog = await ctx.skills.list()
  expect(catalog.map(skill => skill.name)).toContain('browser-harness')
  const loaded = await ctx.skills.get('browser-harness')
  expect(loaded?.content).toContain('Direct browser control via CDP.')
})

it('activates through the real Loader when the composition omits the skill registry', async () => {
  // `skills` is optional for this provider, so its absence must not refuse
  // activation; only the skill is absent from the catalog.
  const ctx = await boot(false)
  expect(ctx.get('skills')).toBeUndefined()
})
