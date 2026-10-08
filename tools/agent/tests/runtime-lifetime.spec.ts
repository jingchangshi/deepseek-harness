import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { dump, load } from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subagents from '@deepseek-ai/dsh-subagent'
import { describe, expect, it } from 'vitest'
import { getEngineeringStatus } from '../src/automatic.ts'
import * as Runtime from '../runtime/index.ts'

describe('runtime task lifetime', () => {
  it('aborts an in-flight adapter and awaits its child disposal at the cumulative elapsed ceiling', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-runtime-lifetime-')))
    const deploymentRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-runtime-lifetime-deployment-')))
    const ctx = new Context()
    const controller = new AbortController()
    let pending: Promise<unknown> | undefined
    let adapterCalls = 0
    let childDisposed = false
    let adapterStopped = false
    const roles: string[] = []
    const children: Array<{ dispose: () => Promise<void> }> = []
    try {
      await cp(resolve('.agent'), join(root, '.agent'), { recursive: true, filter: source => !source.includes(join('.agent', 'tasks')) && !source.includes(join('.agent', 'reviews')) })
      await writeFile(join(root, 'a.txt'), 'A\n')
      await writeFile(join(root, 'b.txt'), 'B\n')
      await writeFile(join(root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 40, maxRoleCalls: 30, commandTimeoutMs: 30_000, investigationUnits: [
        { id: 'a', role: 'scout-primary', question: 'Inspect A', allowedPaths: ['a.txt'] },
        { id: 'b', role: 'scout-secondary', question: 'Inspect B', allowedPaths: ['b.txt'] },
      ] }))
      await writeFile(join(root, '.agent/adapters/test.yaml'), dump({ adapters: Object.fromEntries(['unit', 'typecheck', 'build'].map(name => [name, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }])) }))
      const workflowPath = join(root, '.agent/config/workflow.yaml')
      await writeFile(workflowPath, dump({ ...load(await readFile(workflowPath, 'utf8')) as object, lifecycleBudget: { maxElapsedMs: 3000 }, roleBounds: { 'scout-primary': { softDeadlineMs: 10_000, hardDeadlineMs: 20_000, maxToolCalls: 40 } } }))
      const modelsPath = join(root, '.agent/config/models.yaml')
      await writeFile(modelsPath, (await readFile(modelsPath, 'utf8')).replaceAll('${DSH_MAGPIE_GATEWAY_URL}', 'https://fixture.invalid/v1'))
      await execa('git', ['init', '-q'], { cwd: root })
      await execa('git', ['add', 'a.txt', 'b.txt'], { cwd: root })
      await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root })
      await cp(join(root, '.agent'), join(deploymentRoot, '.agent'), { recursive: true })
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(Subagents)
      class HeldAdapter extends LlmAdapter {
        override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          adapterCalls++
          if (options.signal === undefined) throw new Error('Missing child lifetime signal')
          await new Promise<void>(resolve => {
            if (options.signal?.aborted) resolve()
            else options.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          expect(String(options.signal.reason)).toMatch(/elapsedMs/)
          adapterStopped = true
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: String(options.signal.reason) } } }
        }
      }
      ctx.llm.registerAdapter(['lifetime-fixture'], new HeldAdapter())
      ctx.subagents.registerProvider({ name: 'spawn', inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, async start(request) {
        const prompt = request.prompt[0]
        if (prompt?.type !== 'text') throw new Error('Missing role invocation')
        const role = (JSON.parse(prompt.text) as { role: string }).role
        roles.push(role)
        if (role !== 'scout-primary') return { id: SessionId(`other-${roles.length}`), localAgent: undefined, result: Promise.resolve({ stopReason: 'aborted' as const, output: [] }), async dispose() {} }
        const child = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('held-lifetime-child'), parentAgent: request.parent, meta: { cwd: root, parentSession: request.parent.id, origin: 'subagent', delegationDepth: 1 } })
        children.push(child)
        const result = (async () => {
          for await (const _chunk of child.agent.ctx.llm.stream({ provider: 'lifetime-fixture', model: 'local-model', messages: [], sessionId: child.agent.session.id, signal: request.signal })) { /* Await the owned adapter's terminal abort. */ }
          return { stopReason: 'aborted' as const, output: [] }
        })()
        return { id: child.agent.id, localAgent: child.agent, result, async dispose() { await child.dispose(); childDisposed = true } }
      } })
      await ctx.plugin(Runtime, { deploymentRoot, roleTimeoutMs: 30_000 })
      const parent = await ctx.agentLoop.create(SessionId('lifetime-coordinator'), {}, { cwd: root })
      pending = parent.ctx.tools.execute({ callId: ToolCallId('lifetime-run'), name: 'engineering_run', arguments: { request: 'Inspect within the cumulative task lifetime' }, signal: controller.signal, agent: parent })
      await pending
      expect(adapterCalls).toBe(1)
      expect(adapterStopped).toBe(true)
      expect(childDisposed).toBe(true)
      expect(roles.filter(role => role === 'scout-primary')).toHaveLength(1)
      expect((await getEngineeringStatus(root)).tasks[0]?.state).toMatchObject({ state: 'BUDGET_EXHAUSTED', writer: null, blocker: expect.stringMatching(/elapsed/i) })
    } finally {
      controller.abort()
      if (pending !== undefined) await Promise.allSettled([pending])
      await Promise.all(children.map(child => child.dispose()))
      await ctx.fiber.dispose()
      await Promise.all([rm(root, { recursive: true, force: true }), rm(deploymentRoot, { recursive: true, force: true })])
    }
  }, 30_000)
})
