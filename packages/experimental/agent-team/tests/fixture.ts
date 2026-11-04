import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { onTestFinished } from 'vitest'
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
import TeamService, { DEFAULT_ROLES, RoleId, type Config, type SpawnTeammateRequest } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

export const signal = new AbortController().signal
export const text = (value: string) => [{ type: 'text' as const, text: value }]
export const testRoles = DEFAULT_ROLES.map(role => ({ ...role, provider: 'mock', model: 'mock', maxConcurrent: 8 }))

export async function stack(config: Config = {}, root?: string, script: ConstructorParameters<typeof MockAdapter>[0] = Array.from({ length: 30 }, () => textResponse('done')), resume = false) {
  const ctx = new Context()
  const lifetime: { releaseLead?: () => Promise<void> } = {}
  const ownRoot = root === undefined
  root ??= await mkdtemp(join(tmpdir(), 'dsh-team-roles-'))
  const storageRoot = root
  onTestFinished(async () => {
    await lifetime.releaseLead?.()
    await ctx.fiber.dispose()
    if (ownRoot) await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Fork, { providerName: 'fork' })
  await ctx.plugin(TeamService, { roles: testRoles, ...config })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const resumed = resume ? await ctx.agents.resume({ resumeSessionId: SessionId('lead'), agentOptions: { provider: 'mock', model: 'mock' } }) : undefined
  if (resumed !== undefined) lifetime.releaseLead = async () => { await resumed.dispose() }
  const lead = resumed?.agent ?? await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  const spawn = (role: string, options: Partial<Omit<SpawnTeammateRequest, 'roleId'>> = {}) => ctx.agentTeams.spawnTeammate(lead, {
    roleId: RoleId(role), context: 'fresh', task: text('work'), signal, ...options,
  })
  const state = () => ctx.sessionProjections.stateOf(lead.session, 'agentTeam')!
  const idle = async (id: SessionId) => { await ctx.agents.get(id)?.whenIdle() }
  return { ctx, lead, adapter, storageRoot, spawn, state, idle }
}
