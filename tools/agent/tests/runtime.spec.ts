import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Subagents from '@deepseek-ai/dsh-subagent'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as Runtime from '../runtime/index.ts'
import { providerOptions } from '../runtime/bootstrap.ts'
import { loadHarnessConfig } from '../src/config.ts'
import { fallbackRoleAttempt, RoleInvocationError, roleInvocationErrorForLlmCode } from '../src/role-execution.ts'

const SOURCE = resolve(import.meta.dirname, '../../..')
const disposals: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of disposals.reverse()) await dispose()
  disposals.length = 0
})

async function project(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-engineering-runtime-')))
  disposals.push(() => rm(root, { recursive: true, force: true }))
  await cp(join(SOURCE, '.agent'), join(root, '.agent'), { recursive: true })
  const modelsPath = join(root, '.agent/config/models.yaml')
  await writeFile(modelsPath, (await readFile(modelsPath, 'utf8')).replaceAll('${DSH_MAGPIE_GATEWAY_URL}', 'https://fixture.invalid/v1'))
  return root
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('engineering role lifecycle', () => {
  it.each([
    ['PI_AI_ERROR', 'PROVIDER_REQUEST_FAILURE'],
    ['INVALID_CREDENTIAL', 'PROVIDER_REQUEST_FAILURE'],
    ['POLICY_REFUSAL', 'POLICY_REFUSED'],
    ['NO_ADAPTER', 'ROUTE_EXECUTION_FAILURE'],
    ['UNKNOWN', undefined],
  ] as const)('classifies durable child error %s without treating unknown codes as providers', async (code, expected) => {
    const root = await project()
    const ctx = new Context()
    disposals.push(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Subagents)
    await ctx.plugin(Runtime, { deploymentRoot: root, roleTimeoutMs: 1000 })
    const child = await ctx.agentLoop.create(SessionId('classified-child'), {}, { cwd: root })
    child.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code, message: 'fixture failure' } } })
    let disposed = false
    const signal = new AbortController().signal
    const error = await Runtime.collectRole({
      id: child.id, localAgent: child,
      result: Promise.resolve({ stopReason: 'error', output: [], diagnostic: 'opaque provider detail' }),
      dispose: async () => { disposed = true },
    }, 'scout-secondary', 'provider', 'model', signal).catch((error: unknown) => error)
    expect(disposed).toBe(true)
    expect(error).toBeInstanceOf(RoleInvocationError)
    expect(fallbackRoleAttempt(error, signal)?.failureClass).toBe(expected)
  })

  it.each([
    'NO_ADAPTER',
    'UNKNOWN_MODEL',
    'UNSUPPORTED_REASONING_EFFORT',
    'INVALID_MODEL_INFO',
    'INVALID_MODEL_CONTEXT',
    'INVALID_MODEL_MAX_TOKENS',
    'INVALID_MODEL_REASONING',
    'INVALID_CATALOG',
    'NO_DISCOVERY',
  ] as const)('maps stable route-resolution code %s to one typed route failure', code => {
    const error = roleInvocationErrorForLlmCode(code, 'route resolution failed')
    expect(error).toBeInstanceOf(RoleInvocationError)
    expect(fallbackRoleAttempt(error, new AbortController().signal)?.failureClass).toBe('ROUTE_EXECUTION_FAILURE')
  })

  it.each([
    ['QUOTA', 'PROVIDER_REQUEST_FAILURE'],
    ['ACCOUNT_QUOTA', 'PROVIDER_REQUEST_FAILURE'],
    ['STREAM_CLOSED', 'PROVIDER_REQUEST_FAILURE'],
    ['MALFORMED_RESPONSE', 'MODEL_MALFORMED_OUTPUT'],
    ['POLICY_REFUSAL', 'POLICY_REFUSED'],
  ] as const)('maps canonical route-fallback code %s to %s', (code, failureClass) => {
    const error = roleInvocationErrorForLlmCode(code, 'candidate route failed')
    expect(error).toBeInstanceOf(RoleInvocationError)
    expect(fallbackRoleAttempt(error, new AbortController().signal)?.failureClass).toBe(failureClass)
  })

  it.each([
    'DUPLICATE_ADAPTER',
    'REGISTRATION_DISPOSED',
    'INVALID_PREPARED_CALL',
    'ABORTED',
    'ABORTED_BEFORE_DISPATCH',
    'QUOTA_EXCEEDED',
    'UNKNOWN',
  ] as const)('keeps lifecycle, registration, programming and abort code %s non-fallbackable', code => {
    expect(roleInvocationErrorForLlmCode(code, 'unclassified failure')).toBeUndefined()
  })

  it.each(['aborted', 'refusal', 'error'] as const)('does not fallback from unclassified child status %s or diagnostic text', async stopReason => {
    const signal = new AbortController().signal
    const error = await Runtime.collectRole({
      id: SessionId('child'), localAgent: undefined,
      result: Promise.resolve({ stopReason, output: [], diagnostic: 'code POLICY_REFUSAL; unclassified diagnostic text' }),
      dispose: async () => {},
    }, 'scout-secondary', 'provider', 'model', signal).catch((error: unknown) => error)
    expect(fallbackRoleAttempt(error, signal)).toBeUndefined()
  })

  it('keeps a rejected result non-fallbackable', async () => {
    const signal = new AbortController().signal
    const error = await Runtime.collectRole({
      id: SessionId('child'), localAgent: undefined,
      result: Promise.reject(new Error('session storage failed')),
      dispose: async () => {},
    }, 'scout-secondary', 'provider', 'model', signal).catch((error: unknown) => error)
    expect(fallbackRoleAttempt(error, signal)).toBeUndefined()
  })

  it.each([
    'PROVIDER_REQUEST_FAILURE',
    'ROUTE_EXECUTION_FAILURE',
    'MISSING_STRUCTURED_OUTPUT',
    'SCHEMA_INVALID',
    'MODEL_MALFORMED_OUTPUT',
    'ROLE_TIMEOUT_QUIESCENT',
    'POLICY_REFUSED',
  ] as const)('accepts explicitly eligible failure class %s', failureClass => {
    const signal = new AbortController().signal
    expect(fallbackRoleAttempt(new RoleInvocationError('classified failure', failureClass, true), signal))
      .toEqual({ failureClass, fallbackReason: 'classified failure' })
  })

  it('rejects an explicitly noneligible failure class', () => {
    const signal = new AbortController().signal
    expect(fallbackRoleAttempt(new RoleInvocationError('classified failure', 'NON_FALLBACKABLE', true), signal)).toBeUndefined()
  })

  it('classifies only a locally timed-out quiescent child as fallbackable', async () => {
    const signal = new AbortController().signal
    const timeout = new AbortController()
    timeout.abort(new Error('role deadline'))
    let disposed = false
    const error = await Runtime.collectRole({
      id: SessionId('child'), localAgent: undefined,
      result: Promise.resolve({ stopReason: 'aborted', output: [] }),
      dispose: async () => { disposed = true },
    }, 'scout-secondary', 'provider', 'model', signal, timeout.signal).catch((error: unknown) => error)
    expect(disposed).toBe(true)
    expect(error).toBeInstanceOf(RoleInvocationError)
    expect(fallbackRoleAttempt(error, signal)?.failureClass).toBe('ROLE_TIMEOUT_QUIESCENT')
  })

  it('never reclassifies external cancellation as a local timeout', async () => {
    const signal = new AbortController()
    const timeout = new AbortController()
    signal.abort(new Error('user cancelled'))
    timeout.abort(new Error('role deadline'))
    let disposed = false
    const error = await Runtime.collectRole({
      id: SessionId('child'), localAgent: undefined,
      result: Promise.reject(new Error('child cancelled')),
      dispose: async () => { disposed = true },
    }, 'scout-secondary', 'provider', 'model', signal.signal, timeout.signal).catch((error: unknown) => error)
    expect(disposed).toBe(true)
    expect(error).toBeInstanceOf(RoleInvocationError)
    expect(fallbackRoleAttempt(error, signal.signal)).toBeUndefined()
  })

  it('keeps an ordinary child failure non-fallbackable when the deadline fires during disposal', async () => {
    const entered = deferred()
    const release = deferred()
    const signal = new AbortController().signal
    const timeout = new AbortController()
    const output = Runtime.collectRole({
      id: SessionId('child'), localAgent: undefined,
      result: Promise.resolve({ stopReason: 'error', output: [], diagnostic: 'storage invariant failed' }),
      dispose: async () => { entered.resolve(); await release.promise },
    }, 'scout-secondary', 'provider', 'model', signal, timeout.signal)
    await entered.promise
    timeout.abort(new Error('role deadline'))
    release.resolve()
    const error = await output.catch((error: unknown) => error)
    expect(error).toBeInstanceOf(RoleInvocationError)
    expect(fallbackRoleAttempt(error, signal)).toBeUndefined()
  })

  it.each(['cleanup', 'cancel'] as const)('suppresses provider fallback after %s', async failure => {
    const abort = new AbortController()
    if (failure === 'cancel') abort.abort()
    const error = await Runtime.collectRole({
      id: SessionId('child'), localAgent: undefined,
      result: Promise.resolve({ stopReason: 'error', output: [], diagnostic: 'code PI_AI_ERROR' }),
      dispose: async () => { if (failure === 'cleanup') throw new Error('child still live') },
    }, 'scout-secondary', 'provider', 'model', abort.signal).catch((error: unknown) => error)
    expect(fallbackRoleAttempt(error, abort.signal)).toBeUndefined()
  })

  it('waits for disposal before publishing a completed role result', async () => {
    const entered = deferred()
    const release = deferred()
    const run: SubagentRun = {
      id: SessionId('child'), localAgent: undefined,
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ignored prose' }], structured: { summary: 'done' } }),
      dispose: async () => { entered.resolve(); await release.promise },
    }
    const output = Runtime.collectRole(run, 'architect', 'provider', 'model')
    let settled = false
    void output.then(() => { settled = true })
    await entered.promise
    expect(settled).toBe(false)
    release.resolve()
    await expect(output).resolves.toEqual({ summary: 'done' })
  })

  it.each(['aborted', 'error', 'max-tokens', 'refusal'] as const)('rejects %s with disposal complete', async (stopReason) => {
    let disposed = false
    const run: SubagentRun = {
      id: SessionId('child'), localAgent: undefined,
      result: Promise.resolve({ stopReason, output: [{ type: 'text', text: '{}' }], diagnostic: 'HTTP 404; code PI_AI_ERROR' }),
      dispose: async () => { disposed = true },
    }
    await expect(Runtime.collectRole(run, 'architect', 'anthropic-relay', 'claude-opus')).rejects.toThrow(
      `architect child child via anthropic-relay/claude-opus ended with ${stopReason}. Diagnostic: HTTP 404; code PI_AI_ERROR`,
    )
    expect(disposed).toBe(true)
  })

  it('keeps both JSON failure and independent cleanup failure', async () => {
    const run: SubagentRun = {
      id: SessionId('child'), localAgent: undefined,
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'unused' }] }),
      dispose: async () => { throw new Error('cleanup failed') },
    }
    const error = await Runtime.collectRole(run, 'architect', 'provider', 'model').catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError)) throw new Error('missing aggregate')
    expect(String(error.errors[0])).toContain('completed without structured output')
    expect(String(error.errors[1])).toContain('cleanup failed')
  })
})

describe('engineering project authority', () => {
  it('protects user deployment files and symlink aliases when DSH home is inside the repository', async () => {
    const root = await project()
    const deployment = join(root, '.dsh/engineering')
    await mkdir(deployment, { recursive: true })
    await symlink(deployment, join(root, 'deployment-alias'), 'junction')
    await Runtime.assertWritablePath(root, 'src/new/pass.cpp', deployment)
    for (const path of ['.dsh/engineering/models.yaml', 'deployment-alias/models.yaml']) {
      await expect(Runtime.assertWritablePath(root, path, deployment)).rejects.toThrow('may only use files under the project source tree')
    }
  })

  it('rejects workflow, Git, outside-root and symlink-alias writes', async () => {
    const root = await project()
    await mkdir(join(root, '.git'))
    await symlink(join(root, '.agent'), join(root, 'workflow-alias'), 'junction')
    await Runtime.assertWritablePath(root, 'src/new/pass.cpp')
    for (const path of ['.agent/config/models.yaml', '.git/config', '../outside.cpp', 'workflow-alias/new.json', 'workflow-alias/../STATE.json']) {
      await expect(Runtime.assertWritablePath(root, path)).rejects.toThrow('may only use files under the project source tree')
    }
  })

  it('confines a shell working directory by the same rule as a write target', async () => {
    const root = await project()
    const deployment = join(root, '.dsh/engineering')
    await mkdir(deployment, { recursive: true })
    await Runtime.assertWritablePath(root, 'bishengir/lib', deployment, 'working directories')
    for (const path of ['.agent/tasks/task-1', '/tmp', '.git', '..']) {
      await expect(Runtime.assertWritablePath(root, path, deployment, 'working directories')).rejects
        .toThrow('may only use working directories under the project source tree')
    }
  })

  it('restricts the Coordinator in its actual Session workspace and unwinds tools on unload', async () => {
    const root = await project()
    const ctx = new Context()
    disposals.push(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Subagents)
    ctx.tools.register(defineTool({
      name: 'write', description: 'Test source write capability', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'written' },
    }))
    const fiber = ctx.plugin(Runtime, { deploymentRoot: root, roleTimeoutMs: 1000 })
    await fiber
    const parent = await ctx.agentLoop.create(SessionId('coordinator'), {}, { cwd: root })
    expect(parent.ctx.tools.get('engineering_run', parent)).toBeDefined()
    expect(parent.ctx.tools.get('write', parent)).toBeUndefined()
    const prompt = await parent.ctx.systemPrompt.assemble({ scope: parent })
    expect(prompt.sections.some(section => section.text.includes('complete user requirement'))).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.get('engineering_run')).toBeUndefined()
    expect(ctx.tools.get('engineering_status')).toBeUndefined()
    expect(ctx.tools.get('engineering_recover')).toBeUndefined()
    expect(parent.ctx.tools.get('write', parent)).toBeDefined()
    expect((await parent.ctx.systemPrompt.assemble({ scope: parent })).sections.some(section => section.name === 'engineering:coordinator')).toBe(false)
  })

  it('uses the deployment routes in another Session repository without reading its model declarations', async () => {
    const deployment = await project()
    const other = await project()
    const loaded = await loadHarnessConfig(other)
    const provider = loaded.providers[loaded.routes['worker']!.provider]!
    await writeFile(join(other, '.agent/config/models.yaml'), (await import('node:fs/promises').then(fs => fs.readFile(join(other, '.agent/config/models.yaml'), 'utf8'))).replace(provider.apiKeyEnv, 'OTHER_CREDENTIAL'))
    const ctx = new Context()
    disposals.push(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Subagents)
    await ctx.plugin(Runtime, { deploymentRoot: deployment, roleTimeoutMs: 1000 })
    const parent = await ctx.agentLoop.create(SessionId('other-workspace'), {}, { cwd: other })
    expect(parent.ctx.tools.get('engineering_run', parent)).toBeDefined()
  })

  it('projects the Anthropic relay compat switch into the provider options', () => {
    const options = providerOptions({
      runtimeTag: 'test',
      providers: {
        anthropic: { api: 'anthropic-messages', baseURL: 'https://relay.invalid', apiKeyEnv: 'DSH_ANTHROPIC_RELAY_API_KEY', compat: { forceAdaptiveThinking: true } },
      },
      routes: {
        'architecture': {
          displayName: 'Claude Opus 5.5', provider: 'anthropic', model: 'claude-opus-5.5',
          reasoningEfforts: { high: 'high' }, maxDataClass: 'internal', externalRelay: true, costClass: 'premium',
        },
      },
      roles: {
        architect: {
          route: 'architecture', reasoningEffort: 'high', maxTokens: 32768, personaFile: 'architect.md',
          writable: false, toolPolicy: 'read-only', toolName: 'ask_architect', enabled: true, allowPremium: true, fallbackRoutes: [],
        },
      },
      workflow: { provider: 'spawn', maxDepth: 1, maxConcurrentAgents: 3, maxTotalAgents: 12, minimumFanout: 2, boundedFixRounds: 2, ralphEnabled: false, arbiterEnabled: false },
      dataPolicy: { classes: { public: 0, internal: 1, sensitive: 2 }, allowedSensitiveInputs: [], forbiddenCommittedPatterns: [] },
    })
    expect(options['anthropic']?.compat).toEqual({ forceAdaptiveThinking: true })
  })

  it('advertises no thinking levels for MiMo, GLM and Qwen adapter models', async () => {
    const config = await loadHarnessConfig(SOURCE, { env: { DSH_MAGPIE_GATEWAY_URL: 'https://fixture.invalid/v1' } })
    const providers = providerOptions(config)
    for (const name of ['worker-secondary', 'worker-secondary-fallback', 'worker-fallback']) {
      const route = config.routes[name]!
      const model = providers[route.provider]?.models?.find(model => model.id === route.model)
      expect(model, route.model).toBeDefined()
      expect(model?.reasoningEfforts, route.model).toBe(false)
    }
  })

  it('rejects an absent required endpoint before adapter activation', async () => {
    const config = await loadHarnessConfig(SOURCE, { env: {} })
    expect(() => providerOptions(config)).toThrow('unresolved environment')
  })

  it('leaves disabled provider variables unresolved while requiring enabled routes', async () => {
    const config = await loadHarnessConfig(SOURCE, { env: { DSH_MAGPIE_GATEWAY_URL: 'https://fixture.invalid/v1' } })
    config.routes['arbiter']!.model = '${UNRESOLVED_DISABLED_MODEL}'
    expect(() => providerOptions(config)).not.toThrow()
    config.routes['worker']!.model = '${UNRESOLVED_ENABLED_MODEL}'
    expect(() => providerOptions(config)).toThrow('unresolved environment')
  })
})
