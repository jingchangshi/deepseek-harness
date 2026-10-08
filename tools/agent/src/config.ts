/** Validated configuration for fixed-role engineering orchestration. */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { load } from 'js-yaml'
import type { LifecycleLimits } from './lifecycle.ts'
import { validatePricingQuote, type PricingQuote } from './usage.ts'

/** Per-logical-invocation limits, shared by its configured fallback attempts. */
export interface RoleBounds {
  softDeadlineMs: number
  hardDeadlineMs: number
  maxToolCalls: number
}

/** Data classifications ordered from least to most restricted. */
export type DataClass = 'public' | 'internal' | 'sensitive'

/** Permitted sensitive-input preparation. */
export type SensitiveInputKind = 'synthetic' | 'anonymized' | 'explicitly-approved'

/** Repository evidence required for explicitly approved sensitive input. */
export interface SensitiveApproval {
  source: string
  route: string
  approver: string
  expiresAt: string
}

/** One provider endpoint referenced by logical routes. */
export interface ProviderConfig {
  api: string
  baseURL: string
  apiKeyEnv: string
  compat?: Record<string, boolean>
}

/** One exact provider and model route. */
export interface ModelRouteConfig {
  pricing?: PricingQuote
  cacheOmission?: 'zero' | 'unsupported' | 'unknown'
  inputAccounting?: 'aggregate' | 'exclusive'
  displayName: string
  provider: string
  model: string
  reasoningEfforts: Readonly<Record<string, string | null>>
  maxDataClass: DataClass
  externalRelay: boolean
  costClass: 'standard' | 'premium'
  /** Deployment assertion of route capability, independent of cost. */
  capabilityLevel: number
}

/** One logical role's immutable dispatch defaults. */
export interface RoleConfig {
  route: string
  reasoningEffort: string
  maxTokens: number
  personaFile: string
  writable: boolean
  toolPolicy: 'coordinator' | 'read-only' | 'writer'
  toolName?: string
  enabled: boolean
  allowPremium: boolean
  /** Up to two distinct qualified fallback routes, each tried once after an eligible failure. */
  fallbackRoutes: readonly string[]
  /** Read-only routes reserved for typed capability escalation. */
  escalationRoutes: readonly string[]
  /** Bounded fallbacks used only after an escalation route fails. */
  escalationFallbackRoutes: readonly string[]
}

/** Repository workflow limits that complement DSH's process-local limits. */
export interface WorkflowConfig {
  /** Cumulative limits across task recovery and scope replanning. */
  lifecycleBudget: LifecycleLimits
  /** Runtime-enforced role limits, independent of prompt instructions. */
  roleBounds: Readonly<Record<string, RoleBounds>>
  /** Maximum source files assigned to one automatically generated Scout unit. */
  maxInvestigationPaths: number
  simpleMaxFiles: number
  standardMaxFiles: number
  maxCapabilityEscalations: number
  repairEscalationThreshold: number
  /** Maximum serialized context bytes per role request. */
  maxRoleContextBytes: number
  provider: 'spawn'
  maxDepth: number
  maxConcurrentAgents: number
  maxTotalAgents: number
  minimumFanout: number
  boundedFixRounds: number
  ralphEnabled: boolean
  arbiterEnabled: boolean
  /** Maximum changed files reviewed directly without Scout partitioning. */
  reviewMaxDirectFiles: number
  /** Maximum disjoint Review-only Scout work units. */
  reviewMaxScouts: number
  /** Timeout for each pinned Git evidence query. */
  reviewGitCommandTimeoutMs: number
  /** Maximum bytes accepted from one Git subprocess. */
  reviewGitMaxOutputBytes: number
  /** Default text-page size for Git evidence queries. */
  reviewGitPageSize: number
}

/** Complete validated harness configuration. */
export interface HarnessConfig {
  runtimeTag: string
  providers: Readonly<Record<string, ProviderConfig>>
  routes: Readonly<Record<string, ModelRouteConfig>>
  roles: Readonly<Record<string, RoleConfig>>
  workflow: WorkflowConfig
  dataPolicy: {
    classes: Readonly<Record<DataClass, number>>
    allowedSensitiveInputs: SensitiveInputKind[]
    forbiddenCommittedPatterns: string[]
  }
}

/** Resolved route passed to a fixed role tool. */
export interface ResolvedRoleRoute {
  pricing?: PricingQuote
  cacheOmission?: 'zero' | 'unsupported' | 'unknown'
  inputAccounting?: 'aggregate' | 'exclusive'
  role: string
  /** Exact resolved route identifier, distinct from the logical role. */
  routeId: string
  capabilityLevel: number
  toolName?: string
  provider: string
  model: string
  reasoningEffort: string
  maxTokens: number
  writable: boolean
  externalRelay: boolean
  costClass: 'standard' | 'premium'
}

const PLACEHOLDER = /^\$\{([A-Z][A-Z0-9_]*)(?::-([^{}]+))?\}$/
const DATA_RANK: Readonly<Record<DataClass, number>> = { public: 0, internal: 1, sensitive: 2 }

/**
 * Select repository templates without copying user deployment configuration or personas.
 * @param path - file or directory relative to the source `.agent` directory.
 * @returns whether repository initialization may copy the entry.
 */
export function isRepositoryTemplatePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  return normalized !== 'roles' && !normalized.startsWith('roles/')
    && !['config/models.yaml', 'config/roles.yaml', 'config/workflow.yaml', 'config/data-policy.yaml'].includes(normalized)
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`)
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) result[key] = entry
  return result
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`)
  return value
}

function boolean(value: unknown, field: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`)
  return value
}

/** Validate a provider's pi-ai wire-compatibility switches as an explicit boolean dict. */
function booleanDict(value: unknown, field: string): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  for (const [key, entry] of Object.entries(record(value, field))) {
    if (typeof entry !== 'boolean') throw new Error(`${field}.${key} must be a boolean`)
    result[key] = entry
  }
  return result
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 1) throw new Error(`${field} must be a positive integer`)
  return value
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`)
  return value
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${field} must be a positive finite number`)
  return value
}

function oneOf<const T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${field} must be one of ${allowed.join(', ')}`)
  return value as T
}

function deploymentValue(value: unknown, field: string, env: NodeJS.ProcessEnv, required: boolean): string {
  const configured = string(value, field)
  const match = PLACEHOLDER.exec(configured)
  if (match === null) return configured
  const name = match[1]
  if (name === undefined) throw new Error(`${field} has an invalid placeholder`)
  const resolved = env[name]
  if (resolved !== undefined && resolved.length > 0) return resolved
  if (match[2] !== undefined) return match[2]
  if (required) throw new Error(`${field} requires environment variable ${name}`)
  return configured
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string' && entry.length > 0)) {
    throw new Error(`${field} must be a non-empty string array`)
  }
  return [...value]
}

function validateProviderBaseURL(api: string, baseURL: string, field: string): void {
  if (PLACEHOLDER.test(baseURL) || api !== 'anthropic-messages') return
  let pathname: string
  try {
    pathname = new URL(baseURL).pathname
  } catch {
    throw new Error(`${field} must be an absolute URL`)
  }
  if (/\/v1\/?$/u.test(pathname)) {
    throw new Error(`${field} must omit the trailing /v1 for anthropic-messages because its client appends /v1/messages`)
  }
}

async function yamlFile(path: string): Promise<unknown> {
  return load(await readFile(path, 'utf8'))
}

/**
 * Load and validate user-owned engineering deployment configuration.
 * @param root - deployment directory containing `.agent/config`; independent of the Session repository.
 * @param options - deployment environment and whether placeholders without defaults must resolve for selected providers and routes. `${VAR:-default}` uses its literal default when the variable is unset or empty. Resolved `apiKeyEnv` values must name environment variables.
 * @returns validated provider, route, role, and workflow settings.
 */
export async function loadHarnessConfig(
  root: string,
  options: { env?: NodeJS.ProcessEnv; requireDeployment?: boolean } = {},
): Promise<HarnessConfig> {
  const env = options.env ?? process.env
  const required = options.requireDeployment ?? false
  const configRoot = resolve(root, '.agent/config')
  const [modelsValue, rolesValue, workflowValue, dataPolicyValue] = await Promise.all([
    yamlFile(resolve(configRoot, 'models.yaml')),
    yamlFile(resolve(configRoot, 'roles.yaml')),
    yamlFile(resolve(configRoot, 'workflow.yaml')),
    yamlFile(resolve(configRoot, 'data-policy.yaml')),
  ])
  const models = record(modelsValue, 'models.yaml')
  const rolesDocument = record(rolesValue, 'roles.yaml')
  const workflowDocument = record(workflowValue, 'workflow.yaml')
  const dataPolicyDocument = record(dataPolicyValue, 'data-policy.yaml')
  const architectDeclaration = record(record(rolesDocument.roles, 'roles.roles').architect, 'roles.roles.architect')
  const architectReasoningEffort = deploymentValue(architectDeclaration.reasoningEffort, 'roles.roles.architect.reasoningEffort', env, required)
  if (models.schemaVersion !== 1 || rolesDocument.schemaVersion !== 1 || workflowDocument.schemaVersion !== 1 || dataPolicyDocument.schemaVersion !== 1) {
    throw new Error('configuration schemaVersion must be 1')
  }

  const routeDeclarations = record(models.routes, 'models.routes')
  const selectedProviders = new Set(Object.entries(routeDeclarations).map(([id, rawValue]) =>
    deploymentValue(record(rawValue, `models.routes.${id}`).provider, `models.routes.${id}.provider`, env, required)))
  const providers: Record<string, ProviderConfig> = {}
  for (const [id, rawValue] of Object.entries(record(models.providers, 'models.providers'))) {
    const value = record(rawValue, `models.providers.${id}`)
    const providerRequired = required && selectedProviders.has(id)
    const api = deploymentValue(value.api, `models.providers.${id}.api`, env, providerRequired)
    const baseURL = deploymentValue(value.baseURL, `models.providers.${id}.baseURL`, env, providerRequired)
    validateProviderBaseURL(api, baseURL, `models.providers.${id}.baseURL`)
    const apiKeyEnv = deploymentValue(value.apiKeyEnv, `models.providers.${id}.apiKeyEnv`, env, providerRequired)
    const placeholder = typeof value.apiKeyEnv === 'string' ? PLACEHOLDER.exec(value.apiKeyEnv) : null
    const unresolved = !providerRequired && placeholder?.[1] !== undefined && placeholder[2] === undefined && !env[placeholder[1]]
    if (!unresolved && !isCredentialRefName(apiKeyEnv)) {
      throw new Error(`models.providers.${id}.apiKeyEnv must name an environment variable, e.g. MAGPIE_API_KEY`)
    }
    providers[id] = {
      api,
      baseURL,
      apiKeyEnv,
      ...value.compat === undefined ? {} : { compat: booleanDict(value.compat, `models.providers.${id}.compat`) },
    }
  }

  const routes: Record<string, ModelRouteConfig> = {}
  for (const [id, rawValue] of Object.entries(routeDeclarations)) {
    const value = record(rawValue, `models.routes.${id}`)
    const provider = deploymentValue(value.provider, `models.routes.${id}.provider`, env, required)
    if (providers[provider] === undefined) throw new Error(`models.routes.${id}.provider references unknown provider ${provider}`)
    const efforts: Record<string, string | null> = {}
    for (const [effort, wireValue] of Object.entries(record(value.reasoningEfforts, `models.routes.${id}.reasoningEfforts`))) {
      efforts[effort] = wireValue === null ? null : deploymentValue(wireValue, `models.routes.${id}.reasoningEfforts.${effort}`, env, required)
    }
    if (Object.keys(efforts).length === 0) throw new Error(`models.routes.${id}.reasoningEfforts must not be empty`)
    routes[id] = {
      ...(value.pricing === undefined ? {} : { pricing: validatePricingQuote(value.pricing, Date.now()) }),
      ...(value.cacheOmission === undefined ? {} : { cacheOmission: oneOf(value.cacheOmission, `models.routes.${id}.cacheOmission`, ['zero', 'unsupported', 'unknown']) }),
      ...(value.inputAccounting === undefined ? {} : { inputAccounting: oneOf(value.inputAccounting, `models.routes.${id}.inputAccounting`, ['aggregate', 'exclusive']) }),
      displayName: string(value.displayName, `models.routes.${id}.displayName`),
      provider,
      model: deploymentValue(value.model, `models.routes.${id}.model`, env, required),
      reasoningEfforts: efforts,
      maxDataClass: oneOf(value.maxDataClass, `models.routes.${id}.maxDataClass`, ['public', 'internal', 'sensitive']),
      externalRelay: boolean(value.externalRelay, `models.routes.${id}.externalRelay`),
      costClass: oneOf(value.costClass, `models.routes.${id}.costClass`, ['standard', 'premium']),
      capabilityLevel: value.capabilityLevel === undefined ? 0 : nonNegativeInteger(value.capabilityLevel, `models.routes.${id}.capabilityLevel`),
    }
  }

  const modelRoutes = new Map<string, { id: string; efforts: Readonly<Record<string, string | null>> }>()
  for (const [id, route] of Object.entries(routes)) {
    const key = JSON.stringify([route.provider, route.model])
    const previous = modelRoutes.get(key)
    if (previous !== undefined
      && (Object.keys(previous.efforts).length !== Object.keys(route.reasoningEfforts).length
        || Object.entries(previous.efforts).some(([effort, wireValue]) => route.reasoningEfforts[effort] !== wireValue))) {
      throw new Error(`models.routes.${id} and models.routes.${previous.id} use the same provider/model with conflicting reasoningEfforts; use identical mappings or select different models`)
    }
    modelRoutes.set(key, { id, efforts: route.reasoningEfforts })
  }

  const roles: Record<string, RoleConfig> = {}
  const toolNames = new Set<string>()
  for (const [id, rawValue] of Object.entries(record(rolesDocument.roles, 'roles.roles'))) {
    const value = record(rawValue, `roles.roles.${id}`)
    const route = string(value.route, `roles.roles.${id}.route`)
    const routeConfig = routes[route]
    if (routeConfig === undefined) throw new Error(`roles.roles.${id}.route references unknown route ${route}`)
    const effort = deploymentValue(value.reasoningEffort, `roles.roles.${id}.reasoningEffort`, env, required)
    if (routeConfig.reasoningEfforts[effort] === undefined) throw new Error(`role ${id} requests unsupported reasoning effort ${effort}`)
    const toolName = value.toolName === undefined ? undefined : string(value.toolName, `roles.roles.${id}.toolName`)
    if (id !== 'coordinator' && toolName === undefined) throw new Error(`role ${id} requires a fixed toolName`)
    if (toolName !== undefined && toolNames.has(toolName)) throw new Error(`duplicate role toolName ${toolName}`)
    if (toolName !== undefined) toolNames.add(toolName)
    const allowPremium = boolean(value.allowPremium, `roles.roles.${id}.allowPremium`, false)
    if (routeConfig.costClass === 'premium' && !allowPremium) throw new Error(`role ${id} must explicitly allow its premium route`)
    const writable = boolean(value.writable, `roles.roles.${id}.writable`)
    const toolPolicy = oneOf(value.toolPolicy, `roles.roles.${id}.toolPolicy`, ['coordinator', 'read-only', 'writer'])
    if (writable !== (id === 'implementer' && toolPolicy === 'writer')) throw new Error('implementer with writer policy must be the only writable role')
    const fallbackRoutes = value.fallbackRoutes === undefined ? [] : stringArray(value.fallbackRoutes, `roles.roles.${id}.fallbackRoutes`)
    const escalationRoutes = value.escalationRoutes === undefined ? [] : stringArray(value.escalationRoutes, `roles.roles.${id}.escalationRoutes`)
    const escalationFallbackRoutes = value.escalationFallbackRoutes === undefined ? [] : stringArray(value.escalationFallbackRoutes, `roles.roles.${id}.escalationFallbackRoutes`)
    if (fallbackRoutes.length > 2) throw new Error(`role ${id} may declare at most two fallback routes`)
    if (fallbackRoutes.length > 0 && toolPolicy !== 'read-only' && toolPolicy !== 'writer') throw new Error(`role ${id} fallback requires read-only or writer tool policy`)
    const fallbackModels = new Map<string, Set<string>>()
    for (const fallback of fallbackRoutes) {
      if (fallback === route) throw new Error(`role ${id} fallback route must differ from its primary route`)
      const fallbackConfig = routes[fallback]
      if (fallbackConfig === undefined) throw new Error(`roles.roles.${id}.fallbackRoutes references unknown route ${fallback}; add it to models.yaml or remove the fallback declaration from roles.yaml`)
      if (fallbackConfig.provider === routeConfig.provider && fallbackConfig.model === routeConfig.model) {
        throw new Error(`role ${id} fallback must use a different provider or model, not an alias of the primary route`)
      }
      const models = fallbackModels.get(fallbackConfig.provider) ?? new Set<string>()
      if (models.has(fallbackConfig.model)) throw new Error(`role ${id} fallback routes must use distinct providers or models`)
      models.add(fallbackConfig.model)
      fallbackModels.set(fallbackConfig.provider, models)
      if (fallbackConfig.reasoningEfforts[effort] === undefined) throw new Error(`role ${id} fallback route ${fallback} does not support reasoning effort ${effort}`)
      if (fallbackConfig.costClass === 'premium' && !allowPremium) throw new Error(`role ${id} must explicitly allow its premium fallback route ${fallback}`)
    }
    const baseCapability = Math.max(routeConfig.capabilityLevel, ...fallbackRoutes.map(id => routes[id]?.capabilityLevel ?? 0))
    const escalationIds = [...escalationRoutes, ...escalationFallbackRoutes]
    if (escalationFallbackRoutes.length > 2) throw new Error(`role ${id} may declare at most two escalation fallback routes`)
    if (new Set(escalationIds).size !== escalationIds.length) throw new Error(`role ${id} escalation routes must be distinct`)
    if (escalationIds.some(routeId => routeId === route || fallbackRoutes.includes(routeId))) throw new Error(`role ${id} escalation routes must differ from primary and normal fallback routes`)
    const escalationModels = new Set([route, ...fallbackRoutes].map(routeId => {
      const candidate = routes[routeId]
      return JSON.stringify([candidate?.provider, candidate?.model])
    }))
    for (const routeId of escalationIds) {
      const candidate = routes[routeId]
      if (candidate !== undefined) {
        const modelKey = JSON.stringify([candidate.provider, candidate.model])
        if (escalationModels.has(modelKey)) throw new Error(`role ${id} escalation route ${routeId} must use a different provider or model from its other routes`)
        escalationModels.add(modelKey)
      }
    }
    escalationRoutes.forEach(routeId => {
      const candidate = routes[routeId]
      if (candidate === undefined) throw new Error(`roles.roles.${id}.escalationRoutes references unknown route ${routeId}`)
      if (candidate.capabilityLevel <= baseCapability) throw new Error(`role ${id} escalation route ${routeId} must increase capability above its primary and fallback routes`)
      const escalationEffort = writable ? architectReasoningEffort : effort
      if (candidate.reasoningEfforts[escalationEffort] === undefined) throw new Error(`role ${id} escalation route ${routeId} does not support reasoning effort ${escalationEffort}`)
      if (candidate.costClass === 'premium' && !allowPremium) throw new Error(`role ${id} must explicitly allow its premium escalation route ${routeId}`)
    })
    const escalationFloor = baseCapability
    for (const routeId of escalationFallbackRoutes) {
      const candidate = routes[routeId]
      if (candidate === undefined) throw new Error(`roles.roles.${id}.escalationFallbackRoutes references unknown route ${routeId}`)
      if (candidate.capabilityLevel <= escalationFloor) throw new Error(`role ${id} escalation fallback route ${routeId} must remain above its escalation routes`)
      const escalationEffort = writable ? architectReasoningEffort : effort
      if (candidate.reasoningEfforts[escalationEffort] === undefined) throw new Error(`role ${id} escalation fallback route ${routeId} does not support reasoning effort ${escalationEffort}`)
      if (candidate.costClass === 'premium' && !allowPremium) throw new Error(`role ${id} must explicitly allow its premium escalation fallback route ${routeId}`)
    }
    roles[id] = {
      route,
      reasoningEffort: effort,
      maxTokens: positiveInteger(value.maxTokens, `roles.roles.${id}.maxTokens`),
      personaFile: string(value.personaFile, `roles.roles.${id}.personaFile`),
      writable,
      toolPolicy,
      ...toolName === undefined ? {} : { toolName },
      enabled: boolean(value.enabled, `roles.roles.${id}.enabled`, true),
      allowPremium,
      fallbackRoutes,
      escalationRoutes,
      escalationFallbackRoutes,
    }
  }

  const budget = record(workflowDocument.lifecycleBudget ?? {}, 'workflow.lifecycleBudget')
  const lifecycleBudget: LifecycleLimits = {
    maxLogicalInvocations: positiveInteger(budget.maxLogicalInvocations ?? 60, 'workflow.lifecycleBudget.maxLogicalInvocations'),
    maxModelAttempts: positiveInteger(budget.maxModelAttempts ?? 120, 'workflow.lifecycleBudget.maxModelAttempts'),
    maxProviderRequests: positiveInteger(budget.maxProviderRequests ?? 600, 'workflow.lifecycleBudget.maxProviderRequests'),
    maxToolCalls: positiveInteger(budget.maxToolCalls ?? 1200, 'workflow.lifecycleBudget.maxToolCalls'),
    maxElapsedMs: positiveInteger(budget.maxElapsedMs ?? 7_200_000, 'workflow.lifecycleBudget.maxElapsedMs'),
    ...(budget.maxTotalTokens === undefined ? {} : { maxTotalTokens: positiveInteger(budget.maxTotalTokens, 'workflow.lifecycleBudget.maxTotalTokens') }),
    ...(budget.maxKnownCostUsd === undefined ? {} : { maxKnownCostUsd: positiveNumber(budget.maxKnownCostUsd, 'workflow.lifecycleBudget.maxKnownCostUsd') }),
  }
  const roleLimits = record(workflowDocument.roleBounds ?? {}, 'workflow.roleBounds')
  const roleBounds: Record<string, RoleBounds> = {}
  for (const [role, defaults] of Object.entries({
    'scout-primary': [90_000, 240_000, 40], 'scout-secondary': [90_000, 240_000, 40],
    architect: [300_000, 480_000, 40], challenger: [180_000, 300_000, 30],
    reviewer: [300_000, 600_000, 50], implementer: [300_000, 600_000, 100],
  })) {
    const configured = record(roleLimits[role] ?? {}, `workflow.roleBounds.${role}`)
    const bounds = {
      softDeadlineMs: positiveInteger(configured.softDeadlineMs ?? defaults[0], `workflow.roleBounds.${role}.softDeadlineMs`),
      hardDeadlineMs: positiveInteger(configured.hardDeadlineMs ?? defaults[1], `workflow.roleBounds.${role}.hardDeadlineMs`),
      maxToolCalls: positiveInteger(configured.maxToolCalls ?? defaults[2], `workflow.roleBounds.${role}.maxToolCalls`),
    }
    if (bounds.softDeadlineMs >= bounds.hardDeadlineMs) throw new Error(`workflow.roleBounds.${role} soft deadline must precede its hard deadline`)
    roleBounds[role] = bounds
  }
  for (const role of Object.keys(roleLimits)) if (!(role in roleBounds)) throw new Error(`workflow.roleBounds references unknown role ${role}`)
  const workflow: WorkflowConfig = {
    lifecycleBudget, roleBounds,
    maxInvestigationPaths: positiveInteger(workflowDocument.maxInvestigationPaths ?? 40, 'workflow.maxInvestigationPaths'),
    simpleMaxFiles: positiveInteger(workflowDocument.simpleMaxFiles ?? 3, 'workflow.simpleMaxFiles'),
    standardMaxFiles: positiveInteger(workflowDocument.standardMaxFiles ?? 12, 'workflow.standardMaxFiles'),
    maxCapabilityEscalations: nonNegativeInteger(workflowDocument.maxCapabilityEscalations ?? 2, 'workflow.maxCapabilityEscalations'),
    repairEscalationThreshold: positiveInteger(workflowDocument.repairEscalationThreshold ?? 2, 'workflow.repairEscalationThreshold'),
    maxRoleContextBytes: positiveInteger(workflowDocument.maxRoleContextBytes ?? 32_768, 'workflow.maxRoleContextBytes'),
    provider: oneOf(workflowDocument.provider, 'workflow.provider', ['spawn']),
    maxDepth: positiveInteger(workflowDocument.maxDepth, 'workflow.maxDepth'),
    maxConcurrentAgents: positiveInteger(workflowDocument.maxConcurrentAgents, 'workflow.maxConcurrentAgents'),
    maxTotalAgents: positiveInteger(workflowDocument.maxTotalAgents, 'workflow.maxTotalAgents'),
    minimumFanout: positiveInteger(workflowDocument.minimumFanout, 'workflow.minimumFanout'),
    boundedFixRounds: positiveInteger(workflowDocument.boundedFixRounds, 'workflow.boundedFixRounds'),
    ralphEnabled: boolean(workflowDocument.ralphEnabled, 'workflow.ralphEnabled'),
    arbiterEnabled: boolean(workflowDocument.arbiterEnabled, 'workflow.arbiterEnabled'),
    reviewMaxDirectFiles: positiveInteger(workflowDocument.reviewMaxDirectFiles ?? 4, 'workflow.reviewMaxDirectFiles'),
    reviewMaxScouts: positiveInteger(workflowDocument.reviewMaxScouts ?? 2, 'workflow.reviewMaxScouts'),
    reviewGitCommandTimeoutMs: positiveInteger(workflowDocument.reviewGitCommandTimeoutMs ?? 30_000, 'workflow.reviewGitCommandTimeoutMs'),
    reviewGitMaxOutputBytes: positiveInteger(workflowDocument.reviewGitMaxOutputBytes ?? 8_388_608, 'workflow.reviewGitMaxOutputBytes'),
    reviewGitPageSize: positiveInteger(workflowDocument.reviewGitPageSize ?? 16_384, 'workflow.reviewGitPageSize'),
  }
  if (workflow.standardMaxFiles < workflow.simpleMaxFiles) throw new Error('workflow.standardMaxFiles must be at least simpleMaxFiles')
  if (workflow.reviewMaxScouts > workflow.maxConcurrentAgents) throw new Error('workflow.reviewMaxScouts exceeds maxConcurrentAgents')
  if (workflow.maxDepth !== 1) throw new Error('workflow.maxDepth must remain 1')
  if (workflow.maxConcurrentAgents !== 3) throw new Error('workflow.maxConcurrentAgents must remain 3')
  if (workflow.boundedFixRounds !== 2) throw new Error('workflow.boundedFixRounds must remain 2')
  if (workflow.arbiterEnabled || roles.arbiter?.enabled !== false) throw new Error('arbiter must be disabled by default')

  const classValues = record(dataPolicyDocument.classes, 'data-policy.classes')
  const classes: Record<DataClass, number> = {
    public: classValues.public === 0 ? 0 : Number.NaN,
    internal: classValues.internal === 1 ? 1 : Number.NaN,
    sensitive: classValues.sensitive === 2 ? 2 : Number.NaN,
  }
  if (Object.values(classes).some(Number.isNaN)) throw new Error('data-policy.classes must order public=0, internal=1, sensitive=2')
  const sensitiveInputs = record(dataPolicyDocument.sensitiveInputs, 'data-policy.sensitiveInputs')
  if (!Array.isArray(sensitiveInputs.allowedKinds)) throw new Error('data-policy sensitive allowedKinds must be an array')
  const allowedSensitiveInputs = sensitiveInputs.allowedKinds.map((value, index) =>
    oneOf(value, `data-policy.sensitiveInputs.allowedKinds[${String(index)}]`, ['synthetic', 'anonymized', 'explicitly-approved']))
  if (!Array.isArray(dataPolicyDocument.forbiddenCommittedPatterns)
    || !dataPolicyDocument.forbiddenCommittedPatterns.every(value => typeof value === 'string' && value.length > 0)) {
    throw new Error('data-policy forbiddenCommittedPatterns must be a non-empty string array')
  }

  return {
    runtimeTag: string(models.runtimeTag, 'models.runtimeTag'),
    providers,
    routes,
    roles,
    workflow,
    dataPolicy: { classes, allowedSensitiveInputs, forbiddenCommittedPatterns: dataPolicyDocument.forbiddenCommittedPatterns },
  }
}

/**
 * Build one resolved role dispatch for an enabled logical role and a specific route.
 * @param role - logical role identifier.
 * @param roleConfig - the role's validated immutable dispatch defaults.
 * @param routeId - the exact route identifier being resolved.
 * @param route - the route's provider and model declaration.
 * @returns immutable dispatch fields for the fixed role tool over the requested route.
 */
function resolvedRoleRoute(role: string, roleConfig: RoleConfig, routeId: string, route: ModelRouteConfig): ResolvedRoleRoute {
  return {
    ...(route.pricing === undefined ? {} : { pricing: route.pricing }),
    ...(route.cacheOmission === undefined ? {} : { cacheOmission: route.cacheOmission }),
    ...(route.inputAccounting === undefined ? {} : { inputAccounting: route.inputAccounting }),
    role,
    routeId,
    capabilityLevel: route.capabilityLevel,
    ...roleConfig.toolName === undefined ? {} : { toolName: roleConfig.toolName },
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoningEfforts[roleConfig.reasoningEffort] === null ? 'off' : roleConfig.reasoningEffort,
    maxTokens: roleConfig.maxTokens,
    writable: roleConfig.writable,
    externalRelay: route.externalRelay,
    costClass: route.costClass,
  }
}

/**
 * Resolve one enabled logical role to its exact primary model request.
 * @param config - validated harness configuration.
 * @param role - logical role identifier.
 * @returns immutable dispatch fields for the fixed role tool.
 */
export function resolveRoleRoute(config: HarnessConfig, role: string): ResolvedRoleRoute {
  const roleConfig = config.roles[role]
  if (roleConfig === undefined) throw new Error(`unknown role ${role}`)
  if (!roleConfig.enabled) throw new Error(`role ${role} is disabled`)
  return resolveRoleByRoute(config, role, roleConfig.route)
}

/**
 * Resolve one enabled logical role over a specific validated route identifier.
 * @param config - validated harness configuration.
 * @param role - logical role identifier.
 * @param routeId - exact route identifier used for this attempt.
 * @returns immutable dispatch fields for the fixed role tool over the requested route.
 */
export function resolveRoleByRoute(config: HarnessConfig, role: string, routeId: string): ResolvedRoleRoute {
  const roleConfig = config.roles[role]
  if (roleConfig === undefined) throw new Error(`unknown role ${role}`)
  if (!roleConfig.enabled) throw new Error(`role ${role} is disabled`)
  const route = config.routes[routeId]
  if (route === undefined) throw new Error(`role ${role} references missing route ${routeId}`)
  return resolvedRoleRoute(role, roleConfig, routeId, route)
}

/**
 * Resolve every qualified fallback route declared for one logical role.
 * @param config - validated harness configuration.
 * @param role - logical role identifier.
 * @returns the role's configured fallback dispatches in declared order.
 */
export function resolveRoleFallbackRoutes(config: HarnessConfig, role: string): ResolvedRoleRoute[] {
  const roleConfig = config.roles[role]
  if (roleConfig === undefined) throw new Error(`unknown role ${role}`)
  if (!roleConfig.enabled) throw new Error(`role ${role} is disabled`)
  return roleConfig.fallbackRoutes.map(routeId => resolveRoleByRoute(config, role, routeId))
}

/** Resolve configured stronger routes and their separately bounded fallbacks. */
export function resolveRoleEscalations(
  config: HarnessConfig,
  role: string,
  failedRouteId: string,
): { candidates: ResolvedRoleRoute[]; fallbackCandidates: ResolvedRoleRoute[] } {
  const roleConfig = config.roles[role]
  if (roleConfig === undefined) throw new Error(`unknown role ${role}`)
  if (!roleConfig.enabled) throw new Error(`role ${role} is disabled`)
  const failedRoute = config.routes[failedRouteId]
  if (failedRoute === undefined) throw new Error(`unknown failed route ${failedRouteId}`)
  const executionRole = roleConfig.writable ? 'architect' : role
  const candidates = roleConfig.escalationRoutes
    .filter(routeId => (config.routes[routeId]?.capabilityLevel ?? -1) > failedRoute.capabilityLevel)
    .map(routeId => resolveRoleByRoute(config, executionRole, routeId))
  const floor = failedRoute.capabilityLevel
  const fallbackCandidates = roleConfig.escalationFallbackRoutes
    .filter(routeId => (config.routes[routeId]?.capabilityLevel ?? -1) > floor)
    .map(routeId => resolveRoleByRoute(config, executionRole, routeId))
  return { candidates, fallbackCandidates }
}

/**
 * Resolve the bounded primary + fallback attempt list for one logical role.
 * @param config - validated harness configuration.
 * @param role - logical role identifier.
 * @returns the primary route followed by every qualified fallback route.
 */
export function resolveRoleAttempts(config: HarnessConfig, role: string): ResolvedRoleRoute[] {
  return [resolveRoleRoute(config, role), ...resolveRoleFallbackRoutes(config, role)]
}

/**
 * Enforce data classification for one specific route before that route's dispatch begins.
 * @param config - validated harness configuration.
 * @param routeId - exact route identifier being dispatched.
 * @param dataClass - highest data class included in the request.
 * @param sensitiveInputKind - preparation applied to sensitive input.
 */
export function assertRouteDispatchAllowed(
  config: HarnessConfig,
  routeId: string,
  dataClass: DataClass,
  sensitiveInputKind?: SensitiveInputKind,
  approval?: SensitiveApproval,
  now = Date.now(),
): void {
  const route = config.routes[routeId]
  if (route === undefined) throw new Error(`unknown route ${routeId}`)
  if (DATA_RANK[dataClass] > DATA_RANK[route.maxDataClass]) throw new Error(`route ${routeId} does not allow ${dataClass} data`)
  if (dataClass === 'sensitive' && sensitiveInputKind === undefined) throw new Error('sensitive input must be synthetic, anonymized, or explicitly approved')
  if (dataClass === 'sensitive' && route.externalRelay) throw new Error(`sensitive input cannot use external relay ${routeId}`)
  if (sensitiveInputKind !== undefined && !config.dataPolicy.allowedSensitiveInputs.includes(sensitiveInputKind)) {
    throw new Error(`sensitive input kind ${sensitiveInputKind} is not allowed`)
  }
  if (dataClass === 'sensitive' && sensitiveInputKind === 'explicitly-approved') {
    if (approval === undefined || [approval.source, approval.approver, approval.expiresAt].some(value => value.trim().length === 0)) {
      throw new Error('explicit sensitive approval requires source, route, approver, and expiresAt')
    }
    if (approval.route !== routeId) throw new Error(`sensitive approval route ${approval.route} does not match ${routeId}`)
    const expiresAt = Date.parse(approval.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('sensitive approval is expired or invalid')
  }
}

/**
 * Enforce data classification before a role dispatch begins.
 * @param config - validated harness configuration.
 * @param role - target logical role.
 * @param dataClass - highest data class included in the request.
 * @param sensitiveInputKind - preparation applied to sensitive input.
 */
export function assertDispatchAllowed(
  config: HarnessConfig,
  role: string,
  dataClass: DataClass,
  sensitiveInputKind?: SensitiveInputKind,
  approval?: SensitiveApproval,
  now = Date.now(),
): void {
  const roleConfig = config.roles[role]
  if (roleConfig === undefined) throw new Error(`unknown role ${role}`)
  if (!roleConfig.enabled) throw new Error(`role ${role} is disabled`)
  assertRouteDispatchAllowed(config, roleConfig.route, dataClass, sensitiveInputKind, approval, now)
}
