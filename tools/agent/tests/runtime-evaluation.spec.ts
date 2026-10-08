import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Subagents from '@deepseek-ai/dsh-subagent'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import * as Evaluation from '../runtime/evaluation.ts'
import * as Runtime from '../runtime/index.ts'
import { loadHarnessConfig, resolveRoleRoute } from '../src/config.ts'
import type { RoleInvocation } from '../src/automatic.ts'

const source = resolve(import.meta.dirname, '../../..')
const roots: string[] = []
const fibers: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fibers.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-evaluation-${label}-`))
  roots.push(root)
  await cp(join(source, '.agent'), join(root, '.agent'), { recursive: true })
  const models = join(root, '.agent/config/models.yaml')
  await writeFile(models, (await readFile(models, 'utf8')).replaceAll('${DSH_MAGPIE_GATEWAY_URL}', 'https://fixture.invalid/v1'))
  return root
}

function emptyEvaluationReport() {
  const metric = {
    acceptedCount: 0, rejectedCount: 0, acceptanceUnknownCount: 0, acceptanceKnownCount: 0,
    acceptanceDenominator: 0, firstPassCount: 0, firstPassFailureCount: 0,
    firstPassUnknownCount: 0, firstPassDenominator: 0, tokensPerSuccess: 'UNKNOWN' as const,
    estimatedCostUsdPerSuccess: 'UNKNOWN' as const, evidenceStatus: 'UNKNOWN' as const,
  }
  return {
    mode: 'LIVE_PROVIDER' as const,
    reportPath: '/tmp/evaluation-report.json',
    results: [],
    aggregates: {
      comparisonStatus: 'UNKNOWN' as const,
      tokensPerSuccess: 'UNKNOWN' as const,
      costPerSuccess: 'UNKNOWN' as const,
      byStrategy: { A_STRONG: metric, B_CHEAP: metric, C_FIXED: metric, D_ADAPTIVE: metric },
    },
  }
}

interface DispatchObservation {
  parent: Parameters<SubagentProvider['start']>[0]['parent']
  maxDepth: number | undefined
  toolFilter: unknown
  agentOptions: unknown
  childCwds: string[]
}

async function runEvaluation(options: { failAfterDispatch?: boolean } = {}) {
  const originalRoot = await workspace('coordinator')
  const fixtureRoot = await workspace('fixture')
  await writeFile(join(originalRoot, 'marker.txt'), 'coordinator workspace marker')
  await writeFile(join(fixtureRoot, 'marker.txt'), 'evaluation fixture marker')
  const deployment = await loadHarnessConfig(originalRoot, { env: {} })
  const expectedRoute = resolveRoleRoute(deployment, 'scout-primary')
  const ctx = new Context()
  fibers.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  ctx.tools.register(defineTool({
    name: 'read', description: 'Read a fixture file', sideEffects: 'read-only',
    parameters: { file_path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) throw new Error('fixture read requires an agent working directory')
      return readFile(resolve(cwd, args.file_path), 'utf8')
    },
  }))
  ctx.tools.register(defineTool({
    name: 'glob', description: 'List the fixture marker', sideEffects: 'read-only', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'marker.txt' },
  }))
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('evaluation workspace tests do not execute shell') },
    run() { throw new Error('evaluation workspace tests do not execute shell') },
    start() { throw new Error('evaluation workspace tests do not execute shell') },
  })
  ctx.provide('approval', { config: { policy: 'ask' } })
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: originalRoot })
  await ctx.plugin(PermissionPresetService)

  let dispatched: DispatchObservation | undefined
  let originalSessionId: string | undefined
  const disposed = new Set<string>()
  const childReads: unknown[] = []
  ctx.on('session/disposed', session => { disposed.add(session.id) })
  const provider: SubagentProvider = {
    name: 'spawn',
    inheritsParentContext: false,
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    async start(request) {
      const child = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId(`evaluation-child-${String(dispatched?.childCwds.length ?? 0)}`),
        parentAgent: request.parent,
        meta: {
          ...(request.parent.session.header.cwd === undefined ? {} : { cwd: request.parent.session.header.cwd }),
          parentSession: request.parent.id,
          origin: 'subagent',
          delegationDepth: (request.parent.session.header.delegationDepth ?? 0) + 1,
        },
      })
      const childCwds = dispatched?.childCwds ?? []
      childCwds.push(child.agent.session.header.cwd ?? '')
      dispatched = {
        parent: request.parent,
        maxDepth: request.maxDepth,
        toolFilter: request.toolFilter,
        agentOptions: request.agentOptions,
        childCwds,
      }
      childReads.push(await child.agent.ctx.tools.execute({
        callId: ToolCallId('evaluation-child-read'), name: 'read', arguments: { file_path: 'marker.txt' },
        signal: request.signal, agent: child.agent,
      }))
      return {
        id: child.agent.id,
        localAgent: child.agent,
        result: Promise.resolve({ stopReason: 'completed' as const, output: [], structured: {
          findings: ['Fixture workspace was inspected'],
          hypotheses: [{ statement: 'The evaluation fixture is the role workspace', evidence: ['fixture root'] }],
          unresolvedAssumptions: [],
        } }),
        dispose: () => child.dispose(),
      }
    },
  }
  ctx.subagents.registerProvider(provider)
  await ctx.plugin(Runtime, {
    deploymentRoot: originalRoot,
    roleTimeoutMs: 30_000,
    evaluation: { strongRouteId: 'architecture', cheapRouteId: 'worker' },
  })
  const parent = await ctx.agentLoop.create(SessionId('evaluation-coordinator'), {}, { cwd: originalRoot })
  ctx.permissionPresets.set(parent.session, 'danger-full-access')
  const originalHeader = { ...parent.session.header }
  originalSessionId = parent.session.id

  const invocation: RoleInvocation = {
    role: 'scout-primary',
    route: expectedRoute,
    attemptIndex: 1,
    root: fixtureRoot,
    taskId: 'evaluation-fixture-task',
    request: 'Inspect the fixture repository.',
    state: { state: 'INVESTIGATED', revision: 1, workRevision: 1, fixAttempts: 0 },
    context: {},
    outputSchema: { type: 'object', properties: {}, required: [] },
    signal: new AbortController().signal,
  }
  const evaluate = vi.spyOn(Evaluation, 'runProfileEngineeringEvaluation').mockImplementation(async profileOptions => {
    const extended = profileOptions as typeof profileOptions & {
      withFixture?: <T>(root: string, operation: () => Promise<T>) => Promise<T>
    }
    const operation = async () => {
      await profileOptions.executeRole(invocation)
      if (options.failAfterDispatch) throw new Error('Synthetic evaluation failure after role dispatch')
    }
    if (extended.withFixture === undefined) await operation()
    else await extended.withFixture(fixtureRoot, operation)
    return emptyEvaluationReport()
  })
  const result = await parent.ctx.tools.execute({
    callId: ToolCallId('evaluation-call'),
    name: 'engineering_evaluate',
    arguments: { caseId: 'recovery-latch' },
    signal: new AbortController().signal,
    agent: parent,
  })
  return { result, evaluate, dispatched, fixtureRoot, parent, originalHeader, originalSessionId, disposed, childReads,
    expectedMaxDepth: 1, expectedRoute, permissionPresets: ctx.permissionPresets }
}

describe('evaluation fixture role workspace', () => {
  it('dispatches role children in the evaluation fixture while preserving coordinator authority', async () => {
    const run = await runEvaluation()
    expect(run.result.isError).toBe(false)
    expect(run.evaluate).toHaveBeenCalledOnce()
    expect(run.dispatched).toBeDefined()
    if (run.dispatched === undefined) throw new Error('evaluation role was not dispatched')
    expect(run.dispatched.parent.session.header.cwd).toBe(run.fixtureRoot)
    expect(run.dispatched.parent.session.header.id).not.toBe(run.originalSessionId)
    expect(run.dispatched.parent.session.header.parentSession).toBeUndefined()
    expect(run.dispatched.maxDepth).toBe(run.expectedMaxDepth)
    expect(run.dispatched.toolFilter).toMatchObject({ allow: expect.arrayContaining(['read', 'glob']) })
    expect(run.dispatched.agentOptions).toMatchObject({ provider: run.expectedRoute.provider, model: run.expectedRoute.model, maxTokens: run.expectedRoute.maxTokens })
    expect(run.dispatched.childCwds).toEqual([run.fixtureRoot])
    expect(run.childReads).toEqual([expect.objectContaining({ isError: false, content: [{ type: 'text', text: 'evaluation fixture marker' }] })])
    expect(run.permissionPresets.current(run.dispatched.parent.session)).toBe('danger-full-access')
    expect(delegationDepthOf(run.dispatched.parent)).toBe(delegationDepthOf(run.parent))
    expect(run.dispatched.parent.session.header.agentPreset).toBe(run.parent.session.header.agentPreset)
    expect(run.dispatched.parent.session.ownEvents().some(event => event.type.startsWith('assistant/'))).toBe(false)
    expect(run.parent.session.header).toEqual(run.originalHeader)
    expect(run.disposed.has(run.dispatched.parent.session.id)).toBe(true)
    expect(run.disposed.has(run.originalSessionId)).toBe(false)
  })

  it('disposes the fixture carrier when evaluation fails after role dispatch', async () => {
    const run = await runEvaluation({ failAfterDispatch: true })
    expect(run.result.isError).toBe(true)
    expect(run.dispatched).toBeDefined()
    if (run.dispatched === undefined) throw new Error('evaluation role was not dispatched')
    expect(run.disposed.has(run.dispatched.parent.session.id)).toBe(true)
    expect(run.parent.session.header).toEqual(run.originalHeader)
    expect(run.disposed.has(run.originalSessionId)).toBe(false)
  })
})
