import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_SCHEMA, dump, load, Type } from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'
import { loadHarnessConfig, resolveRoleFallbackRoutes, resolveRoleRoute } from '../src/config.ts'
import { providerOptions } from '../runtime/bootstrap.ts'
import type { ResolvedRoleRoute } from '../src/config.ts'
import { correlateSessionEvidence, createPinnedHeadlessExecutor, evaluateRole, extractHeadlessResult, runRealModelSmokes } from '../src/smoke-real.ts'
import type { RealSmokeEvidence, RealSmokeExecutor, SessionEvidence, ToolEvidence } from '../src/smoke-real.ts'
import { EngineeringRoleFailure, runEngineeringTask } from '../src/automatic.ts'
import { RoleInvocationError } from '../src/role-execution.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const ROOT = resolve(import.meta.dirname, '../../..')
const deployment = { MAGPIE_API_KEY: 'test-magpie-key', DSH_MAGPIE_GATEWAY_URL: 'https://fixture.invalid/v1' }

const PARENT = 'session-parent'
const CHILD = 'session-child'
const REAL_FALLBACK_ENV = ['MAGPIE_API_KEY'] as const
const realFallbackEnabled = process.env.DSH_REAL_FALLBACK_EXPERIMENT === '1'
  && REAL_FALLBACK_ENV.every(name => (process.env[name] ?? '').trim().length > 0)

function tool(sessionId: string, callId: string, name: string, ok: boolean): ToolEvidence {
  return { sessionId, callId, name, ok }
}

type EvidenceParts = Partial<Omit<RealSmokeEvidence, 'sessions'>> & { sessions?: Partial<SessionEvidence> }

function evidence(parts: EvidenceParts = {}): RealSmokeEvidence {
  const base: SessionEvidence = { sessions: [PARENT], childSessions: [], rootSessions: [PARENT], tools: [], routes: [], failures: [], finalTexts: [] }
  return {
    exitCode: parts.exitCode === undefined ? 0 : parts.exitCode,
    timedOut: parts.timedOut ?? false,
    finalText: parts.finalText ?? '',
    diagnostic: parts.diagnostic ?? '',
    sessions: { ...base, ...parts.sessions },
  }
}

/** A delegated role whose child Session read the marker successfully. */
function delegated(role: string, route: ResolvedRoleRoute, sessions: Partial<SessionEvidence> = {}, stream: Partial<Omit<RealSmokeEvidence, 'sessions'>> = {}): RealSmokeEvidence {
  return evidence({
    ...stream,
    finalText: stream.finalText ?? `DSH_REAL_SMOKE_MARKER:${role}`,
    sessions: {
      sessions: [PARENT, CHILD], childSessions: [CHILD], rootSessions: [PARENT],
      routes: [{ sessionId: CHILD, provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort }],
      tools: [
        tool(PARENT, 'call-parent', route.toolName ?? 'ask', true),
        tool(CHILD, 'call-child', 'read', true),
      ],
      finalTexts: [{ sessionId: CHILD, text: `DSH_REAL_SMOKE_MARKER:${role}` }],
      ...sessions,
    },
  })
}

function executor(build: (role: string, route: ResolvedRoleRoute) => RealSmokeEvidence): RealSmokeExecutor {
  return async (role, route) => build(role, route)
}

async function qualify(role: string, execute: RealSmokeExecutor): Promise<{ status: string; checks: Record<string, string>; failureClass: string; reason: string }> {
  const config = await loadHarnessConfig(ROOT, { env: deployment })
  const results = await runRealModelSmokes(config, deployment, execute)
  const result = results.find(candidate => candidate.role === role)
  if (result === undefined) throw new Error(`role ${role} missing`)
  const reason = result.reason ?? '{}'
  return { status: result.status, checks: result.checks as Record<string, string>, failureClass: JSON.parse(reason).failureClass, reason }
}

describe('real model smoke qualification', () => {
  it('extracts the terminal final record from the pinned headless JSONL format', () => {
    expect(extractHeadlessResult([
      { type: 'session_event', event: { type: 'assistant/message' } },
      { type: 'final', text: 'qualified' },
    ])).toBe('qualified')
    expect(extractHeadlessResult([{ type: 'session_event' }])).toBe('')
  })

  it('keeps absent deployment routes NOT_RUN without invoking a process', async () => {
    const config = await loadHarnessConfig(ROOT, { env: {} })
    let calls = 0
    const execute: RealSmokeExecutor = async () => {
      calls += 1
      throw new Error('must not run')
    }
    const results = await runRealModelSmokes(config, {}, execute)
    expect(results.every(result => result.status === 'NOT_RUN')).toBe(true)
    expect(results[0]?.reason).toContain('MAGPIE_API_KEY')
    expect(calls).toBe(0)
  })

  it.each([
    ['api', 'FIXTURE_API'],
    ['apiKeyEnv', 'FIXTURE_KEY_ENV_NAME'],
  ] as const)('keeps an unresolved provider %s NOT_RUN without invoking an executor', async (field, variable) => {
    const loaded = await loadHarnessConfig(ROOT, { env: deployment })
    const providerId = resolveRoleRoute(loaded, 'coordinator').provider
    const config = { ...loaded, providers: {
      ...loaded.providers, [providerId]: { ...loaded.providers[providerId]!, [field]: '${' + variable + '}' },
    } }
    const execute = vi.fn<RealSmokeExecutor>(async () => { throw new Error('must not run') })
    const results = await runRealModelSmokes(config, deployment, execute)
    expect(results.length).toBeGreaterThan(0)
    for (const result of results) {
      expect(result.status).toBe('NOT_RUN')
      expect(result.reason).toContain(variable)
    }
    expect(execute).not.toHaveBeenCalled()
  })

  it('qualifies exact routes, child read, and delegated role tools from durable evidence', async () => {
    const config = await loadHarnessConfig(ROOT, { env: deployment })
    const execute = executor((role, route) => role === 'coordinator'
      ? evidence({
        finalText: `DSH_REAL_SMOKE_MARKER:${role}`,
        sessions: {
          routes: [{ sessionId: PARENT, provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort }],
          tools: [tool(PARENT, 'call-root', 'read', true)],
        },
      })
      : delegated(role, route))
    const results = await runRealModelSmokes(config, deployment, execute)
    expect(results.filter(result => result.qualification === 'role')).toHaveLength(7)
    expect(results.every(result => result.status === 'PASS')).toBe(true)
    for (const role of ['architect', 'reviewer']) {
      expect(results.find(result => result.role === role)).toMatchObject({ provider: 'magpie-responses', model: 'codex/gpt-6.1-sol', reasoningEffort: 'medium' })
    }
    expect(results.find(result => result.role === 'reviewer')?.checks.subagent).toBe('PASS')
    expect(results.find(result => result.role === 'coordinator')?.checks.subagent).toBe('NOT_RUN')
    expect(results.every(result => result.checks.background === 'NOT_RUN')).toBe(true)
  })

  it('qualifies each distinct fallback route and effort independently of the primary role results', async () => {
    const config = await loadHarnessConfig(ROOT, { env: deployment })
    const attempts: Array<{ role: string; routeId: string; model: string; reasoningEffort: string }> = []
    const results = await runRealModelSmokes(config, deployment, executor((role, route) => {
      attempts.push({ role, routeId: route.routeId, model: route.model, reasoningEffort: route.reasoningEffort })
      return role === 'coordinator' ? evidence({
        finalText: `DSH_REAL_SMOKE_MARKER:${role}`,
        sessions: {
          routes: [{ sessionId: PARENT, provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort }],
          tools: [tool(PARENT, 'call-root', 'read', true)],
        },
      }) : delegated(role, route)
    }))
    expect(attempts.filter(attempt => attempt.routeId === 'worker-secondary-fallback')).toEqual([
      { role: 'scout-secondary', routeId: 'worker-secondary-fallback', model: 'trae-cn/glm-5.3-flash', reasoningEffort: 'off' },
    ])
    const routes = results.filter(result => result.qualification === 'route')
    expect(routes.filter(result => result.routeId === 'worker-secondary-fallback')).toHaveLength(1)
    for (const route of routes.filter(result => result.routeId === 'worker-secondary-fallback')) {
      expect(route).toMatchObject({
        provider: 'magpie', model: 'trae-cn/glm-5.3-flash', status: 'PASS',
        checks: {
          'provider-resolves': 'PASS', 'model-resolves': 'PASS', 'reasoning-routed': 'PASS',
          completion: 'PASS', 'tool-use': 'PASS', subagent: 'PASS',
        },
      })
    }
    expect(routes.filter(result => result.routeId === 'worker-secondary')).toHaveLength(1)
    expect(routes.find(result => result.routeId === 'architecture')).toMatchObject({
      model: 'codex/gpt-6.1-sol', status: 'PASS', checks: { subagent: 'NOT_RUN' },
    })
    expect(attempts).toHaveLength(9)
  })

  it.each([
    ['provider', { provider: 'wrong-provider' }, 'provider-resolves'],
    ['model', { model: 'opencode-go/mimo-v2.6-flash' }, 'model-resolves'],
    ['reasoning', { reasoningEffort: 'high' }, 'reasoning-routed'],
  ])('rejects fallback %s evidence without failing qualified primary roles', async (_label, mismatch, check) => {
    const config = await loadHarnessConfig(ROOT, { env: deployment })
    const results = await runRealModelSmokes(config, deployment, executor((role, route) => delegated(role, route,
      route.routeId !== 'worker-secondary-fallback' ? {} : {
        routes: [{ sessionId: CHILD, provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort, ...mismatch }],
      })))
    for (const result of results.filter(result => result.routeId === 'worker-secondary-fallback')) {
      expect(result.status).toBe('FAIL')
      expect(result.checks[check]).toBe('FAIL')
    }
    expect(results.find(result => result.qualification === 'role' && result.role === 'challenger')?.status).toBe('PASS')
  })

  it('keeps unresolved fallback model NOT_RUN while primary roles still qualify', async () => {
    const env = { ...deployment, FIXTURE_FALLBACK_MODEL_ID: undefined }
    const loaded = await loadHarnessConfig(ROOT, { env })
    const config = { ...loaded, routes: { ...loaded.routes, 'worker-secondary-fallback': { ...loaded.routes['worker-secondary-fallback']!, model: '${FIXTURE_FALLBACK_MODEL_ID}' } } }
    const attempts: string[] = []
    const results = await runRealModelSmokes(config, env, executor((role, route) => {
      attempts.push(route.routeId)
      return delegated(role, route)
    }))
    expect(attempts).not.toContain('worker-secondary-fallback')
    for (const result of results.filter(result => result.routeId === 'worker-secondary-fallback')) {
      expect(result.status).toBe('NOT_RUN')
      expect(Object.values(result.checks).every(check => check === 'NOT_RUN')).toBe(true)
      expect(result.reason).toContain('FIXTURE_FALLBACK_MODEL_ID')
    }
    expect(results.find(result => result.qualification === 'role' && result.role === 'challenger')?.status).toBe('PASS')
  })

  it('does not qualify fallback reads or answers from a different model child', async () => {
    const config = await loadHarnessConfig(ROOT, { env: deployment })
    const results = await runRealModelSmokes(config, deployment, executor((role, route) => delegated(role, route,
      route.routeId !== 'worker-secondary-fallback' ? {} : {
        sessions: [PARENT, CHILD, 'primary-child'],
        childSessions: [CHILD, 'primary-child'],
        routes: [
          { sessionId: CHILD, provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort },
          { sessionId: 'primary-child', provider: route.provider, model: 'opencode-go/mimo-v2.6-flash', reasoningEffort: route.reasoningEffort },
        ],
        tools: [tool(PARENT, 'call-parent', route.toolName ?? 'ask', true), tool('primary-child', 'call-read', 'read', true)],
        finalTexts: [{ sessionId: 'primary-child', text: `DSH_REAL_SMOKE_MARKER:${role}` }],
      })))
    for (const result of results.filter(result => result.routeId === 'worker-secondary-fallback')) {
      expect(result).toMatchObject({ status: 'FAIL', checks: { 'model-resolves': 'PASS', 'tool-use': 'FAIL', completion: 'FAIL' } })
      expect(JSON.parse(result.reason ?? '{}').failureClass).toBe('CHILD_READ_NOT_CALLED')
    }
  })

  it.each(['completion', 'tool-use', 'subagent'])('requires fallback %s capability even when the primary passes', async (check) => {
    const config = await loadHarnessConfig(ROOT, { env: deployment })
    const results = await runRealModelSmokes(config, deployment, executor((role, route) => {
      if (route.routeId !== 'worker-secondary-fallback') return delegated(role, route)
      return delegated(role, route, {
        tools: [
          tool(PARENT, 'call-parent', route.toolName ?? 'ask', check !== 'subagent'),
          tool(CHILD, 'call-child', 'read', check !== 'tool-use'),
        ],
      }, check === 'completion' ? { finalText: '' } : {})
    }))
    for (const result of results.filter(result => result.routeId === 'worker-secondary-fallback')) {
      expect(result.status).toBe('FAIL')
      expect(result.checks[check]).toBe('FAIL')
    }
    expect(results.find(result => result.qualification === 'role' && result.role === 'challenger')?.status).toBe('PASS')
  })

  it('qualifies a configured fallback even when its primary model is unresolved', async () => {
    const env = { ...deployment, FIXTURE_PRIMARY_MODEL_ID: undefined }
    const loaded = await loadHarnessConfig(ROOT, { env })
    const config = { ...loaded, routes: { ...loaded.routes, 'worker-secondary': { ...loaded.routes['worker-secondary']!, model: '${FIXTURE_PRIMARY_MODEL_ID}' } } }
    const results = await runRealModelSmokes(config, env, executor((role, route) => delegated(role, route)))
    expect(results.find(result => result.qualification === 'role' && result.role === 'challenger')?.status).toBe('NOT_RUN')
    expect(results.filter(result => result.routeId === 'worker-secondary-fallback').every(result => result.status === 'PASS')).toBe(true)
  })

  it.each(['model', 'reasoning', 'endpoint', 'credentials'])('checks fallback-owned %s deployment values', async (missing) => {
    const config = await loadHarnessConfig(ROOT, { env: deployment })
    const fallback = config.routes['worker-secondary-fallback']!
    const provider = config.providers['magpie']!
    const fallbackConfig = {
      ...config,
      providers: { ...config.providers, 'fallback-provider': {
        ...provider,
        baseURL: missing === 'endpoint' ? '${FALLBACK_URL}' : provider.baseURL,
        apiKeyEnv: 'FALLBACK_KEY',
      } },
      routes: { ...config.routes, 'worker-secondary-fallback': {
        ...fallback,
        provider: 'fallback-provider',
        model: missing === 'model' ? '${FALLBACK_MODEL}' : fallback.model,
        reasoningEfforts: missing === 'reasoning' ? { high: '${FALLBACK_EFFORT}', max: '${FALLBACK_EFFORT}' } : fallback.reasoningEfforts,
      } },
    }
    const env = { ...deployment, FALLBACK_KEY: missing === 'credentials' ? '' : 'test-fallback-key' }
    const attempts: string[] = []
    const results = await runRealModelSmokes(fallbackConfig, env, executor((role, route) => {
      attempts.push(route.routeId)
      return delegated(role, route)
    }))
    expect(attempts).not.toContain('worker-secondary-fallback')
    expect(results.filter(result => result.routeId === 'worker-secondary-fallback').every(result => result.status === 'NOT_RUN')).toBe(true)
    expect(results.find(result => result.qualification === 'role' && result.role === 'challenger')?.status).toBe('PASS')
  })

  it('uses the newly configured architecture model for both architect and reviewer qualification', async () => {
    const env = deployment
    const loaded = await loadHarnessConfig(ROOT, { env })
    const config = { ...loaded, routes: { ...loaded.routes, 'architecture': { ...loaded.routes['architecture']!, model: 'architecture-model-B' } } }
    const results = await runRealModelSmokes(config, env, executor((role, route) => delegated(role, route)))
    for (const role of ['architect', 'reviewer']) {
      expect(results.find(result => result.qualification === 'role' && result.role === role)).toMatchObject({
        provider: 'magpie-responses', model: 'architecture-model-B', status: 'PASS',
      })
    }
  })

  it.each(['challenger', 'implementer'])('pins the exact %s candidate in the temporary headless overlay', async (role) => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    vi.mocked(spawn).mockImplementationOnce((_command, args, options) => actual.spawn(process.execPath, [
      '--input-type=module', '-e', [
        'import { readFile } from "node:fs/promises";',
        'const args = JSON.parse(process.argv[1]);',
        'const patch = await readFile(args[args.lastIndexOf("--patch") + 1], "utf8");',
        'console.log(JSON.stringify({ type: "final", text: patch }));',
      ].join('\n'),
      JSON.stringify(args),
    ], options))
    const base = await loadHarnessConfig(ROOT, { env: deployment })
    const selected = role === 'challenger' ? 'worker-secondary-fallback' : base.roles[role]!.route
    const config = {
      ...base,
      providers: { ...base.providers, 'fixture-relay': {
        api: 'openai-responses', baseURL: 'https://selected-relay.invalid/v1', apiKeyEnv: 'FIXTURE_SELECTED_KEY',
      } },
      routes: { ...base.routes, [selected]: { ...base.routes[selected]!, provider: 'fixture-relay' } },
    }
    const coordinator = resolveRoleRoute(config, 'coordinator')
    const route = role === 'challenger'
      ? resolveRoleFallbackRoutes(config, role)[0]!
      : resolveRoleRoute(config, role)
    const result = await createPinnedHeadlessExecutor(ROOT, deployment, 240000, config)(role, route, coordinator)
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    const schema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar' })])
    const pinned: unknown = load(await readFile(join(ROOT, 'tools/agent/profiles/frozen-engineering.patch.yml'), 'utf8'), { schema })
    if (!Array.isArray(pinned)) throw new Error('pinned patch list missing')
    const patches: Array<{ insert?: Array<{ id: string; config: object }> }> = pinned
    const id = `role-${role === 'implementer' ? `implementer-${process.platform === 'win32' ? 'windows' : 'posix'}` : role}`
    const sourceConfig = patches.flatMap(patch => patch.insert ?? []).find(entry => entry.id === id)?.config
    if (sourceConfig === undefined) throw new Error('pinned role config missing')
    const projected = load(result.finalText, { schema }) as Array<{ id: string; config: { providers?: Record<string, { baseURL?: string; api?: string; apiKeyEnv?: string }> } }>
    expect(projected.find(patch => patch.id === 'llm-pi-ai')?.config.providers?.['fixture-relay']).toMatchObject({
      api: 'openai-responses', baseURL: 'https://selected-relay.invalid/v1', apiKeyEnv: 'FIXTURE_SELECTED_KEY',
    })
    expect(load(result.finalText, { schema })).toEqual([
      { id: 'agent-default-model', config: {
        provider: coordinator.provider, model: coordinator.model, reasoningEffort: coordinator.reasoningEffort,
      } },
      { id, config: {
        ...sourceConfig,
        agentOptions: { provider: route.provider, model: route.model, ...route.reasoningEffort === 'off' ? {} : { reasoningEffort: route.reasoningEffort }, maxTokens: route.maxTokens },
      } },
      { id: 'llm-pi-ai', config: { providers: providerOptions({ ...config, roles: Object.fromEntries(Object.entries(config.roles).map(([id, settings]) => [id, { ...settings, enabled: id === 'coordinator' || id === role, route: id === role ? route.routeId : settings.route, fallbackRoutes: [] }])) }) } },
      { id: 'session-persistence-jsonl', config: {
        root: 'process.env.DSH_SMOKE_SESSION_ROOT', compression: 'none',
      } },
    ])
  })

  it('qualifies an omitted effort for a model without reasoning controls', async () => {
    const config = await loadHarnessConfig(ROOT, { env: deployment })
    const route = resolveRoleRoute(config, 'challenger')
    const result = evaluateRole('challenger', route, delegated('challenger', route, {
      routes: [{ sessionId: CHILD, provider: route.provider, model: route.model }],
    }))
    expect(result.failure).toBeUndefined()
    expect(result.checks['reasoning-routed']).toBe('PASS')
  })

  it('fails tool-use when the child was dispatched but never read', async () => {
    const { status, checks, failureClass } = await qualify('challenger', executor((role, route) => delegated(role, route, {
      tools: [tool(PARENT, 'call-parent', route.toolName ?? 'ask', true)],
    })))
    expect(status).toBe('FAIL')
    expect(checks['tool-use']).toBe('FAIL')
    expect(checks.subagent).toBe('PASS')
    expect(failureClass).toBe('CHILD_READ_NOT_CALLED')
  })

  it('fails completion when the child fabricated the marker', async () => {
    const { status, checks, failureClass } = await qualify('challenger', executor((role, route) => delegated(role, route, {}, {
      finalText: 'DSH-2026-03-09T14:27:55Z-P9K4-MARKER-OK',
    })))
    expect(status).toBe('FAIL')
    expect(checks.completion).toBe('FAIL')
    expect(checks['tool-use']).toBe('PASS')
    expect(failureClass).toBe('FINAL_MARKER_MISMATCH')
  })

  it('fails tool-use when the child read result is an error', async () => {
    const { status, checks, failureClass } = await qualify('challenger', executor((role, route) => delegated(role, route, {
      tools: [
        tool(PARENT, 'call-parent', route.toolName ?? 'ask', true),
        tool(CHILD, 'call-child', 'read', false),
      ],
    })))
    expect(status).toBe('FAIL')
    expect(checks['tool-use']).toBe('FAIL')
    expect(failureClass).toBe('CHILD_READ_FAILED')
  })

  it('fails completion when the parent final differs from the child marker read', async () => {
    const { status, checks, failureClass } = await qualify('challenger', executor((role, route) => delegated(role, route, {}, {
      finalText: 'DSH_REAL_SMOKE_MARKER:scout-secondary',
    })))
    expect(status).toBe('FAIL')
    expect(checks['tool-use']).toBe('PASS')
    expect(failureClass).toBe('FINAL_MARKER_MISMATCH')
  })

  it('fails provider-resolves when only the model matches', async () => {
    const { status, checks } = await qualify('challenger', executor((role, route) => delegated(role, route, {
      routes: [{ sessionId: CHILD, provider: 'other-gateway', model: route.model, reasoningEffort: route.reasoningEffort }],
    })))
    expect(status).toBe('FAIL')
    expect(checks['provider-resolves']).toBe('FAIL')
  })

  it('fails completion when only the parent echoes the marker and the child never answered it', async () => {
    const { status, checks, failureClass } = await qualify('challenger', executor((role, route) => delegated(role, route, {
      finalTexts: [{ sessionId: CHILD, text: 'I could not read the file.' }],
    })))
    expect(status).toBe('FAIL')
    expect(checks['tool-use']).toBe('PASS')
    expect(checks.completion).toBe('FAIL')
    expect(failureClass).toBe('FINAL_MARKER_MISMATCH')
  })

  it('fails a route when durable evidence reports another provider or model', async () => {
    const { status, checks, failureClass } = await qualify('challenger', executor((role, route) => delegated(role, route, {
      routes: [{ sessionId: CHILD, provider: 'anthropic', model: 'claude-opus-5.5', reasoningEffort: route.reasoningEffort }],
    })))
    expect(status).toBe('FAIL')
    expect(checks['route-diagnostic']).toBe('FAIL')
    expect(failureClass).toBe('ROUTE_MISMATCH')
  })

  it('fails a route whose child requested another reasoning effort', async () => {
    const { status, checks, failureClass } = await qualify('challenger', executor((role, route) => delegated(role, route, {
      routes: [{ sessionId: CHILD, provider: route.provider, model: route.model, reasoningEffort: 'high' }],
    })))
    expect(status).toBe('FAIL')
    expect(checks['reasoning-routed']).toBe('FAIL')
    expect(failureClass).toBe('REASONING_ROUTE_MISMATCH')
  })

  it('fails a timed-out run', async () => {
    const { status, checks, failureClass } = await qualify('challenger', executor((role, route) => delegated(role, route, {}, {
      exitCode: null, timedOut: true,
    })))
    expect(status).toBe('FAIL')
    expect(checks['bounded-cancellation']).toBe('FAIL')
    expect(failureClass).toBe('TIMEOUT')
  })

  it('does not let a parent read substitute for the child read', async () => {
    const { status, checks, failureClass } = await qualify('challenger', executor((role, route) => delegated(role, route, {
      tools: [
        tool(PARENT, 'call-parent', route.toolName ?? 'ask', true),
        tool(PARENT, 'call-parent-read', 'read', true),
      ],
    })))
    expect(status).toBe('FAIL')
    expect(checks['tool-use']).toBe('FAIL')
    expect(failureClass).toBe('CHILD_READ_NOT_CALLED')
  })

  it('does not let an unrelated session read satisfy the child tool-use check', async () => {
    const { status, checks } = await qualify('challenger', executor((role, route) => delegated(role, route, {
      tools: [
        tool(PARENT, 'call-parent', route.toolName ?? 'ask', true),
        tool('session-unrelated', 'call-other', 'read', true),
      ],
    })))
    expect(status).toBe('FAIL')
    expect(checks['tool-use']).toBe('FAIL')
  })

  it('does not let a callId collision in another session mark the child read successful', async () => {
    const logs = [
      {
        sessionId: CHILD,
        header: { type: 'session', id: CHILD },
        events: [
          { type: 'tool/call', data: { callId: 'call-shared', name: 'read' } },
          { type: 'tool/result', data: { message: { toolCallId: 'call-shared', isError: true } } },
        ],
      },
      {
        sessionId: 'session-unrelated',
        header: { type: 'session', id: 'session-unrelated' },
        events: [
          { type: 'tool/call', data: { callId: 'call-shared', name: 'read' } },
          { type: 'tool/result', data: { message: { toolCallId: 'call-shared', isError: false } } },
        ],
      },
    ]
    const correlated = correlateSessionEvidence(logs)
    expect(correlated.tools).toContainEqual(tool(CHILD, 'call-shared', 'read', false))
    expect(correlated.tools).toContainEqual(tool('session-unrelated', 'call-shared', 'read', true))
    expect(correlated.childSessions).toEqual([])

    const { status, checks, failureClass } = await qualify('challenger', executor((role, route) => delegated(role, route, {
      tools: [
        tool(PARENT, 'call-parent', route.toolName ?? 'ask', true),
        ...correlated.tools.filter(candidate => candidate.sessionId === CHILD),
      ],
    })))
    expect(status).toBe('FAIL')
    expect(checks['tool-use']).toBe('FAIL')
    expect(failureClass).toBe('CHILD_READ_FAILED')
  })

  it('splits parent and delegated child sessions from the durable header', () => {
    const correlated = correlateSessionEvidence([
      { sessionId: PARENT, header: { type: 'session', id: PARENT }, events: [] },
      { sessionId: CHILD, header: { type: 'session', id: CHILD, parentSession: PARENT }, events: [] },
      { sessionId: 'session-orphan', header: { type: 'session', id: 'session-orphan', parentSession: 'session-absent' }, events: [] },
    ])
    expect(correlated.childSessions).toEqual([CHILD])
    expect(correlated.rootSessions).toEqual([PARENT, 'session-orphan'])
  })

  it('projects only recognized failure codes and valid statuses from durable errors', async () => {
    const correlated = correlateSessionEvidence([
      {
        sessionId: PARENT,
        header: { type: 'session', id: PARENT },
        events: [
          { type: 'llm/retry', data: { failure: { code: 'RATE_LIMIT', status: 429, message: 'private provider message', requestId: 'private-request-id' } } },
          { type: 'llm/retry', data: { failure: { code: 'private-provider-code', status: 700, message: 'private retry message', requestId: 'private-retry-id' } } },
        ],
      },
      {
        sessionId: CHILD,
        header: { type: 'session', id: CHILD, parentSession: PARENT },
        events: [
          { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'SERVER', status: 503, message: 'private turn message', requestId: 'private-turn-id' } } } },
          { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { code: 'private-turn-code', status: -1, message: 'private unknown message', requestId: 'private-unknown-id' } } } },
        ],
      },
    ])

    expect(correlated.failures).toEqual([
      { sessionId: PARENT, source: 'llm/retry', code: 'RATE_LIMIT', status: 429 },
      { sessionId: PARENT, source: 'llm/retry', code: 'UNKNOWN' },
      { sessionId: CHILD, source: 'turn/end', code: 'SERVER', status: 503 },
      { sessionId: CHILD, source: 'turn/end', code: 'UNKNOWN' },
    ])
    expect(JSON.stringify(correlated.failures)).not.toMatch(/private-provider-code|private-turn-code|private .*message|private-.*-id/u)

    const { failureClass, reason } = await qualify('challenger', executor((role, route) => delegated(role, route, {
      failures: correlated.failures,
    }, { exitCode: 1 })))
    expect(failureClass).toBe('PROCESS_EXIT_FAILURE')
    expect(JSON.parse(reason).failures).toEqual(correlated.failures)
    expect(reason).not.toMatch(/private-provider-code|private-turn-code|private .*message|private-.*-id/u)
  })

  it('keeps only the last 16 extracted Session failure records in a failed route summary', async () => {
    const failures = Array.from({ length: 20 }, (_, index) => ({
      sessionId: `session-${index}`,
      source: 'llm/retry' as const,
      code: 'SERVER',
      status: 500,
    }))
    const { reason, failureClass } = await qualify('challenger', executor((role, route) => delegated(role, route, { failures }, { exitCode: 1 })))
    const summary = JSON.parse(reason) as { failures: unknown[] }

    expect(failureClass).toBe('PROCESS_EXIT_FAILURE')
    expect(summary.failures).toHaveLength(16)
    expect(summary.failures[0]).toEqual({ sessionId: 'session-4', source: 'llm/retry', code: 'SERVER', status: 500 })
    expect(summary.failures.at(-1)).toEqual({ sessionId: 'session-19', source: 'llm/retry', code: 'SERVER', status: 500 })
  })

  it('reports PROCESS_EXIT_FAILURE rather than a marker mismatch for a nonzero exit', async () => {
    const { failureClass, reason } = await qualify('challenger', executor((role, route) => delegated(role, route, {}, { exitCode: 1 })))
    expect(failureClass).toBe('PROCESS_EXIT_FAILURE')
    expect(JSON.parse(reason)).toMatchObject({ exitCode: 1, timedOut: false })
  })

  it('reports SUBAGENT_FAILED when the dispatched role tool errored', async () => {
    const { failureClass, checks } = await qualify('challenger', executor((role, route) => delegated(role, route, {
      tools: [
        tool(PARENT, 'call-parent', route.toolName ?? 'ask', false),
        tool(CHILD, 'call-child', 'read', true),
      ],
    })))
    expect(failureClass).toBe('SUBAGENT_FAILED')
    expect(checks.subagent).toBe('FAIL')
  })

  it('rejects stale Claude evidence for architecture and review', async () => {
    const config = await loadHarnessConfig(ROOT, { env: deployment })
    const execute = executor((role, route) => delegated(role, route, {
      routes: [{ sessionId: CHILD, provider: 'anthropic', model: 'claude-opus-5.5', reasoningEffort: 'high' }],
    }))
    const results = await runRealModelSmokes(config, deployment, execute)
    for (const role of ['architect', 'reviewer']) {
      expect(results.find(result => result.role === role)).toMatchObject({
        status: 'FAIL', checks: { 'route-diagnostic': 'FAIL' },
      })
    }
  })
})

describe('test-only real fallback diagnostic', () => {
  it.skipIf(!realFallbackEnabled)('completes a real fallback role after one injected primary failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-real-fallback-'))
    const controller = new AbortController()
    try {
      await cp(join(ROOT, '.agent'), join(root, '.agent'), {
        recursive: true, filter: source => !source.includes(join('.agent', 'tasks')),
      })
      await writeFile(join(root, '.agent/config/project.yaml'), dump({
        schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/diagnostic.yaml',
        dataClass: 'public', maxSteps: 10, maxRoleCalls: 10, commandTimeoutMs: 30000,
      }))
      await writeFile(join(root, '.agent/adapters/diagnostic.yaml'), dump({
        adapters: Object.fromEntries(['typecheck', 'unit', 'build'].map(name => [name, {
          executable: process.execPath, args: ['-e', 'process.exit(0)'],
        }])),
      }))
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
      const git = async (args: string[]): Promise<void> => {
        await new Promise<void>((resolveGit, rejectGit) => {
          const child = actual.spawn('git', args, { cwd: root, stdio: 'ignore', windowsHide: true })
          child.once('error', rejectGit)
          child.once('close', code => code === 0 ? resolveGit() : rejectGit(new Error('diagnostic Git setup failed')))
        })
      }
      await git(['init'])
      await git(['-c', 'user.name=Diagnostic', '-c', 'user.email=diagnostic@example.invalid', 'commit', '--allow-empty', '-m', 'diagnostic'])
      const config = await loadHarnessConfig(root, { env: process.env })
      const coordinator = resolveRoleRoute(config, 'coordinator')
      const execute = createPinnedHeadlessExecutor(ROOT, process.env, 240000, config)
      const attempts: string[] = []
      let liveChecks: Readonly<Record<string, string>> | undefined
      const investigation = { findings: ['Bounded route diagnostic'], hypotheses: [], unresolvedAssumptions: [] }
      const result = await runEngineeringTask({
        root, deployment: config, request: 'Qualify the configured read-only scout fallback', signal: controller.signal,
        executeRole: async ({ role, route }) => {
          if (role === 'scout-primary') return investigation
          if (role !== 'scout-secondary') throw new EngineeringRoleFailure('Diagnostic stops after the scout fallback completes')
          attempts.push(route.routeId)
          if (attempts.length === 1) throw new RoleInvocationError('test-only injected primary failure', 'PROVIDER_REQUEST_FAILURE', true)
          const live = await execute(role, route, coordinator)
          liveChecks = evaluateRole(role, route, live).checks
          expect(liveChecks).toMatchObject({
            'provider-resolves': 'PASS', 'model-resolves': 'PASS', 'reasoning-routed': 'PASS',
            completion: 'PASS', 'tool-use': 'PASS', subagent: 'PASS',
          })
          return { ...investigation, findings: [live.finalText] }
        },
      })
      expect(attempts).toEqual(['worker-secondary', 'worker-secondary-fallback'])
      expect(liveChecks).toMatchObject({ completion: 'PASS', 'tool-use': 'PASS', subagent: 'PASS' })
      const records = (await readFile(join(root, '.agent/tasks', result.taskId, 'ROUTE_ATTEMPTS.scout-secondary.jsonl'), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line) as { routeId: string; outcome: string; failureClass?: string })
      expect(records.map(record => ({ routeId: record.routeId, outcome: record.outcome }))).toEqual([
        { routeId: 'worker-secondary', outcome: 'FAILED' }, { routeId: 'worker-secondary-fallback', outcome: 'SUCCESS' },
      ])
      expect(records[0]?.failureClass).toBe('PROVIDER_REQUEST_FAILURE')
      expect(result).toMatchObject({ status: 'BLOCKED', summary: 'Diagnostic stops after the scout fallback completes' })
    } finally {
      controller.abort()
      await rm(root, { recursive: true, force: true })
    }
  }, 300000)
})
