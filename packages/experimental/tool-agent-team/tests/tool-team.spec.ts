import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
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
import TeamService from '../../agent-team/src/index.ts'
import * as toolTeam from '../src/index.ts'

const SIGNAL = new AbortController().signal
const roots: string[] = []
const contexts = new Set<Context>()
let callNumber = 0

class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('not configured')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('not configured')) }
}

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * @param options - optional Team-service configuration plus the preset the Lead
 *   is reported as composed under, so a test can exercise per-preset routing.
 */
async function setup(options: {
  readonly roleConfig?: Record<string, unknown>
  readonly composedPreset?: string
} = {}) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-tool-team-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TeamService, options.roleConfig ?? {})
  await ctx.plugin(toolTeam)
  const adapter = new MockAdapter([])
  ctx.llm.registerAdapter(['mock'], adapter)
  if (options.composedPreset !== undefined) {
    // Team routing reads only `composedPreset` from the optional preset roster,
    // and the in-process child composition probes the same service, so this
    // stand-in reports an id and declines to join children to it.
    ctx.provide('agentPresets', {
      composedPreset: () => options.composedPreset,
      composeFrom: () => undefined,
    } as never)
  }
  const lead = await ctx.agentLoop.create(SessionId('tool-team-lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead }
}

function execute(ctx: Context, agent: Agent | undefined, name: string, args: unknown) {
  return ctx.tools.execute({
    callId: ToolCallId(`team-call-${++callNumber}`),
    name, arguments: args, signal: SIGNAL,
    ...agent === undefined ? {} : { agent },
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

const MEMBER = {
  id: SessionId('member-explorer-g1'),
  name: 'explorer-g1',
  role: 'teammate' as const,
  status: 'inactive' as const,
  roleId: 'explorer' as never,
  slotId: 'explorer',
  generation: 1,
  diagnostics: [],
}

describe('dsh-tool-team role API', () => {
  it('spawn_teammate forwards role/task/context/slot and returns role identity', async () => {
    const { ctx, lead } = await setup()
    const spy = vi.spyOn(ctx.agentTeams, 'spawnTeammate').mockResolvedValue({ member: MEMBER })
    const result = await execute(ctx, lead, 'spawn_teammate', { role: 'explorer', task: 'investigate X', slot: 'explorer' })
    expect(result.isError).toBe(false)
    expect(spy).toHaveBeenCalledWith(lead, expect.objectContaining({
      roleId: 'explorer', context: 'fresh', slotId: 'explorer',
      task: [{ type: 'text', text: 'investigate X' }],
    }))
    expect(JSON.parse(text(result)).member).toMatchObject({ roleId: 'explorer', slotId: 'explorer', generation: 1 })
  })

  it('send_message asserts expected_role through the service', async () => {
    const { ctx, lead } = await setup()
    const spy = vi.spyOn(ctx.agentTeams, 'sendMessage').mockResolvedValue({ messageId: 'msg-1' as never })
    const result = await execute(ctx, lead, 'send_message', { target: 'explorer-g1', message: 'hi', expected_role: 'explorer' })
    expect(result.isError).toBe(false)
    expect(spy).toHaveBeenCalledWith(lead, expect.objectContaining({
      target: 'explorer-g1', expectedRole: 'explorer', content: [{ type: 'text', text: 'hi' }],
    }))
  })

  it('list_agents exposes roleId, slotId and generation', async () => {
    const { ctx, lead } = await setup()
    vi.spyOn(ctx.agentTeams, 'listMembers').mockReturnValue([MEMBER as never])
    const result = await execute(ctx, lead, 'list_agents', {})
    expect(JSON.parse(text(result))[0]).toMatchObject({ target: 'explorer-g1', roleId: 'explorer', slotId: 'explorer', generation: 1 })
  })

  it('team_task_create forwards required_role', async () => {
    const { ctx, lead } = await setup()
    const task = { id: 'task-1', revision: 1, subject: 's', description: 'd', status: 'pending', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [], requiredRole: 'explorer' as never }
    const spy = vi.spyOn(ctx.agentTeams, 'createTask').mockReturnValue(task as never)
    const result = await execute(ctx, lead, 'team_task_create', { subject: 's', description: 'd', required_role: 'explorer' })
    expect(result.isError).toBe(false)
    expect(spy).toHaveBeenCalledWith(lead, expect.objectContaining({ requiredRole: 'explorer' }))
  })

  it('retire_teammate delegates to the service', async () => {
    const { ctx, lead } = await setup()
    const spy = vi.spyOn(ctx.agentTeams, 'retireTeammate').mockResolvedValue(MEMBER as never)
    const result = await execute(ctx, lead, 'retire_teammate', { target: 'explorer-g1' })
    expect(result.isError).toBe(false)
    expect(spy).toHaveBeenCalledWith(lead, 'explorer-g1')
  })

  it('injects the role catalog, expected_role and backpressure guidance', async () => {
    const { ctx, lead } = await setup()
    const scope = scopeOf(lead.ctx)
    if (scope === undefined) throw new Error('expected scope')
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope }))
    expect(prompt).toContain('Roles (role fixes the model route')
    expect(prompt).toContain('expected_role')
    expect(prompt).toContain('backpressure')
  })

  it('renders the role catalog from the configured table, not a hardcoded list', async () => {
    const { ctx, lead } = await setup({
      roleConfig: {
        roles: [{
          id: 'architect', description: 'Design only', provider: 'magpie',
          model: 'group/architect', maxConcurrent: 3,
        }],
        slotPlan: { reserved: [{ id: 'architect', roleId: 'architect' }], flex: [] },
        maxMembers: 2,
      },
    })
    const scope = scopeOf(lead.ctx)
    if (scope === undefined) throw new Error('expected scope')
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope }))
    expect(prompt).toContain('Roles (role fixes the model route and its concurrency): architect (magpie/group/architect, Design only, max 3).')
    // The built-in explorer route must not survive as boilerplate.
    expect(prompt).not.toContain('Qwen3.8-Flash')
  })

  it('renders the catalog of the table the Lead preset selects', async () => {
    const { ctx, lead } = await setup({
      composedPreset: 'ai-compiler-magpie',
      roleConfig: {
        roles: [{ id: 'architect', description: 'Design only', provider: 'corp', model: 'corp-architect', maxConcurrent: 1 }],
        presetRoles: {
          'ai-compiler-magpie': [{ id: 'architect', description: 'Design only', provider: 'magpie', model: 'group/architect', maxConcurrent: 1 }],
        },
        slotPlan: { reserved: [{ id: 'architect', roleId: 'architect' }], flex: [] },
        maxMembers: 2,
      },
    })
    const scope = scopeOf(lead.ctx)
    if (scope === undefined) throw new Error('expected scope')
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope }))
    expect(prompt).toContain('architect (magpie/group/architect, Design only, max 1)')
    expect(prompt).not.toContain('corp-architect')
  })
})
