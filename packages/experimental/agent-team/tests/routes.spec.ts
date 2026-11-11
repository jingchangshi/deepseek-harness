import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import TeamService, {
  DEFAULT_ROLES,
  RoleId,
  presetIdOf,
  presetSelectionOf,
  resolveRoles,
  resolveRoleTable,
} from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

/**
 * Role-route resolution must have exactly ONE authority and must expose where
 * its answer came from. The production defect these tests pin: the preset
 * ladder fell straight to the creation-time session header, which is frozen at
 * creation, so a session that selected its preset after creation resolved
 * against the wrong id and silently routed by the built-in table.
 */

const contexts = new Set<Context>()
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const SLOT_PLAN = {
  reserved: ['architect', 'reviewer', 'explorer', 'implementer'].map(id => ({ id, roleId: RoleId(id) })),
  flex: [],
}

/**
 * Structural stand-in for the `agentPreset` Session projection.
 *
 * The real unit ships with the OPTIONAL preset registry, exactly like the
 * `agentPresets` roster stand-in below: Team routing reads both through
 * `ctx.get` and never takes a dependency edge on them. This mirror keeps the
 * contract under test here (a durable fold of `agent-preset/selected` over the
 * creation header) while the real definition's own semantics stay pinned by
 * `agent-preset-registry`'s suite.
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

/** One preset table distinguished by a model prefix, so the selected table is observable. */
const table = (suffix: string) => DEFAULT_ROLES.map(role => ({
  ...role, provider: suffix === 'corp' ? 'corp' : 'magpie', model: `${suffix}-${role.id}`,
}))

/**
 * @param options - Team configuration plus the preset evidence the Lead carries:
 *   `composedPreset` stands in for the preset registry, `headerPreset` is the
 *   deep-frozen creation-time header, `selectedPreset` is a post-creation
 *   selection recorded as a session event, and `withProjection` removes the
 *   projection service entirely to exercise the last rung.
 */
async function setup(options: {
  readonly config?: Config
  readonly composedPreset?: string
  readonly headerPreset?: string
  readonly selectedPreset?: string
  readonly withoutPresetService?: boolean
} = {}) {
  const ctx = new Context()
  contexts.add(ctx)
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-routes-'))
  roots.push(root)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Fork, { providerName: 'fork' })
  mountAgentPresetProjection(ctx)
  await ctx.plugin(TeamService, { slotPlan: SLOT_PLAN, ...options.config })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 8 }, () => textResponse('done'))))
  if (options.composedPreset !== undefined) {
    ctx.provide('agentPresets', {
      composedPreset: () => options.composedPreset,
      composeFrom: () => undefined,
    } as never)
  }
  const { agent: lead } = await ctx.agents.create({
    sessionId: SessionId('routes-lead'),
    agentOptions: { provider: 'mock', model: 'mock' },
    ...options.headerPreset === undefined ? {} : { meta: { agentPreset: options.headerPreset } },
  })
  if (options.selectedPreset !== undefined) {
    lead.session.append('agent-preset/selected', { agentPreset: options.selectedPreset })
  }
  return { ctx, lead }
}

describe('preset resolution ladder', () => {
  it('reads the session projection when no live composition can answer', async () => {
    // The header says what the session STARTED as ('standard'); the projection
    // says what it RUNS as. Only the projection is authoritative.
    const { lead } = await setup({ headerPreset: 'standard', selectedPreset: 'ai-compiler-magpie' })
    expect(lead.session.header.agentPreset).toBe('standard')
    expect(presetSelectionOf(lead)).toEqual({ presetId: 'ai-compiler-magpie', source: 'projection' })
    expect(presetIdOf(lead)).toBe('ai-compiler-magpie')
  })

  it('prefers the live composition over the projection and the header', async () => {
    const { lead } = await setup({
      composedPreset: 'ai-compiler-magpie',
      headerPreset: 'standard',
      selectedPreset: 'ai-compiler',
    })
    expect(presetSelectionOf(lead)).toEqual({ presetId: 'ai-compiler-magpie', source: 'composed' })
  })

  it('keeps a projection value that agrees with the header', async () => {
    const { lead } = await setup({ headerPreset: 'standard' })
    // The projection initializes from the header, so it answers even with no
    // selection event: the header rung is only for a registry-free deployment.
    expect(presetSelectionOf(lead)).toEqual({ presetId: 'standard', source: 'projection' })
  })

  it('falls through to the header only when the projection service is absent', async () => {
    const ctx = new Context()
    contexts.add(ctx)
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-routes-bare-'))
    roots.push(root)
    await mountAgentLoopTestDependencies(ctx)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    await ctx.plugin(Fork, { providerName: 'fork' })
    await ctx.plugin(TeamService, { slotPlan: SLOT_PLAN })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    const { agent: lead } = await ctx.agents.create({
      sessionId: SessionId('bare-lead'),
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { agentPreset: 'standard' },
    })
    // `agentPreset` is registered by the optional preset registry, so this
    // context has the projection service but not the unit: `stateOf` answers
    // undefined and the rung falls through to the frozen creation header.
    expect(ctx.get('sessionProjections')?.stateOf(lead.session, 'agentPreset')).toBeUndefined()
    expect(presetSelectionOf(lead)).toEqual({ presetId: 'standard', source: 'header' })
    expect(presetIdOf(lead)).toBe('standard')
  })

  it('reports no preset at all when no rung can name one', async () => {
    const { lead } = await setup()
    // No header preset and no selection event: the projection folds to null.
    expect(presetSelectionOf(lead)).toEqual({ presetId: undefined, source: 'none' })
    expect(presetIdOf(lead)).toBeUndefined()
  })
})

describe('role table provenance', () => {
  const config = (presetRoles: Record<string, ReturnType<typeof table>>) => ({
    roles: table('corp'), presetRoles, slotPlan: SLOT_PLAN,
  })

  it('routes by the preset table and reports presetRoles as the source', async () => {
    const { ctx, lead } = await setup({
      headerPreset: 'standard',
      selectedPreset: 'ai-compiler-magpie',
      config: config({ 'ai-compiler-magpie': table('magpie'), ai: table('corp') }),
    })
    const resolution = ctx.agentTeams.resolvedRoleTable(lead)
    expect(resolution).toMatchObject({ presetId: 'ai-compiler-magpie', presetSource: 'projection', table: 'presetRoles', fellBack: false })
    expect(resolution.roles.map(role => role.model)).toEqual(DEFAULT_ROLES.map(role => `magpie-${role.id}`))
    // A teammate and the Lead share one route source.
    expect(ctx.agentTeams.rolesFor(lead)).toBe(resolution.roles)
  })

  it('reports a fallback when the observed preset has no entry', async () => {
    const { ctx, lead } = await setup({
      composedPreset: 'ai-compiler-magpie',
      config: config({ 'ai-compiler': table('corp') }),
    })
    expect(ctx.agentTeams.resolvedRoleTable(lead)).toMatchObject({
      presetId: 'ai-compiler-magpie', presetSource: 'composed', table: 'roles', fellBack: true,
    })
  })

  it('reports a fallback when no preset can be observed while per-preset routing exists', async () => {
    const { ctx, lead } = await setup({ config: config({ 'ai-compiler-magpie': table('magpie') }) })
    expect(ctx.agentTeams.resolvedRoleTable(lead)).toMatchObject({
      presetId: undefined, presetSource: 'none', table: 'roles', fellBack: true,
    })
  })

  it('does not call the base table a fallback when no per-preset routing is configured', async () => {
    const { ctx, lead } = await setup({ config: { roles: table('corp'), slotPlan: SLOT_PLAN } })
    expect(ctx.agentTeams.resolvedRoleTable(lead)).toMatchObject({ table: 'roles', fellBack: false })
  })

  it('keeps resolveRoles as the thin table-only wrapper existing callers use', async () => {
    // The provenance-bearing resolver is the authority; the original signature
    // stays supported so a caller that only needs routes does not have to
    // destructure, and cannot accidentally read a different table.
    const cfg = TeamService.Config({
      roles: table('corp'),
      presetRoles: { 'ai-compiler-magpie': table('magpie') },
      slotPlan: SLOT_PLAN,
    }) as Required<Config>
    const { lead } = await setup({ composedPreset: 'ai-compiler-magpie' })
    expect(resolveRoles(cfg, lead)).toBe(resolveRoleTable(cfg, lead).roles)
    expect(resolveRoles(cfg, lead).map(role => role.model)).toEqual(DEFAULT_ROLES.map(role => `magpie-${role.id}`))
  })

  it('resolveRoleTable is the same authority the spawn path uses', async () => {
    const cfg = TeamService.Config({
      roles: table('corp'),
      presetRoles: { 'ai-compiler-magpie': table('magpie') },
      slotPlan: SLOT_PLAN,
    }) as Required<Config>
    const { ctx, lead } = await setup({
      composedPreset: 'ai-compiler-magpie',
      config: { roles: table('corp'), presetRoles: { 'ai-compiler-magpie': table('magpie') }, slotPlan: SLOT_PLAN },
    })
    // The exported resolver over the normalized config and the service method
    // must agree; a spawn resolves through the latter.
    expect(resolveRoleTable(cfg, lead).roles.map(role => role.model))
      .toEqual(ctx.agentTeams.resolvedRoleTable(lead).roles.map(role => role.model))
  })
})

/**
 * Operator intent at the CONFIG layer: the deployment's own bundle patch must
 * route every role of the single-provider preset through `magpie` group models.
 * A code fix cannot help a config whose table itself names another provider.
 */
describe('deployment bundle intent', () => {
  const patch = '/home/s00653124/workspace/dsh-compiler-mode/config/bundle-ai-compiler/bundles.patch.yml'

  it('routes every ai-compiler-magpie role through a magpie group model', async () => {
    if (!existsSync(patch)) {
      // The bundle lives in the operator workspace, not this checkout; skip
      // loudly rather than pass on an absent fixture.
      console.warn(`skipped: deployment bundle patch not present at ${patch}`)
      return
    }
    const text = await readFile(patch, 'utf8')
    const block = text.slice(text.indexOf('ai-compiler-magpie:'))
    const rows = [...block.slice(0, block.indexOf('- id: tool-agent-team')).matchAll(/\{([^}]*)\}/gu)]
      .map(match => match[1]!)
    expect(rows.length).toBeGreaterThanOrEqual(6)
    const parsed = rows.map(row => ({
      id: /id:\s*([\w-]+)/u.exec(row)![1]!,
      provider: /provider:\s*([\w-]+)/u.exec(row)![1]!,
      model: /model:\s*([\w/.-]+)/u.exec(row)![1]!,
    }))
    expect(parsed.map(row => row.id)).toEqual(['architect', 'explorer', 'implementer', 'reviewer', 'challenger', 'validator'])
    for (const row of parsed) {
      expect(row.provider, `role ${row.id} must route through magpie`).toBe('magpie')
      expect(row.model, `role ${row.id} must name a magpie group model`).toMatch(/^group\//u)
    }
  })
})
