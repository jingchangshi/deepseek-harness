import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { dump } from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subagents from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as Automatic from '../src/automatic.ts'
import type { RoleInvocation } from '../src/automatic.ts'
import * as Runtime from '../runtime/index.ts'

const SOURCE = resolve(import.meta.dirname, '../../..')
const investigation = { findings: ['Fixture observation'], hypotheses: [{ statement: 'Scope must precede a source write', evidence: ['Fixture observation'] }], unresolvedAssumptions: [] }
const architect = { problemStatement: 'Fixture', hypotheses: ['Fixture'], selectedApproach: 'Fixture', rejectedAlternatives: ['Skip implementation'], invariants: ['Fixture'], expectedComponents: ['source'], implementationScope: ['source'], falsificationTests: ['Fixture'], acceptanceGates: ['unit'], unresolvedAssumptions: [] }
const executeTask = Automatic.runEngineeringTask
const observers = new Map<string, (invocation: RoleInvocation) => void>()

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

type Scenario = 'unknown-bash' | 'hidden-write' | 'guard-write' | 'invalid-arguments' | 'invalid-path' | 'read' | 'grep' | 'lsp' | 'write' | 'short-circuit' | 'cancelled' | 'concurrent-scouts'

/** Real runtime and state machine; provider responses alone are deterministic fixtures. */
async function fixture(scenario: Scenario, bodyBarrier?: ReturnType<typeof deferred>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-engineering-mutation-')))
  const deploymentRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-engineering-deployment-')))
  const ctx = new Context()
  const controller = new AbortController()
  const calls: Array<{ role: string; routeId: string; id: string }> = []
  const mutations: Array<{ role: string; attempt: number }> = []
  const bodies: string[] = []
  const bodyMutationCounts: number[] = []
  const toolResults: ToolExecutionResult[] = []
  const bodyEntered = deferred()
  const bodiesEntered = { read: deferred(), grep: deferred() }
  let pending: Promise<ToolExecutionResult> | undefined
  const target = ['unknown-bash', 'hidden-write', 'guard-write', 'read', 'grep', 'lsp', 'concurrent-scouts'].includes(scenario) ? 'scout-secondary' : 'implementer'
  observers.set(root, invocation => mutations.push({ role: invocation.role, attempt: invocation.attemptIndex }))
  try {
    await cp(join(SOURCE, '.agent'), join(root, '.agent'), { recursive: true, filter: source => !source.includes(join('.agent', 'tasks')) })
    const models = join(root, '.agent/config/models.yaml')
    await writeFile(models, (await readFile(models, 'utf8')).replaceAll('${DSH_MAGPIE_GATEWAY_URL}', 'https://fixture.invalid/v1'))
    await writeFile(join(root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 40, maxRoleCalls: 30, commandTimeoutMs: 30_000 }))
    await writeFile(join(root, '.agent/adapters/test.yaml'), dump({ adapters: Object.fromEntries(['typecheck', 'unit', 'build'].map(name => [name, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }])) }))
    await execa('git', ['init', '-q'], { cwd: root })
    await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root })
    await cp(join(root, '.agent'), join(deploymentRoot, '.agent'), { recursive: true })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Subagents)
    for (const name of ['read', 'grep', 'lsp', 'write']) ctx.tools.register(defineTool({
      name, description: 'Fixture tool',
      ...{ sideEffects: name === 'write' || scenario === 'concurrent-scouts' && name === 'read' ? 'potentially-mutating' as const : 'read-only' as const },
      parameters: name === 'write' ? { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } } : {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() {
        bodyMutationCounts.push(mutations.length)
        bodies.push(name)
        bodyEntered.resolve()
        if (name === 'read' || name === 'grep') bodiesEntered[name].resolve()
        if (bodyBarrier !== undefined) await bodyBarrier.promise
        if (name === 'write' || scenario === 'concurrent-scouts' && name === 'read') await writeFile(join(root, 'source.txt'), 'side effect')
        return 'fixture result'
      },
    }))
    if (scenario === 'guard-write') ctx.tools.guard(exec => exec.name === 'write' ? 'Fixture Guard denies writes' : undefined)
    if (scenario === 'short-circuit') ctx.on('tools/execute', async (exec, next) => exec.name === 'write'
      ? { isError: true, error: { message: 'Fixture wrapper stopped dispatch' }, content: [{ type: 'text', text: 'Fixture wrapper stopped dispatch' }] }
      : next())
    ctx.subagents.registerProvider({
      name: 'spawn', inheritsParentContext: false,
      capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      async start(request) {
        const prompt = request.prompt[0]
        if (prompt?.type !== 'text') throw new Error('Missing role invocation')
        const invocation = JSON.parse(prompt.text) as { role: string; route: { routeId: string }; attemptIndex: number }
        const id = SessionId(`mutation-child-${calls.length}`)
        calls.push({ role: invocation.role, routeId: invocation.route.routeId, id })
        if ((invocation.role !== target && !(scenario === 'concurrent-scouts' && invocation.role === 'scout-primary')) || invocation.attemptIndex > 1) {
          const structured = invocation.role === 'architect' ? architect : invocation.role === 'challenger' ? { decision: 'ACCEPT', summary: 'Fixture', findings: [] } : investigation
          return { id, localAgent: undefined, result: Promise.resolve(invocation.role === 'implementer' || invocation.role === 'architect' && target !== 'implementer'
            ? { stopReason: 'aborted' as const, output: [] }
            : { stopReason: 'completed' as const, output: [], structured }), async dispose() {} }
        }
        const child = await ctx.agentLoop.createAgent(ctx, { sessionId: id, parentAgent: request.parent, meta: { cwd: root, parentSession: request.parent.id, origin: 'subagent', delegationDepth: 1 } })
        // The fixture provider applies the actual route visibility supplied by the runtime.
        // Guard denial is separate from visibility, so that case exposes write deliberately.
        if (scenario !== 'guard-write' && request.toolFilter !== undefined) child.agent.ctx.tools.restrict(request.toolFilter)
        const tool = scenario === 'concurrent-scouts' ? invocation.role === 'scout-primary' ? 'read' : 'grep' : scenario === 'unknown-bash' ? 'bash' : ['read', 'grep', 'lsp', 'concurrent-scouts'].includes(scenario) ? scenario : 'write'
        const arguments_ = scenario === 'invalid-arguments' ? { file_path: 'source.txt', content: 42 }
          : scenario === 'invalid-path' ? { file_path: '.git/config', content: 'forbidden' }
          : tool === 'write' ? { file_path: 'source.txt', content: 'side effect' } : {}
        const local = new AbortController()
        if (scenario === 'cancelled') local.abort(new Error('Fixture cancelled before execution'))
        const execution = child.agent.ctx.tools.execute({ callId: ToolCallId(`mutation-call-${calls.length}`), name: tool, arguments: arguments_, signal: AbortSignal.any([request.signal, local.signal]), agent: child.agent })
        const result = execution.then(value => {
          toolResults.push(value)
          child.agent.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'Fixture provider failure after tool outcome' } } })
          return { stopReason: 'error' as const, output: [] }
        })
        return { id, localAgent: child.agent, result, dispose: () => child.dispose() }
      },
    })
    await ctx.plugin(Runtime, { deploymentRoot, roleTimeoutMs: 30_000 })
    const parent = await ctx.agentLoop.create(SessionId('mutation-coordinator'), {}, { cwd: root })
    pending = parent.ctx.tools.execute({ callId: ToolCallId('mutation-engineering-run'), name: 'engineering_run', arguments: { request: 'Implement the requested source change' }, signal: controller.signal, agent: parent })
    return { root, pending, calls, mutations, bodies, bodyMutationCounts, bodyEntered, bodiesEntered, toolResults, target,
      async close() {
        controller.abort()
        bodyBarrier?.resolve()
        if (pending !== undefined) await Promise.allSettled([pending])
        await ctx.fiber.dispose()
        observers.delete(root)
        await Promise.all([rm(root, { recursive: true, force: true }), rm(deploymentRoot, { recursive: true, force: true })])
      },
    }
  } catch (error) {
    controller.abort()
    bodyBarrier?.resolve()
    await ctx.fiber.dispose()
    observers.delete(root)
    await Promise.all([rm(root, { recursive: true, force: true }), rm(deploymentRoot, { recursive: true, force: true })])
    throw error
  }
}

beforeEach(() => {
  vi.spyOn(Automatic, 'runEngineeringTask').mockImplementation(options => executeTask({ ...options,
    executeRole: invocation => options.executeRole({ ...invocation, markMutationStarted: () => {
      observers.get(options.root)?.(invocation)
      invocation.markMutationStarted?.()
    } }),
  }))
})
afterEach(() => { vi.restoreAllMocks() })

describe('engineering runtime mutation admission', () => {
  it.each(['unknown-bash', 'hidden-write', 'guard-write', 'invalid-arguments', 'invalid-path', 'short-circuit', 'cancelled'] as const)('keeps rejected %s safe for fallback without running a body', async scenario => {
    const run = await fixture(scenario)
    try {
      await run.pending
      expect(run.toolResults).toHaveLength(1)
      expect(run.toolResults[0]?.isError).toBe(true)
      expect(run.bodies).toEqual([])
      const errors: Record<typeof scenario, RegExp> = {
        'unknown-bash': /bash/i, 'hidden-write': /write/i, 'guard-write': /Fixture Guard denies writes/,
        'invalid-arguments': /invalid arguments/, 'invalid-path': /outside \.agent and \.git/,
        'short-circuit': /Fixture wrapper stopped dispatch/, cancelled: /aborted before dispatch/,
      }
      expect(run.toolResults[0]?.error?.message).toMatch(errors[scenario])
      expect.soft(run.mutations).toEqual([])
      expect.soft(run.calls.filter(call => call.role === run.target)).toHaveLength(2)
      await expect(readFile(join(run.root, 'source.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await run.close() }
  })

  it.each(['read', 'grep', 'lsp'] as const)('executes %s without disabling safe fallback', async tool => {
    const run = await fixture(tool)
    try {
      await run.pending
      expect(run.toolResults[0]?.isError).toBe(false)
      expect(run.bodies).toEqual([tool])
      expect(run.bodyMutationCounts).toEqual([0])
      expect(run.mutations).toEqual([])
      expect(run.calls.filter(call => call.role === run.target)).toHaveLength(2)
    } finally { await run.close() }
  })

  it('marks actual writer execution before the first side effect and prevents fallback', async () => {
    const run = await fixture('write')
    try {
      await run.pending
      expect(run.bodies).toEqual(['write'])
      expect(run.bodyMutationCounts).toEqual([1])
      expect(run.mutations).toEqual([{ role: 'implementer', attempt: 1 }])
      expect(await readFile(join(run.root, 'source.txt'), 'utf8')).toBe('side effect')
      expect(run.calls.filter(call => call.role === 'implementer')).toHaveLength(1)
    } finally { await run.close() }
  })

  it('isolates mutation between overlapping children in the same runtime', async () => {
    const release = deferred()
    const run = await fixture('concurrent-scouts', release)
    try {
      await Promise.all([run.bodiesEntered.read.promise, run.bodiesEntered.grep.promise])
      // A mutating capability deliberately uses a read-visible fixture name.
      // Classification must follow metadata, independently for each Agent.
      expect.soft(run.mutations).toEqual([{ role: 'scout-primary', attempt: 1 }])
      release.resolve()
      await run.pending
      expect(run.bodies).toEqual(expect.arrayContaining(['read', 'grep']))
      expect(run.calls.filter(call => call.role === 'scout-primary')).toHaveLength(1)
      expect(run.calls.filter(call => call.role === 'scout-secondary')).toHaveLength(2)
      expect(run.mutations).toEqual([{ role: 'scout-primary', attempt: 1 }])
    } finally { await run.close() }
  })

  it('isolates mutation between overlapping writer and read-only child Agents', async () => {
    const release = deferred()
    const writer = await fixture('write', release)
    let reader: Awaited<ReturnType<typeof fixture>> | undefined
    try {
      await writer.bodyEntered.promise
      reader = await fixture('read', release)
      await reader.bodyEntered.promise
      expect(writer.mutations).toEqual([{ role: 'implementer', attempt: 1 }])
      expect(reader.mutations).toEqual([])
      expect(writer.calls.filter(call => call.role === 'implementer')).toHaveLength(1)
      release.resolve()
      await Promise.all([writer.pending, reader.pending])
      expect(writer.calls.filter(call => call.role === 'implementer')).toHaveLength(1)
      expect(reader.calls.filter(call => call.role === 'scout-secondary')).toHaveLength(2)
      expect(reader.mutations).toEqual([])
      expect(writer.bodies).toEqual(['write'])
      expect(reader.bodies).toEqual(['read'])
    } finally {
      release.resolve()
      await Promise.all([writer.close(), reader?.close()])
    }
  })
})
