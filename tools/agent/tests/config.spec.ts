import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { DEFAULT_SCHEMA, dump, load, Type } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { providerOptions } from '../runtime/bootstrap.ts'
import { assertDispatchAllowed, assertRouteDispatchAllowed, loadHarnessConfig, resolveRoleAttempts, resolveRoleRoute } from '../src/config.ts'

const ROOT = resolve(import.meta.dirname, '../../..')

describe('harness configuration', () => {
  it.each([
    ['fallbackRoutes:\n      - worker-fallback\n      - worker-secondary-fallback\n      - worker-secondary', 'at most two fallback'],
    ['fallbackRoutes:\n      - worker', 'must differ from its primary'],
    ['fallbackRoutes:\n      - worker-fallback\n      - worker-fallback', 'must use distinct providers or models'],
  ])('rejects an unbounded or self-repeating candidate list: %s', async (declaration, message) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-config-'))
    try {
      await cp(join(ROOT, '.agent/config'), join(root, '.agent/config'), { recursive: true })
      const filename = join(root, '.agent/config/roles.yaml')
      await writeFile(filename, (await readFile(filename, 'utf8')).replace('fallbackRoutes:\n      - worker-fallback', declaration))
      await expect(loadHarnessConfig(root, { env: {} })).rejects.toThrow(message)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects two route names resolving to the same provider and model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-config-'))
    try {
      await cp(join(ROOT, '.agent/config'), join(root, '.agent/config'), { recursive: true })
      const filename = join(root, '.agent/config/models.yaml')
      const models = load(await readFile(filename, 'utf8')) as { routes: Record<string, { model: string; reasoningEfforts: Record<string, string | null> }> }
      const primary = models.routes.worker!
      models.routes['worker-fallback'] = { ...models.routes['worker-fallback']!, model: primary.model, reasoningEfforts: primary.reasoningEfforts }
      await writeFile(filename, dump(models))
      await expect(loadHarnessConfig(root, { env: {} })).rejects.toThrow('not an alias of the primary route')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('rejects distinct fallback route names that resolve to one provider and model', async () => {
    await expect(loadHarnessConfig(ROOT, { env: {
      DSH_WORKER_FALLBACK_MODEL_ID: 'same-fallback-model',
      DSH_SECONDARY_WORKER_FALLBACK_MODEL_ID: 'same-fallback-model',
    } })).rejects.toThrow('fallback routes must use distinct providers or models')
  })

  it('resolves every enabled role through a fixed supported route', async () => {
    const config = await loadHarnessConfig(ROOT, { env: {} })
    expect(config.runtimeTag).toBe('dsh-v0.2.1-alpha.1')
    expect(config.workflow).toMatchObject({ maxDepth: 1, maxConcurrentAgents: 3, arbiterEnabled: false })
    expect(Object.keys(config.roles).filter(role => config.roles[role]?.enabled)).toEqual([
      'coordinator', 'architect', 'scout-primary', 'scout-secondary', 'implementer', 'challenger', 'reviewer',
    ])
    expect(resolveRoleRoute(config, 'implementer')).toMatchObject({
      toolName: 'run_implementer', provider: 'magpie', model: 'group/auto-deepseek-v4-1-flash', reasoningEffort: 'max', writable: true,
    })
    expect(() => resolveRoleRoute(config, 'arbiter')).toThrow('disabled')
    expect(config.routes.arbiter).toMatchObject({ provider: 'magpie-responses', model: 'codex/gpt-6.1-sol' })
  })

  it('resolves the Magpie protocol from its deployment environment', async () => {
    const config = await loadHarnessConfig(ROOT, { env: { DSH_MAGPIE_API: 'openai-responses' } })
    expect(config.providers.magpie?.api).toBe('openai-responses')
    expect(resolveRoleRoute(config, 'scout-secondary')).toMatchObject({ provider: 'magpie', model: 'opencode-go/mimo-v2.6-flash' })
  })

  it.each(['${DSH_MAGPIE_API:-openai-completions}', 'openai-responses'])('resolves a preserved magpie deployment with api %s', async api => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-stale-protocol-'))
    try {
      await cp(join(ROOT, '.agent/config'), join(root, '.agent/config'), { recursive: true })
      const filename = join(root, '.agent/config/models.yaml')
      await writeFile(filename, (await readFile(filename, 'utf8')).replace('api: ${DSH_MAGPIE_API:-openai-completions}', `api: ${api}`))
      const config = await loadHarnessConfig(root, { env: {
        DSH_MAGPIE_API: 'openai-responses', DSH_MAGPIE_RESPONSES_API: 'openai-completions',
        DSH_MAGPIE_GATEWAY_URL: 'https://fixture.invalid/v1',
      }, requireDeployment: true })
      expect(config.providers.magpie?.api).toBe('openai-responses')
      expect(config.providers['magpie-responses']?.api).toBe('openai-completions')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps deployment endpoints required and model defaults available offline', async () => {
    const config = await loadHarnessConfig(ROOT, { env: {} })
    expect(config.providers.magpie).toMatchObject({ baseURL: '${DSH_MAGPIE_GATEWAY_URL}', apiKeyEnv: 'MAGPIE_API_KEY' })
    expect(config.routes.worker?.reasoningEfforts).toMatchObject({ medium: 'low', high: 'high', max: 'max' })
    await expect(loadHarnessConfig(ROOT, { env: {}, requireDeployment: true })).rejects.toThrow('DSH_MAGPIE_GATEWAY_URL')
  })

  it('rejects a secret supplied as the credential environment variable name without disclosing it', async () => {
    const secret = 'sk-fixture-secret-never-print'
    const failure = loadHarnessConfig(ROOT, { env: { DSH_MAGPIE_API_KEY_ENV: secret } })
    await expect(failure).rejects.toThrow('models.providers.magpie.apiKeyEnv must name an environment variable, e.g. MAGPIE_API_KEY')
    await expect(failure).rejects.not.toThrow(secret)
  })

  it('rejects a literal secret as the credential environment variable name without disclosing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-config-'))
    const secret = 'sk-fixture-literal-secret-never-print'
    try {
      await cp(join(ROOT, '.agent/config'), join(root, '.agent/config'), { recursive: true })
      const filename = join(root, '.agent/config/models.yaml')
      await writeFile(filename, (await readFile(filename, 'utf8')).replace('${DSH_MAGPIE_API_KEY_ENV:-MAGPIE_API_KEY}', secret))
      const failure = loadHarnessConfig(root, { env: {} })
      await expect(failure).rejects.toThrow('models.providers.magpie.apiKeyEnv must name an environment variable, e.g. MAGPIE_API_KEY')
      await expect(failure).rejects.not.toThrow(secret)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves an unresolved credential name placeholder offline and requires it for deployment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-config-'))
    try {
      await cp(join(ROOT, '.agent/config'), join(root, '.agent/config'), { recursive: true })
      const filename = join(root, '.agent/config/models.yaml')
      await writeFile(filename, (await readFile(filename, 'utf8')).replace('${DSH_MAGPIE_API_KEY_ENV:-MAGPIE_API_KEY}', '${FIXTURE_API_KEY_ENV}'))
      const env = { DSH_MAGPIE_GATEWAY_URL: 'https://fixture.invalid/v1' }
      const config = await loadHarnessConfig(root, { env })
      expect(config.providers.magpie?.apiKeyEnv).toBe('${FIXTURE_API_KEY_ENV}')
      await expect(loadHarnessConfig(root, { env, requireDeployment: true })).rejects.toThrow('models.providers.magpie.apiKeyEnv requires environment variable FIXTURE_API_KEY_ENV')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['A', 'B'])('switches deployment %s through environment values', async suffix => {
    const env = {
      DSH_MAGPIE_GATEWAY_URL: `https://gateway-${suffix}.invalid/v1`,
      DSH_MAGPIE_API: 'openai-responses', DSH_MAGPIE_RESPONSES_API: 'openai-completions',
      DSH_MAGPIE_API_KEY_ENV: `FIXTURE_${suffix}_API_KEY`,
      DSH_WORKER_PROVIDER: 'magpie-responses', DSH_WORKER_MODEL_ID: `worker-${suffix}`,
      DSH_SECONDARY_WORKER_PROVIDER: 'magpie-responses', DSH_SECONDARY_WORKER_MODEL_ID: `secondary-${suffix}`,
      DSH_WORKER_FALLBACK_PROVIDER: 'magpie-responses', DSH_WORKER_FALLBACK_MODEL_ID: `fallback-${suffix}`,
      DSH_SECONDARY_WORKER_FALLBACK_PROVIDER: 'magpie-responses', DSH_SECONDARY_WORKER_FALLBACK_MODEL_ID: `secondary-fallback-${suffix}`,
      DSH_ARCHITECT_PROVIDER: 'magpie', DSH_ARCHITECT_MODEL_ID: `architect-${suffix}`,
      DSH_ARBITER_PROVIDER: 'magpie', DSH_ARBITER_MODEL_ID: `arbiter-${suffix}`,
      DSH_ARCHITECT_REASONING_EFFORT: 'high', DSH_REVIEWER_REASONING_EFFORT: 'high', DSH_ARBITER_REASONING_EFFORT: 'high',
    }
    const config = await loadHarnessConfig(ROOT, { env, requireDeployment: true })
    expect(config.providers.magpie).toMatchObject({ api: 'openai-responses', baseURL: env.DSH_MAGPIE_GATEWAY_URL, apiKeyEnv: env.DSH_MAGPIE_API_KEY_ENV })
    expect(config.providers['magpie-responses']?.api).toBe('openai-completions')
    for (const [route, model] of [['worker', 'worker'], ['worker-secondary', 'secondary'], ['worker-fallback', 'fallback'], ['worker-secondary-fallback', 'secondary-fallback']]) {
      expect(config.routes[route!]).toMatchObject({ provider: 'magpie-responses', model: `${model}-${suffix}` })
    }
    for (const role of ['coordinator', 'architect', 'reviewer']) {
      expect(resolveRoleRoute(config, role)).toMatchObject({ provider: 'magpie', model: `architect-${suffix}`, reasoningEffort: 'high' })
    }
    expect(config.routes.arbiter).toMatchObject({ provider: 'magpie', model: `arbiter-${suffix}` })
    expect(config.roles.arbiter?.reasoningEffort).toBe('high')
  })

  it('resolves a company gateway fallback with its exact deployment model ID', async () => {
    const env = {
      DSH_MAGPIE_GATEWAY_URL: 'https://magpie.invalid/v1',
      DSH_COMPANY_GATEWAY_URL: 'https://company.invalid/v1',
      DSH_COMPANY_GATEWAY_API_KEY: 'fixture-company-key',
      DSH_WORKER_FALLBACK_PROVIDER: 'company',
      DSH_WORKER_FALLBACK_MODEL_ID: 'Qwen3.8-Flash',
    }
    const config = await loadHarnessConfig(ROOT, { env, requireDeployment: true })
    expect(config.providers.company).toEqual({
      api: 'openai-completions', baseURL: env.DSH_COMPANY_GATEWAY_URL, apiKeyEnv: 'DSH_COMPANY_GATEWAY_API_KEY',
    })
    expect(resolveRoleAttempts(config, 'implementer')[1]).toMatchObject({
      provider: 'company', model: 'Qwen3.8-Flash', reasoningEffort: 'off',
    })
    expect(providerOptions(config).company).toMatchObject({
      api: 'openai-completions', baseURL: env.DSH_COMPANY_GATEWAY_URL,
      apiKeyEnv: 'DSH_COMPANY_GATEWAY_API_KEY', models: [{ id: 'Qwen3.8-Flash', reasoningEfforts: false }],
    })
    const responses = await loadHarnessConfig(ROOT, { env: { ...env, DSH_COMPANY_API: 'openai-responses' } })
    expect(responses.providers.company?.api).toBe('openai-responses')
  })

  it('requires the company endpoint only when a route selects company', async () => {
    const env = { DSH_MAGPIE_GATEWAY_URL: 'https://magpie.invalid/v1' }
    const unselected = await loadHarnessConfig(ROOT, { env, requireDeployment: true })
    expect(unselected.providers.company?.baseURL).toBe('${DSH_COMPANY_GATEWAY_URL}')
    expect(providerOptions(unselected).company).toBeUndefined()
    const selectedEnv = { ...env, DSH_WORKER_FALLBACK_PROVIDER: 'company' }
    await expect(loadHarnessConfig(ROOT, { env: selectedEnv, requireDeployment: true })).rejects.toThrow('DSH_COMPANY_GATEWAY_URL')
    const unresolved = await loadHarnessConfig(ROOT, { env: selectedEnv })
    expect(() => providerOptions(unresolved)).toThrow('Engineering deployment route company has unresolved environment variables')
  })

  it('projects company environment routing into the frozen profile provider registration', async () => {
    const schema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar' })])
    const entries = load(await readFile(join(ROOT, 'tools/agent/profiles/frozen-engineering.patch.yml'), 'utf8'), { schema }) as Array<{ id?: string; config?: { providers?: string } }>
    const expression = entries.find(entry => entry.id === 'llm-pi-ai')?.config?.providers
    if (expression === undefined) throw new Error('provider expression missing')
    const providers = runInNewContext(expression, { process: { env: {
      DSH_COMPANY_GATEWAY_URL: 'https://company.invalid/v1', DSH_COMPANY_API: 'openai-responses',
      DSH_WORKER_FALLBACK_PROVIDER: 'company', DSH_WORKER_FALLBACK_MODEL_ID: 'Qwen3.8-Flash',
    } } }) as Record<string, { api: string; baseURL: string; apiKeyEnv: string; models: Array<{ id: string }> }>
    expect(providers.company).toMatchObject({
      api: 'openai-responses', baseURL: 'https://company.invalid/v1', apiKeyEnv: 'DSH_COMPANY_GATEWAY_API_KEY',
      models: [{ id: 'Qwen3.8-Flash', reasoningEfforts: false, maxTokens: 32000 }],
    })
    expect(providers.magpie?.api).toBe('openai-completions')
    expect(providers.magpie?.models.some(model => model.id === 'Qwen3.8-Flash')).toBe(false)
  })

  it('selects an additional declared provider through an environment override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-provider-'))
    try {
      await cp(join(ROOT, '.agent/config'), join(root, '.agent/config'), { recursive: true })
      const filename = join(root, '.agent/config/models.yaml')
      await writeFile(filename, (await readFile(filename, 'utf8')).replace('providers:\n', 'providers:\n  fixture-relay:\n    api: openai-responses\n    baseURL: https://fixture.invalid/v1\n    apiKeyEnv: FIXTURE_RELAY_API_KEY\n'))
      const config = await loadHarnessConfig(root, { env: { DSH_ARCHITECT_PROVIDER: 'fixture-relay' } })
      expect(resolveRoleRoute(config, 'architect')).toMatchObject({ provider: 'fixture-relay', model: 'codex/gpt-6.1-sol' })
      expect(config.providers['fixture-relay']).toEqual({ api: 'openai-responses', baseURL: 'https://fixture.invalid/v1', apiKeyEnv: 'FIXTURE_RELAY_API_KEY' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects conflicting reasoning mappings for one provider model', async () => {
    await expect(loadHarnessConfig(ROOT, { env: {
      DSH_ARCHITECT_PROVIDER: 'magpie', DSH_ARCHITECT_MODEL_ID: 'group/auto-deepseek-v4-1-flash',
    } })).rejects.toThrow(/reasoning.*(conflict|incompatib)|(?:conflict|incompatib).*reasoning/i)
  })

  it('compares shared model reasoning mappings without depending on YAML key order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-shared-model-'))
    try {
      await cp(join(ROOT, '.agent/config'), join(root, '.agent/config'), { recursive: true })
      const filename = join(root, '.agent/config/models.yaml')
      const source = await readFile(filename, 'utf8')
      const arbiterOffset = source.indexOf('  arbiter:')
      const reordered = source.slice(0, arbiterOffset) + source.slice(arbiterOffset).replace('      medium: medium\n      high: high', '      high: high\n      medium: medium')
      await writeFile(filename, reordered)
      await expect(loadHarnessConfig(root, { env: {} })).resolves.toMatchObject({
        routes: { architecture: { model: 'codex/gpt-6.1-sol' }, arbiter: { model: 'codex/gpt-6.1-sol' } },
      })
      await writeFile(filename, reordered.slice(0, arbiterOffset) + reordered.slice(arbiterOffset).replace('      medium: medium', '      medium: null'))
      await expect(loadHarnessConfig(root, { env: {} })).rejects.toThrow('conflicting reasoningEfforts')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('registers shared architecture models once and rejects static overlay reasoning conflicts', async () => {
    const schema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar' })])
    const entries = load(await readFile(join(ROOT, 'tools/agent/profiles/frozen-engineering.patch.yml'), 'utf8'), { schema }) as Array<{ id?: string; config?: { providers?: string } }>
    const expression = entries.find(entry => entry.id === 'llm-pi-ai')?.config?.providers
    if (expression === undefined) throw new Error('provider expression missing')
    const providers = runInNewContext(expression, { process: { env: {} } }) as Record<string, { api: string; models: Array<{ id: string; reasoningEfforts: object }> }>
    const overridden = runInNewContext(expression, { process: { env: { DSH_MAGPIE_API: 'openai-responses' } } }) as typeof providers
    expect(overridden.magpie?.api).toBe('openai-responses')
    expect(providers['magpie-responses']?.models).toEqual([
      { id: 'codex/gpt-6.1-sol', reasoningEfforts: { off: null, medium: 'medium', high: 'high' }, maxTokens: 32768 },
    ])
    expect(() => runInNewContext(expression, { process: { env: {
      DSH_ARCHITECT_PROVIDER: 'magpie', DSH_ARCHITECT_MODEL_ID: 'group/auto-deepseek-v4-1-flash',
    } } })).toThrow(/reasoning.*(conflict|incompatib)|(?:conflict|incompatib).*reasoning/i)
  })

  it('uses defaults for empty environment overrides', async () => {
    const config = await loadHarnessConfig(ROOT, { env: { DSH_ARCHITECT_MODEL_ID: '', DSH_WORKER_PROVIDER: '' } })
    expect(resolveRoleRoute(config, 'architect')).toMatchObject({ model: 'codex/gpt-6.1-sol', reasoningEffort: 'medium' })
    expect(config.routes.worker?.provider).toBe('magpie')
  })

  it('resolves worker fallback models without an unsupported effort', async () => {
    const config = await loadHarnessConfig(ROOT, { env: {} })
    for (const role of ['scout-secondary', 'challenger']) {
      const attempts = resolveRoleAttempts(config, role)
      expect(attempts).toHaveLength(3)
      expect(attempts[0]).toMatchObject({ routeId: 'worker-secondary', provider: 'magpie', model: 'opencode-go/mimo-v2.6-flash', reasoningEffort: 'off', maxTokens: 16000 })
      expect(attempts[1]).toMatchObject({ routeId: 'worker-secondary-fallback', provider: 'magpie', model: 'trae-cn/glm-5.3-flash', reasoningEffort: 'off' })
      expect(attempts[2]).toMatchObject({ routeId: 'worker-fallback', provider: 'magpie', model: 'trae-cn/qwen3.8-flash', reasoningEffort: 'off' })
    }
    for (const role of ['scout-primary', 'implementer']) {
      expect(resolveRoleAttempts(config, role)[1]).toMatchObject({ routeId: 'worker-fallback', provider: 'magpie', model: 'trae-cn/qwen3.8-flash', reasoningEffort: 'off' })
    }
    expect(resolveRoleRoute(config, 'implementer').maxTokens).toBe(32000)
    expect(assertRouteDispatchAllowed(config, 'worker-fallback', 'public')).toBeUndefined()
  })

  it('routes orchestration, architecture, and independent review through the configured architecture route', async () => {
    const config = await loadHarnessConfig(ROOT, { env: {} })
    expect(config.providers['magpie-responses']).toMatchObject({ api: 'openai-responses', apiKeyEnv: 'MAGPIE_API_KEY' })
    for (const role of ['coordinator', 'architect', 'reviewer']) {
      expect(resolveRoleRoute(config, role)).toMatchObject({ provider: 'magpie-responses', model: 'codex/gpt-6.1-sol', reasoningEffort: 'medium' })
    }
  })

  it('enforces sensitive-data routing before dispatch', async () => {
    const config = await loadHarnessConfig(ROOT, { env: {} })
    for (const role of ['implementer', 'reviewer']) {
      expect(() => assertDispatchAllowed(config, role, 'sensitive', 'synthetic')).toThrow('does not allow sensitive')
    }
    expect(() => assertDispatchAllowed(config, 'implementer', 'internal')).not.toThrow()
  })

  it('rejects an unsupported environment effort and unknown resolved provider', async () => {
    await expect(loadHarnessConfig(ROOT, { env: { DSH_ARCHITECT_REASONING_EFFORT: 'impossible' } })).rejects.toThrow('unsupported reasoning effort')
    await expect(loadHarnessConfig(ROOT, { env: { DSH_WORKER_PROVIDER: 'missing-provider' } })).rejects.toThrow('unknown provider')
  })

  it('allows a bounded writable implementer fallback', async () => {
    const config = await loadHarnessConfig(ROOT, { env: {} })
    expect(config.roles.implementer).toMatchObject({ writable: true, fallbackRoutes: ['worker-fallback'] })
    expect(resolveRoleAttempts(config, 'implementer')).toHaveLength(2)
  })

  it('keeps the committed Cordis overlay aligned with fixed-role policy', async () => {
    const overlay = await readFile(join(ROOT, 'tools/agent/profiles/frozen-engineering.patch.yml'), 'utf8')
    for (const toolName of ['ask_architect', 'ask_scout_primary', 'ask_scout_secondary', 'run_implementer', 'ask_challenger', 'ask_reviewer', 'ask_arbiter']) {
      expect(overlay).toContain(`toolName: ${toolName}`)
    }
    expect(overlay.match(/maxDepth: 1/g)).toHaveLength(8)
    expect(overlay).toContain('maxConcurrentAgents: 3')
    expect(overlay).toMatch(/id: role-arbiter[\s\S]*?disabled: true/)
    expect(overlay).toContain('process.env.DSH_MAGPIE_API_KEY_ENV')
    expect(overlay).toContain('process.env.DSH_MAGPIE_GATEWAY_URL')
    expect(overlay).toContain('DSH_COMPANY_GATEWAY_URL')
    expect(overlay).toContain('DSH_COMPANY_GATEWAY_API_KEY')
    expect(overlay).not.toContain('DSH_SUB2API_')
    for (const variable of ['DSH_WORKER', 'DSH_WORKER_FALLBACK', 'DSH_SECONDARY_WORKER', 'DSH_SECONDARY_WORKER_FALLBACK', 'DSH_ARCHITECT']) {
      expect(overlay).toContain(variable)
    }
    expect(overlay).not.toContain('reasoningEffort: off')
    expect(overlay).not.toContain("allow:\n        '[object Object]'")
  })
})
