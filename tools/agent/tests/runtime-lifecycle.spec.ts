import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { dump } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Subagents from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import * as Runtime from '../runtime/index.ts'

const SOURCE = resolve(import.meta.dirname, '../../..')
const investigation = { findings: ['Fixture observation'], hypotheses: [{ statement: 'Scope must precede a source write', evidence: ['Fixture observation'] }], unresolvedAssumptions: [] }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

async function fixture(roleTimeoutMs = 30_000, holdFallback = false, writerTool?: 'none' | 'read' | 'bash' | 'write') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-engineering-lifecycle-')))
  const deploymentRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-engineering-lifecycle-deployment-')))
  const ctx = new Context()
  const entered = deferred<void>()
  const aborted = deferred<void>()
  const disposing = deferred<void>()
  const fallbackEntered = deferred<void>()
  const fallbackAborted = deferred<void>()
  const release = deferred<void>()
  const completed = deferred<SubagentResult>()
  const calls: Array<{ role: string; routeId: string; signal: AbortSignal; primaryDisposed: boolean; reasoningEffort: string | undefined }> = []
  const bodies: string[] = []
  const toolErrors: boolean[] = []
  let disposed = false
  let active = false
  let detach = () => {}
  try {
    await cp(join(SOURCE, '.agent'), join(root, '.agent'), { recursive: true, filter: source => !source.includes(join('.agent', 'tasks')) })
    const modelsPath = join(root, '.agent/config/models.yaml')
    await writeFile(modelsPath, (await readFile(modelsPath, 'utf8')).replaceAll('${DSH_MAGPIE_GATEWAY_URL}', 'https://fixture.invalid/v1'))
    await writeFile(join(root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 40, maxRoleCalls: 30, commandTimeoutMs: 30_000 }))
    await writeFile(join(root, '.agent/adapters/test.yaml'), dump({ adapters: Object.fromEntries(['typecheck', 'unit', 'build'].map(name => [name, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }])) }))
    await execa('git', ['init', '-q'], { cwd: root })
    await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root })
    await cp(join(root, '.agent'), join(deploymentRoot, '.agent'), { recursive: true })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Subagents)
    if (writerTool !== undefined) {
      for (const name of ['read', 'bash', 'write']) ctx.tools.register(defineTool({
        name, description: 'Fixture tool',
        parameters: name === 'write'
          ? { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } }
          : name === 'bash' ? { workdir: { type: 'string', required: true } } : {},
        ...{ sideEffects: name === 'read' ? 'read-only' as const : 'potentially-mutating' as const },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() {
          bodies.push(name)
          if (name !== 'read') await writeFile(join(root, 'writer-output.txt'), 'Fixture mutation')
          return 'fixture body completed'
        },
      }))
    }
    ctx.subagents.registerProvider({
      name: 'spawn', inheritsParentContext: false,
      capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      async start(request) {
        const prompt = request.prompt[0]
        if (prompt?.type !== 'text') throw new Error('Missing role invocation')
        const invocation = JSON.parse(prompt.text) as { role: string; route: { routeId: string } }
        calls.push({ role: invocation.role, routeId: invocation.route.routeId, signal: request.signal, primaryDisposed: disposed, reasoningEffort: request.agentOptions?.reasoningEffort })
        if (writerTool !== undefined) {
          if (invocation.role === 'implementer') {
            const child = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId(`writer-${calls.length}`), parentAgent: request.parent, meta: { cwd: root, parentSession: request.parent.id, origin: 'subagent', delegationDepth: 1 } })
            if (writerTool !== 'none') {
              const arguments_ = writerTool === 'write' ? { file_path: 'writer-output.txt', content: 'Fixture mutation' }
                : writerTool === 'bash' ? { workdir: '.' } : {}
              const toolResult = await child.agent.ctx.tools.execute({ callId: ToolCallId(`writer-tool-${calls.length}`), name: writerTool, arguments: arguments_, signal: request.signal, agent: child.agent })
              toolErrors.push(toolResult.isError)
            }
            child.agent.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'Fixture provider failure' } } })
            return { id: child.agent.id, localAgent: child.agent, result: Promise.resolve({ stopReason: 'error' as const, output: [] }), dispose: () => child.dispose() }
          }
          const structured = invocation.role === 'architect'
            ? { problemStatement: 'Fixture', hypotheses: ['Fixture'], selectedApproach: 'Fixture', rejectedAlternatives: ['Skip implementation'], invariants: ['Fixture'], expectedComponents: ['source'], implementationScope: ['source'], falsificationTests: ['Fixture'], acceptanceGates: ['unit'], unresolvedAssumptions: [] }
            : invocation.role === 'challenger' ? { decision: 'ACCEPT', summary: 'Fixture', findings: [] } : investigation
          return { id: SessionId(`child-${calls.length}`), localAgent: undefined, result: Promise.resolve({ stopReason: 'completed' as const, output: [], structured }), async dispose() {} }
        }
        const primary = invocation.role === 'scout-secondary' && invocation.route.routeId === 'worker-secondary'
        if (primary) {
          active = true
          const onAbort = () => {
            active = false
            aborted.resolve()
            completed.resolve({ stopReason: 'aborted', output: [] })
          }
          request.signal.addEventListener('abort', onAbort, { once: true })
          detach = () => request.signal.removeEventListener('abort', onAbort)
          entered.resolve()
        }
        const fallback = holdFallback && invocation.role === 'scout-secondary' && !primary
        const fallbackResult = deferred<SubagentResult>()
        const stopFallback = () => {
          fallbackAborted.resolve()
          fallbackResult.resolve({ stopReason: 'aborted', output: [] })
        }
        if (fallback) {
          request.signal.addEventListener('abort', stopFallback, { once: true })
          fallbackEntered.resolve()
        }
        return {
          id: SessionId(`child-${calls.length}`), localAgent: undefined,
          result: primary ? completed.promise : fallback ? fallbackResult.promise : Promise.resolve(invocation.role === 'architect'
            ? { stopReason: 'aborted' as const, output: [], diagnostic: 'Fixture stops after successful investigation' }
            : { stopReason: 'completed' as const, output: [], structured: investigation }),
          async dispose() {
            if (fallback) request.signal.removeEventListener('abort', stopFallback)
            if (!primary) return
            disposing.resolve()
            await release.promise
            detach()
            disposed = true
          },
        }
      },
    })
    const profile = ctx.plugin(Runtime, { deploymentRoot, roleTimeoutMs })
    await profile
    const parent = await ctx.agentLoop.create(SessionId('coordinator'), {}, { cwd: root })
    const controller = new AbortController()
    const pending = parent.ctx.tools.execute({ callId: ToolCallId('lifecycle-call'), name: 'engineering_run', arguments: { request: 'Implement the requested source change' }, signal: controller.signal, agent: parent })
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    return {
      root, profile, controller, pending, calls, bodies, toolErrors, entered, aborted, disposing, release, fallbackEntered, fallbackAborted,
      get active() { return active }, get disposed() { return disposed }, get settled() { return settled },
      async close() {
        controller.abort()
        release.resolve()
        await Promise.allSettled([pending])
        await ctx.fiber.dispose()
        await Promise.all([rm(root, { recursive: true, force: true }), rm(deploymentRoot, { recursive: true, force: true })])
      },
    }
  } catch (error) {
    release.resolve()
    await ctx.fiber.dispose()
    await Promise.all([rm(root, { recursive: true, force: true }), rm(deploymentRoot, { recursive: true, force: true })])
    throw error
  }
}

describe('active engineering runtime cancellation', () => {
  it.each(['none', 'read', 'bash', 'write'] as const)('permits writer fallback only before mutating tool dispatch (%s)', async tool => {
    const run = await fixture(30_000, false, tool)
    try {
      const result = await run.pending
      expect(run.toolErrors).toEqual(tool === 'none' ? [] : tool === 'read' ? [false, false] : [false])
      expect(run.bodies).toEqual(tool === 'none' ? [] : tool === 'read' ? ['read', 'read'] : [tool])
      if (tool === 'bash' || tool === 'write') expect(await readFile(join(run.root, 'writer-output.txt'), 'utf8')).toBe('Fixture mutation')
      const writers = run.calls.filter(call => call.role === 'implementer')
      expect(writers, String(result.value)).toHaveLength(tool === 'none' || tool === 'read' ? 2 : 1)
      expect(run.calls.find(call => call.routeId === 'worker-secondary')?.reasoningEffort).toBeUndefined()
      if (writers.length === 2) expect(writers[1]?.reasoningEffort).toBeUndefined()
      expect(JSON.parse(String(result.value))).toMatchObject({ status: 'BLOCKED' })
      const tasks = await readdir(join(run.root, '.agent/tasks'))
      const source = await readFile(join(run.root, '.agent/tasks', tasks[0]!, 'ROUTE_ATTEMPTS.implementer.jsonl'), 'utf8')
      const attempts = source.trim().split('\n').map(line => JSON.parse(line))
      expect(attempts[0].failureClass).toBe(tool === 'none' || tool === 'read' ? 'PROVIDER_REQUEST_FAILURE' : 'NON_FALLBACKABLE')
    } finally {
      await run.close()
    }
  })

  it.each(['user cancellation', 'profile unload'] as const)('awaits primary quiescence and suppresses fallback after %s', async source => {
    const run = await fixture()
    let unloading: Promise<unknown> | undefined
    let unloaded = false
    try {
      await run.entered.promise
      expect(run.active).toBe(true)
      expect(run.calls.map(call => call.routeId)).not.toContain('worker-secondary-fallback')
      if (source === 'user cancellation') run.controller.abort(new Error('User cancelled'))
      else {
        unloading = run.profile.dispose()
        void unloading.then(() => { unloaded = true }, () => { unloaded = true })
      }
      await run.aborted.promise
      await run.disposing.promise
      expect(run.active).toBe(false)
      expect(run.disposed).toBe(false)
      expect(run.settled).toBe(false)
      if (source === 'profile unload') expect(unloaded).toBe(false)
      run.release.resolve()
      const result = await run.pending
      await unloading
      expect(run.disposed).toBe(true)
      if (source === 'profile unload') expect(JSON.parse(String(result.value))).toMatchObject({ status: 'BLOCKED' })
      else expect(result.isError).toBe(true)
      expect(run.calls.map(call => call.routeId)).not.toContain('worker-secondary-fallback')
      expect(run.calls.some(call => call.role === 'implementer')).toBe(false)
      const tasks = await readdir(join(run.root, '.agent/tasks'))
      expect(tasks).toHaveLength(1)
      const state = JSON.parse(await readFile(join(run.root, '.agent/tasks', tasks[0]!, 'STATE.json'), 'utf8'))
      expect(state.writer).toBeNull()
    } finally {
      await run.close()
      await unloading
    }
  })

  it('gives the fallback a fresh deadline after primary timeout and completed disposal', async () => {
    const run = await fixture(500)
    try {
      await run.entered.promise
      await run.aborted.promise
      await run.disposing.promise
      expect(run.disposed).toBe(false)
      expect(run.calls.map(call => call.routeId)).not.toContain('worker-secondary-fallback')
      run.release.resolve()
      const result = await run.pending
      expect(run.disposed).toBe(true)
      const fallback = run.calls.find(call => call.routeId === 'worker-secondary-fallback')
      expect(fallback?.role).toBe('scout-secondary')
      expect(fallback?.reasoningEffort).toBeUndefined()
      expect(fallback?.signal.aborted).toBe(false)
      expect(fallback?.primaryDisposed).toBe(true)
      const primary = run.calls.find(call => call.role === 'scout-secondary' && call.routeId === 'worker-secondary')
      expect(primary?.signal.aborted).toBe(true)
      expect(fallback?.signal).not.toBe(primary?.signal)
      expect(JSON.parse(String(result.value)), String(result.value)).toMatchObject({ status: 'BLOCKED', nextAction: 'RECOVER' })
      expect(run.calls.some(call => call.role === 'architect')).toBe(true)
      expect(run.calls.some(call => call.role === 'implementer')).toBe(false)
    } finally {
      await run.close()
    }
  })

  it('bounds a still-live fallback with its own local deadline', async () => {
    const run = await fixture(500, true)
    try {
      await run.entered.promise
      await run.aborted.promise
      await run.disposing.promise
      run.release.resolve()
      await run.fallbackEntered.promise
      const fallback = run.calls.find(call => call.routeId === 'worker-secondary-fallback')
      expect(fallback?.primaryDisposed).toBe(true)
      expect(fallback?.signal.aborted).toBe(false)
      await run.fallbackAborted.promise
      await run.pending
      expect(fallback?.signal.aborted).toBe(true)
      expect(run.controller.signal.aborted).toBe(false)
      expect(run.calls.some(call => call.role === 'architect' || call.role === 'implementer')).toBe(false)
    } finally {
      await run.close()
    }
  })

})
