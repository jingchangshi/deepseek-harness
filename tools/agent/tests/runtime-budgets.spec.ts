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
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { getEngineeringStatus } from '../src/automatic.ts'
import type { RoleInvocation } from '../src/automatic.ts'
import { TaskRepository } from '../src/repository.ts'
import * as Runtime from '../runtime/index.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('runtime investigation budgets', () => {
  it.each(['tool', 'provider', 'deadline'] as const)('stops actual %s dispatch at its runtime ceiling without unsafe fallback', async dimension => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-runtime-budget-')))
    const deploymentRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-runtime-budget-deployment-')))
    const ctx = new Context()
    const controller = new AbortController()
    const children: Array<{ dispose: () => Promise<void> }> = []
    const calls: string[] = []
    const prompts: string[] = []
    const bodies: string[] = []
    const errors: boolean[] = []
    const disposed: string[] = []
    const handoff = deferred()
    const disposing = deferred()
    const releaseDisposal = deferred()
    const handoffEvents: string[] = []
    let pending: Promise<unknown> | undefined
    try {
      await cp(resolve('.agent'), join(root, '.agent'), { recursive: true, filter: source => !source.includes(join('.agent', 'tasks')) && !source.includes(join('.agent', 'reviews')) })
      await writeFile(join(root, 'source.txt'), 'Actual source evidence\n')
      await writeFile(join(root, 'other.txt'), 'Independent source evidence\n')
      await writeFile(join(root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 40, maxRoleCalls: 30, commandTimeoutMs: 30_000, investigationUnits: [
        { id: 'a', role: 'scout-primary', question: 'Inspect the source', allowedPaths: ['source.txt'] },
        { id: 'b', role: 'scout-secondary', question: 'Check the other source value', allowedPaths: ['other.txt'] },
      ] }))
      await writeFile(join(root, '.agent/adapters/test.yaml'), dump({ adapters: Object.fromEntries(['unit', 'typecheck', 'build'].map(name => [name, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }])) }))
      const workflowPath = join(root, '.agent/config/workflow.yaml')
      await writeFile(workflowPath, dump({ ...load(await readFile(workflowPath, 'utf8')) as object, roleBounds: { 'scout-primary': { softDeadlineMs: dimension === 'deadline' ? 1000 : 60_000, hardDeadlineMs: dimension === 'deadline' ? 4000 : 120_000, maxToolCalls: 2 } }, ...dimension === 'provider' ? { lifecycleBudget: { maxProviderRequests: 1 } } : {} }))
      const modelsPath = join(root, '.agent/config/models.yaml')
      await writeFile(modelsPath, (await readFile(modelsPath, 'utf8')).replaceAll('${DSH_MAGPIE_GATEWAY_URL}', 'https://fixture.invalid/v1'))
      await execa('git', ['init', '-q'], { cwd: root })
      await execa('git', ['add', 'source.txt', 'other.txt'], { cwd: root })
      await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root })
      await cp(join(root, '.agent'), join(deploymentRoot, '.agent'), { recursive: true })
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(Subagents)
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'agent/inbox/spliced' && JSON.stringify(event.data).includes('soft deadline has arrived')) {
          handoffEvents.push(JSON.stringify(event))
          handoff.resolve()
        }
      })
      class BudgetAdapter extends LlmAdapter {
        stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
          bodies.push('adapter')
          return (async function* () {
            yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } satisfies StreamChunk
            yield { type: 'finish', reason: { kind: 'stop' } } satisfies StreamChunk
          })()
        }
      }
      ctx.llm.registerAdapter(['budget-fixture'], new BudgetAdapter())
      ctx.tools.register(defineTool({ name: 'read', description: 'Read fixture source', sideEffects: 'read-only', parameters: { file_path: { type: 'string', required: true } }, output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          path: { type: 'string', required: true }, offset: { type: 'integer', required: true },
          lines: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            number: { type: 'integer', required: true }, text: { type: 'string', required: true },
          } } }, totalLines: { type: 'integer', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      }, async execute(args) {
        bodies.push(args.file_path)
        const content = await readFile(join(root, args.file_path), 'utf8')
        return { path: join(root, args.file_path), offset: 1, lines: [{ number: 1, text: content.trimEnd() }], totalLines: 1 }
      } }))
      ctx.subagents.registerProvider({ name: 'spawn', inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, async start(request) {
        const prompt = request.prompt[0]
        if (prompt?.type !== 'text') throw new Error('Missing role invocation')
        const invocation = JSON.parse(prompt.text) as RoleInvocation
        calls.push(invocation.role)
        prompts.push(prompt.text)
        if (invocation.role !== 'scout-primary' || dimension === 'deadline' && invocation.attemptIndex > 1) return { id: SessionId(`other-${calls.length}`), localAgent: undefined, result: Promise.resolve({ stopReason: 'aborted' as const, output: [], diagnostic: 'Stop unrelated role' }), async dispose() { disposed.push(invocation.role) } }
        const child = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId(`bounded-${calls.length}`), parentAgent: request.parent, meta: { cwd: root, parentSession: request.parent.id, origin: 'subagent', delegationDepth: 1 } })
        children.push(child)
        const result = (async () => {
          if (dimension === 'deadline') {
            await child.agent.ctx.tools.execute({ callId: ToolCallId('acquired-before-deadline'), name: 'read', arguments: { file_path: 'source.txt' }, signal: request.signal, agent: child.agent })
            await new Promise<void>(resolve => {
              if (request.signal.aborted) resolve()
              else request.signal.addEventListener('abort', () => resolve(), { once: true })
            })
            return { stopReason: 'aborted' as const, output: [] }
          }
          for (let index = 0; index < (dimension === 'provider' ? 2 : 3); index++) {
            if (dimension === 'provider') {
              try {
                for await (const _chunk of child.agent.ctx.llm.stream({ provider: 'budget-fixture', model: 'local-model', messages: [], sessionId: child.agent.session.id, signal: request.signal })) { /* Drain the actual observed adapter dispatch. */ }
                errors.push(false)
              } catch (error) {
                if (!(error instanceof Error)) throw error
                expect(error.message).toMatch(/budget|provider/i)
                errors.push(true)
              }
            } else {
              const outcome = await child.agent.ctx.tools.execute({ callId: ToolCallId(`read-${index}`), name: 'read', arguments: { file_path: 'source.txt' }, signal: request.signal, agent: child.agent })
              errors.push(outcome.isError)
            }
          }
          return { stopReason: 'completed' as const, output: [], structured: { findings: ['Source contains Actual source evidence'], hypotheses: [{ statement: 'The fixture has source evidence', evidence: ['source.txt'] }], unresolvedAssumptions: [] } }
        })()
        return { id: child.agent.id, localAgent: child.agent, result, async dispose() {
          if (dimension === 'deadline') { disposing.resolve(); await releaseDisposal.promise }
          await child.dispose(); disposed.push(invocation.role)
        } }
      } })
      await ctx.plugin(Runtime, { deploymentRoot, roleTimeoutMs: 120_000 })
      const parent = await ctx.agentLoop.create(SessionId('budget-coordinator'), {}, { cwd: root })
      pending = parent.ctx.tools.execute({ callId: ToolCallId('bounded-run'), name: 'engineering_run', arguments: { request: 'Inspect the source with bounded tool calls' }, signal: controller.signal, agent: parent })
      if (dimension === 'deadline') {
        await Promise.race([handoff.promise, pending.then(() => { throw new Error('Role completed without a logged soft-deadline handoff') })])
        expect(handoffEvents).toHaveLength(1)
        await Promise.race([disposing.promise, pending.then(() => { throw new Error('Role completed before its child entered disposal') })])
        expect(calls.filter(role => role === 'scout-primary')).toHaveLength(1)
        expect(disposed).not.toContain('scout-primary')
        const task = (await getEngineeringStatus(root)).tasks[0]
        if (task === undefined) throw new Error('Missing deadline task')
        const checkpoint = await new TaskRepository(root).readInvestigationCheckpoint(task.task.id, 'development', 'a')
        expect(checkpoint).toMatchObject({ status: 'PARTIAL', output: null })
        expect(checkpoint?.evidence).toHaveLength(1)
        expect(checkpoint?.evidence[0]).toMatchObject({ path: 'source.txt', toolName: 'read' })
        releaseDisposal.resolve()
        await pending
        expect(disposed).toContain('scout-primary')
        expect(calls.filter(role => role === 'scout-primary').length).toBeGreaterThan(1)
        return
      }
      await pending
      expect.soft(bodies).toEqual(dimension === 'provider' ? ['adapter'] : ['source.txt', 'source.txt'])
      expect.soft(errors).toEqual(dimension === 'provider' ? [false, true] : [false, false, true])
      expect.soft(calls.filter(role => role === 'scout-primary')).toHaveLength(1)
      expect.soft(disposed).toContain('scout-primary')
      expect.soft(prompts.join('\n')).not.toContain('executionControl')
      expect.soft((await getEngineeringStatus(root)).tasks[0]?.state).toMatchObject({ state: 'BUDGET_EXHAUSTED', writer: null })
    } finally {
      controller.abort()
      releaseDisposal.resolve()
      if (pending !== undefined) await Promise.allSettled([pending])
      await Promise.all(children.map(child => child.dispose()))
      await ctx.fiber.dispose()
      await Promise.all([rm(root, { recursive: true, force: true }), rm(deploymentRoot, { recursive: true, force: true })])
    }
  }, 30_000)
})
