import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import TeamService, { DEFAULT_ROLES } from '../../agent-team/src/index.ts'
import * as toolTeam from '../src/index.ts'

/**
 * The rendered catalog is the ONLY place a model learns its Team routes, so a
 * misread preset used to be undetectable: the base table and a preset table
 * render identically. These tests pin that the catalog names the preset it
 * observed and the table it used, and that a fallback is stated as a warning.
 */

const contexts = new Set<Context>()
const roots: string[] = []

class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('not configured')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('not configured')) }
}

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const TABLE = {
  magpie: [
    { id: 'architect', description: 'Architecture and design', provider: 'magpie', model: 'group/architect', maxConcurrent: 1 },
    { id: 'explorer', description: 'Explore and research', provider: 'magpie', model: 'group/explorer', maxConcurrent: 2 },
    { id: 'implementer', description: 'Implement changes', provider: 'magpie', model: 'group/implementer', maxConcurrent: 2 },
    { id: 'reviewer', description: 'Review changes', provider: 'magpie', model: 'group/reviewer', maxConcurrent: 1 },
    { id: 'challenger', description: 'Challenge assumptions', provider: 'magpie', model: 'group/challenger', maxConcurrent: 1 },
    { id: 'validator', description: 'Validate outcomes', provider: 'magpie', model: 'group/validator', maxConcurrent: 1 },
  ],
  corp: [
    { id: 'architect', description: 'Architecture and design', provider: 'corp', model: 'corp-architect', maxConcurrent: 1 },
    { id: 'explorer', description: 'Explore and research', provider: 'corp', model: 'Qwen3.8-Flash', maxConcurrent: 2 },
    { id: 'implementer', description: 'Implement changes', provider: 'corp', model: 'DeepSeek-V4.1-Flash-1017', maxConcurrent: 2 },
    { id: 'reviewer', description: 'Review changes', provider: 'corp', model: 'GLM-5.3-Flash', maxConcurrent: 1 },
    { id: 'challenger', description: 'Challenge assumptions', provider: 'corp', model: 'corp-challenger', maxConcurrent: 1 },
    { id: 'validator', description: 'Validate outcomes', provider: 'corp', model: 'corp-validator', maxConcurrent: 1 },
  ],
} as const

const SLOT_PLAN = { reserved: ['architect', 'reviewer', 'explorer', 'implementer'].map(id => ({ id, roleId: id })), flex: [] }

/**
 * Structural stand-in for the `agentPreset` Session projection.
 *
 * The real unit ships with the OPTIONAL preset registry, which this suite does
 * not mount; Team routing reads it through `ctx.get` and takes no dependency
 * edge on it. This mirror keeps the contract under test here — a durable fold of
 * `agent-preset/selected` over the creation header — while the real
 * definition's own semantics stay pinned by the registry's suite.
 * @param ctx - context whose projection registry receives the unit.
 */
function mountAgentPresetProjection(ctx: Context): void {
  ctx.sessionProjections.register({
    key: 'agentPreset',
    stateSchema: { parse: (value: unknown) => value } as never,
    init: (header: { readonly agentPreset?: string }) => header.agentPreset ?? null,
    apply: (state: unknown, event: { type: string; data: unknown }) =>
      event.type === 'agent-preset/selected'
        ? (event.data as { agentPreset: string }).agentPreset
        : state,
    stateVersion: 1,
  } as never)
}

/**
 * @param options - Team configuration plus the preset evidence the Lead reports:
 *   `composedPreset` stands in for the preset registry, and `headerPreset` is the
 *   creation-time session header a resumed session carries.
 */
async function setup(options: {
  readonly roleConfig?: Record<string, unknown>
  readonly composedPreset?: string
  readonly headerPreset?: string
} = {}) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-tool-team-catalog-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  mountAgentPresetProjection(ctx)
  await ctx.plugin(TeamService, options.roleConfig ?? {})
  await ctx.plugin(toolTeam)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
  if (options.composedPreset !== undefined) {
    ctx.provide('agentPresets', {
      composedPreset: () => options.composedPreset,
      composeFrom: () => undefined,
    } as never)
  }
  // The header is a creation fact, so it must be set at creation; the projection
  // then folds it forward through any later `agent-preset/selected`. `agents.create`
  // accepts the full creation metadata that `agentLoop.create` narrows to `cwd`.
  const { agent: lead } = await ctx.agents.create({
    sessionId: SessionId('catalog-lead'),
    agentOptions: { provider: 'mock', model: 'mock' },
    ...options.headerPreset === undefined ? {} : { meta: { agentPreset: options.headerPreset } },
  })
  return { ctx, lead }
}

async function catalogOf(ctx: Context, lead: Awaited<ReturnType<typeof setup>>['lead']): Promise<string> {
  const scope = scopeOf(lead.ctx)
  if (scope === undefined) throw new Error('expected scope')
  return renderPrompt(await ctx.systemPrompt.assemble({ scope }))
}

describe('rendered role catalog provenance', () => {
  it('names the preset it observed from the live composition and the table it used', async () => {
    const { ctx, lead } = await setup({
      composedPreset: 'ai-compiler-magpie',
      roleConfig: { roles: TABLE.corp, presetRoles: { 'ai-compiler-magpie': TABLE.magpie }, slotPlan: SLOT_PLAN },
    })
    const prompt = await catalogOf(ctx, lead)
    expect(prompt).toContain('Team roles (preset: ai-compiler-magpie, read from the live composition -> presetRoles table)')
    expect(prompt).toContain('explorer (magpie/group/explorer')
    // The base table is a different route for every corp role; none may render.
    expect(prompt).not.toContain('Qwen3.8-Flash')
    expect(prompt).not.toContain('DeepSeek-V4.1-Flash-1017')
    expect(prompt).not.toContain('GLM-5.3-Flash')
  })

  it('resolves the preset from the session projection when the registry cannot answer', async () => {
    // The exact production defect: no composed preset is queryable, and the
    // creation header still says the preset the session STARTED under. The
    // projection is the only record of the preset the session RUNS under, so
    // reading the header here is what silently produced the wrong table.
    const { ctx, lead } = await setup({
      headerPreset: 'standard',
      roleConfig: {
        roles: TABLE.corp,
        presetRoles: { 'ai-compiler-magpie': TABLE.magpie, 'ai-compiler': TABLE.corp },
        slotPlan: SLOT_PLAN,
      },
    })
    // Record the post-creation selection exactly as a blank-session switch does.
    lead.session.append('agent-preset/selected', { agentPreset: 'ai-compiler-magpie' })
    const prompt = await catalogOf(ctx, lead)
    expect(prompt).toContain('read from the session projection')
    expect(prompt).toContain('-> presetRoles table')
    expect(prompt).toContain('explorer (magpie/group/explorer')
    expect(prompt).not.toContain('Qwen3.8-Flash')
  })

  it('renders an explicit warning when the observed preset has no presetRoles entry', async () => {
    const { ctx, lead } = await setup({
      composedPreset: 'ai-compiler-magpie',
      roleConfig: { roles: TABLE.corp, presetRoles: { 'ai-compiler': TABLE.magpie }, slotPlan: SLOT_PLAN },
    })
    const prompt = await catalogOf(ctx, lead)
    expect(prompt).toContain('Team roles (preset: ai-compiler-magpie, read from the live composition -> roles table)')
    expect(prompt).toContain('WARNING: preset "ai-compiler-magpie" has no presetRoles entry in this deployment, so roles fell back to the base "roles" table.')
    // The warning must name the table that actually rendered.
    expect(prompt).toContain('Qwen3.8-Flash')
  })

  it('renders a warning naming the unreadable preset when none can be observed', async () => {
    const { ctx, lead } = await setup({
      roleConfig: { roles: TABLE.corp, presetRoles: { 'ai-compiler-magpie': TABLE.magpie }, slotPlan: SLOT_PLAN },
    })
    const prompt = await catalogOf(ctx, lead)
    expect(prompt).toContain('Team roles (preset: none observed -> roles table)')
    expect(prompt).toContain('WARNING: no preset id could be observed, so roles fell back to the base "roles" table.')
  })

  it('does not warn when the deployment configures no per-preset routing', async () => {
    // With no presetRoles at all the base table is the only configured
    // authority, so rendering it is correct rather than a substitution.
    const { ctx, lead } = await setup({ roleConfig: { roles: TABLE.corp, slotPlan: SLOT_PLAN } })
    const prompt = await catalogOf(ctx, lead)
    expect(prompt).toContain('-> roles table)')
    expect(prompt).not.toContain('WARNING:')
  })

  it('warns when a preset is observed but the deployment reports no presetRoles at all', async () => {
    // The exact shape that shipped a broken fleet: the Lead correctly
    // observed ai-compiler-magpie, yet config.presetRoles arrived EMPTY (a
    // duplicate-id bundle row had replaced our row wholesale), so every role
    // silently ran on the built-in corp table. Since presetRoles is empty,
    // the older 'has no presetRoles entry' warning cannot fire, so without
    // this branch the model is told nothing at all and reasonably concludes
    // the corp routes ARE that preset's routes.
    const { ctx, lead } = await setup({
      composedPreset: 'ai-compiler-magpie',
      roleConfig: { roles: TABLE.corp, slotPlan: SLOT_PLAN },
    })
    const prompt = await catalogOf(ctx, lead)
    expect(prompt).toContain('Team roles (preset: ai-compiler-magpie, read from the live composition -> roles table)')
    expect(prompt).toContain('WARNING: preset "ai-compiler-magpie" was observed, but this deployment reports NO presetRoles tables at all')
    expect(prompt).toContain('the roles above are the built-in defaults rather than that preset')
    // It must still name the routes it actually rendered, so the model can
    // quote them when it reports the uncertainty.
    expect(prompt).toContain('Qwen3.8-Flash')
  })

  it('renders the no-roles sentence with the same provenance and warning', async () => {
    // A deployment that configures an empty base table and no matching preset
    // entry still has to explain itself: the model sees WHY no role exists.
    const { ctx, lead } = await setup({
      composedPreset: 'ai-compiler-magpie',
      roleConfig: {
        roles: [],
        presetRoles: { 'ai-compiler': TABLE.magpie },
        slotPlan: { reserved: [], flex: [] },
        maxMembers: 1,
      },
    })
    const prompt = await catalogOf(ctx, lead)
    expect(prompt).toContain('Team roles (preset: ai-compiler-magpie, read from the live composition -> roles table): this deployment configures no roles, so spawn_teammate cannot create a teammate.')
    expect(prompt).toContain('WARNING: preset "ai-compiler-magpie" has no presetRoles entry')
  })

  it('never renders DEFAULT_ROLES when a matching preset table exists', async () => {
    const { ctx, lead } = await setup({
      composedPreset: 'ai-compiler-magpie',
      roleConfig: { presetRoles: { 'ai-compiler-magpie': TABLE.magpie }, slotPlan: SLOT_PLAN },
    })
    const prompt = await catalogOf(ctx, lead)
    for (const role of TABLE.magpie) expect(prompt).toContain(`${role.id} (magpie/${role.model}`)
    // The built-in table is what a misread preset produced; its corp routes are
    // character-for-character DEFAULT_ROLES and must never render here.
    for (const role of DEFAULT_ROLES.filter(role => role.provider === 'corp')) {
      expect(prompt, `DEFAULT_ROLES route for ${role.id} must not render`).not.toContain(`corp/${role.model}`)
    }
  })
})
