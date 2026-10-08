import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { dump, load } from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subagents from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { describe, expect, it } from 'vitest'
import * as Runtime from '../runtime/index.ts'
import { getEngineeringStatus } from '../src/automatic.ts'

class UsageAdapter extends LlmAdapter {
  calls = 0
  constructor(private readonly failure: boolean) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return Promise.resolve({ provider, id: model, name: model }) }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    if (++this.calls > 12) throw new Error('Fixture usage request cap reached')
    if (this.failure) throw new Error('Fixture provider stream failed before usage')
    const id = ToolCallId(`usage-${this.calls}`)
    const argumentsJson = JSON.stringify({ response: { status: 'escalate', reason: 'EVIDENCE_INSUFFICIENT', details: 'Need more source evidence', partial: { observations: [], unresolvedQuestions: [] } } })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: 'structured_output', argumentsDelta: argumentsJson }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'structured_output', arguments: argumentsJson } }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 80, cacheWriteTokens: 0, reasoningTokens: 7 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

describe('runtime adapter usage settlement', () => {
  it.each(['aggregate-cache', 'failure-without-usage'] as const)('persists actual %s dispatch evidence through the real child loop', async scenario => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-runtime-usage-')))
    const deploymentRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-runtime-usage-deployment-')))
    const ctx = new Context()
    const adapter = new UsageAdapter(scenario === 'failure-without-usage')
    const posts: Array<{ requestId: string; outcome: string; usage?: Readonly<TokenUsage> }> = []
    try {
      await cp(resolve('.agent'), join(root, '.agent'), { recursive: true, filter: source => !source.includes(join('.agent', 'tasks')) && !source.includes(join('.agent', 'reviews')) })
      await writeFile(join(root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 20, maxRoleCalls: 20, commandTimeoutMs: 30_000 }))
      await writeFile(join(root, '.agent/adapters/test.yaml'), dump({ adapters: Object.fromEntries(['unit', 'typecheck', 'build'].map(name => [name, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }])) }))
      const modelsPath = join(root, '.agent/config/models.yaml')
      await writeFile(modelsPath, (await readFile(modelsPath, 'utf8')).replaceAll('${DSH_MAGPIE_GATEWAY_URL}', 'https://fixture.invalid/v1'))
      const rolesPath = join(root, '.agent/config/roles.yaml')
      const roles = load(await readFile(rolesPath, 'utf8')) as { roles: Record<string, Record<string, unknown>> }
      for (const role of Object.values(roles.roles)) { role.escalationRoutes = []; role.escalationFallbackRoutes = []; role.fallbackRoutes = [] }
      await writeFile(rolesPath, dump(roles))
      await execa('git', ['init', '-q'], { cwd: root })
      await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'usage seed'], { cwd: root })
      await cp(join(root, '.agent'), join(deploymentRoot, '.agent'), { recursive: true })
      await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(Subagents)
      ctx.llm.registerAdapter(['magpie', 'magpie-responses', 'company'], adapter)
      ctx.on('llm/post-dispatch', post => { posts.push({ requestId: post.requestId, outcome: post.outcome, ...(post.usage === undefined ? {} : { usage: post.usage }) }) })
      ctx.subagents.registerProvider({ name: 'spawn', inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, start: request => startInProcessRun(request, {}) })
      await ctx.plugin(Runtime, { deploymentRoot, roleTimeoutMs: 30_000 })
      const parent = await ctx.agentLoop.create(SessionId('usage-coordinator'), {}, { cwd: root })
      await parent.ctx.tools.execute({ callId: ToolCallId('usage-task'), name: 'engineering_run', arguments: { request: 'Inspect the bounded source' }, signal: new AbortController().signal, agent: parent })
      expect(adapter.calls).toBeGreaterThan(0)
      expect(posts).toHaveLength(adapter.calls)
      const task = (await getEngineeringStatus(root)).tasks[0]!
      const ledger = JSON.parse(await readFile(join(root, '.agent/tasks', task.task.id, 'LIFECYCLE.json'), 'utf8')) as { requests: Array<{ id: string; usage?: object; settlement?: { outcome: string; usage?: object } }> }
      expect(ledger.requests).toHaveLength(adapter.calls)
      for (const post of posts) {
        const request = ledger.requests.find(row => row.id === post.requestId)
        expect(request).toBeDefined()
        if (scenario === 'aggregate-cache') expect(request?.usage).toEqual(post.usage)
        expect(request, 'Every real adapter post, including failure without usage, must settle the admitted request').toMatchObject({ settlement: { outcome: post.outcome } })
      }
      if (scenario === 'failure-without-usage') expect(posts.every(post => post.outcome === 'FAILED' && post.usage === undefined)).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      await Promise.all([rm(root, { recursive: true, force: true }), rm(deploymentRoot, { recursive: true, force: true })])
    }
  }, 30_000)
})
