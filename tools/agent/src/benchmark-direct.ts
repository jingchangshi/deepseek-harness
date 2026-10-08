/** Production-backed direct role adapter for benchmark strategies A, B and C. */

import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import Ajv from 'ajv'
import { assertObjectJsonSchema, type JsonSchemaNode, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { resolveRoleByRoute, assertRouteDispatchAllowed } from './config.ts'
import type { HarnessConfig, ResolvedRoleRoute } from './config.ts'
import { FileTaskLifecycle } from './lifecycle.ts'
import type { TaskLifecycle } from './lifecycle.ts'
import { roleResponseSchema, unwrapRoleResponse } from './role-response.ts'
import { CapabilityInsufficientError, RoleQuiescenceError, RoleInvocationError } from './role-execution.ts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { REVIEW_OUTPUT_SCHEMA, validateEngineeringReviewEvidence } from './review-only.ts'
import type { EngineeringRole, RoleExecutor, RoleInvocation } from './automatic.ts'
import type { EngineeringBenchmarkCase, EngineeringStageReceipt, EngineeringRunEvidence, EngineeringStrategyId, EngineeringBenchmarkRunContext, ProductionBenchmarkRoleInvoker } from './benchmark.ts'
import { createGitSnapshot, GitEvidenceRepository } from './git-evidence.ts'
import type { GitReviewTarget } from './git-evidence.ts'

type DirectRole = 'scout-primary' | 'architect' | 'challenger' | 'implementer' | 'reviewer'

interface DirectRun {
  lifecycle: FileTaskLifecycle
  taskId: string
  workflow: 'development' | 'review-only'
  started: boolean
  confirmedStopped: boolean
}

/** Create route-bound benchmark calls backed by the production role executor and durable usage ledger.
 * @param options - deployment, actual profile role executor, and optional lifecycle budget overrides.
 * @returns the direct strategy adapter consumed by benchmark bindings.
 */
export function createDirectEngineeringInvoker(options: {
  deployment: HarnessConfig
  executeRole: RoleExecutor
  verify(testCase: EngineeringBenchmarkCase, root: string): Promise<boolean>
  reviewTarget(testCase: EngineeringBenchmarkCase): GitReviewTarget
  limits?: HarnessConfig['workflow']['lifecycleBudget']
}): ProductionBenchmarkRoleInvoker {
  const runs = new Map<string, DirectRun>()
  const contexts = new Map<string, Record<string, unknown>>()
  const getRun = async (root: string, testCase: EngineeringBenchmarkCase): Promise<DirectRun> => {
    const key = root
    if (!contexts.has(key)) contexts.set(key, {})
    const prior = runs.get(key)
    if (prior !== undefined) return prior
    const workflow = testCase.kind === 'review' ? 'review-only' : 'development'
    const taskId = `benchmark-${createHash('sha256').update(`${testCase.id}\0${root}`).digest('hex').slice(0, 24)}`
    await mkdir(join(root, '.agent', workflow === 'development' ? 'tasks' : 'reviews', taskId), { recursive: true, mode: 0o700 })
    const lifecycle = new FileTaskLifecycle(root, taskId, workflow, options.limits ?? options.deployment.workflow.lifecycleBudget, () => new Date().toISOString(), 0, false)
    await lifecycle.initialize()
    const run: DirectRun = { lifecycle, taskId, workflow, started: false, confirmedStopped: true }
    runs.set(key, run)
    return run
  }

  const invoke = async (input: { routeId: string; role: 'implementer' | 'reviewer'; request: string; root: string; readOnly: boolean; testCase: EngineeringBenchmarkCase }): Promise<EngineeringStageReceipt> => {
    return invokeRole({
      ...input, role: input.role, stage: input.role === 'implementer' ? 'SINGLE' : 'REVIEWER', context: {},
    })
  }

  const invokeFixedStage = async (input: { stage: 'SCOUT' | 'ARCHITECT' | 'CHALLENGER' | 'IMPLEMENTER' | 'VERIFICATION' | 'REVIEWER'; request: string; root: string; readOnly: boolean; testCase: EngineeringBenchmarkCase }): Promise<EngineeringStageReceipt> => {
    if (input.stage === 'VERIFICATION') {
      const startedAt = new Date().toISOString()
      const passed = await options.verify(input.testCase, input.root)
      return { stage: 'VERIFICATION', startedAt, endedAt: new Date().toISOString(), outcome: passed ? 'SUCCESS' : 'FAILED', requestIds: [] }
    }
    const role: DirectRole = input.stage === 'SCOUT' ? 'scout-primary'
      : input.stage === 'ARCHITECT' ? 'architect'
        : input.stage === 'CHALLENGER' ? 'challenger'
          : input.stage === 'IMPLEMENTER' ? 'implementer' : 'reviewer'
    return invokeRole({ ...input, role, stage: input.stage, routeId: resolveRoleByRoute(options.deployment, role, options.deployment.roles[role]?.route ?? '').routeId, context: {} })
  }

  async function invokeRole(input: {
    role: DirectRole
    stage: EngineeringStageReceipt['stage']
    routeId: string
    request: string
    root: string
    readOnly: boolean
    testCase: EngineeringBenchmarkCase
    context: Record<string, unknown>
  }): Promise<EngineeringStageReceipt> {
    const route = resolveRoleByRoute(options.deployment, input.role, input.routeId)
    const effectiveRoute: ResolvedRoleRoute = { ...route, writable: input.readOnly ? false : input.role === 'implementer' }
    assertRouteDispatchAllowed(options.deployment, route.routeId, 'public')
    const run = await getRun(input.root, input.testCase)
    if (!run.started) {
      await run.lifecycle.recordRunState({ state: 'RUNNING', at: new Date().toISOString() })
      run.started = true
    }
    const invocationId = await run.lifecycle.reserveInvocation(input.role)
    const attemptId = await run.lifecycle.reserveAttempt(invocationId, effectiveRoute)
    const bounds = options.deployment.workflow.roleBounds[input.role]
    if (bounds === undefined) throw new Error(`benchmark role ${input.role} has no configured execution bounds`)
    const requestIds: string[] = []
    const reservedToolCalls = new Set<string>()
    let bodyCalls = 0
    const lifecycle = new Proxy(run.lifecycle, {
      get(target, property) {
        if (property === 'reserveProviderRequest') return async (id: Parameters<TaskLifecycle['reserveProviderRequest']>[0], requestId: string, details: Parameters<TaskLifecycle['reserveProviderRequest']>[2]) => {
          await target.reserveProviderRequest(id, requestId, details)
          requestIds.push(requestId)
        }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as TaskLifecycle
    const executionControl: NonNullable<RoleInvocation['executionControl']> = {
      taskId: run.taskId, routeId: route.routeId, lifecycle, invocationId, attemptId, bounds,
      startedAt: new Date().toISOString(),
      reserveToolCall: async executionId => {
        if (!reservedToolCalls.has(executionId) && reservedToolCalls.size >= bounds.maxToolCalls) throw new RoleInvocationError('benchmark role exceeded its tool call budget', 'NON_FALLBACKABLE', false)
        reservedToolCalls.add(executionId)
        await run.lifecycle.reserveToolCall(attemptId, executionId)
      },
      recordInspection: async () => {},
      checkpoint: async () => {},
      markBodyStart: () => {
        if (bodyCalls >= bounds.maxToolCalls) throw new RoleInvocationError('benchmark role exceeded its tool body budget', 'NON_FALLBACKABLE', false)
        bodyCalls += 1
      },
    }
    const schema = await outputSchema(input.root, input.role, input.testCase.kind === 'review')
    const context = contexts.get(input.root) ?? {}
    const reviewEvidence = input.testCase.kind === 'review'
      ? new GitEvidenceRepository(await createGitSnapshot(input.root, options.reviewTarget(input.testCase)))
      : undefined
    const startedAt = new Date().toISOString()
    const controller = new AbortController()
    try {
      const output = await options.executeRole({
        role: input.role as EngineeringRole, route: effectiveRoute, attemptIndex: 1, root: input.root, taskId: run.taskId,
        request: input.request, state: { state: input.readOnly ? 'REVIEWING' : 'IMPLEMENTING', revision: 0, workRevision: 0, fixAttempts: 0 },
        context: { ...context, benchmark: { caseId: input.testCase.id, kind: input.testCase.kind, criteria: input.testCase.criteria, allowedPaths: input.testCase.allowedPaths, commandProfile: input.testCase.commandProfile, failureInjection: input.testCase.failureInjection }, ...input.context },
        outputSchema: roleResponseSchema(schema.structured), signal: controller.signal, executionControl,
        ...(reviewEvidence === undefined ? {} : { reviewEvidence }),
        ...(!input.readOnly ? { markMutationStarted: () => {} } : {}),
      })
      const result = unwrapRoleResponse(output, schema.validation)
      if (!schema.validate(result)) throw new RoleInvocationError(`benchmark ${input.role} returned invalid output: ${JSON.stringify(schema.validate.errors)}`, 'SCHEMA_INVALID', false)
      context[input.role] = result
      contexts.set(input.root, context)
      if (input.testCase.kind === 'review' && reviewEvidence !== undefined && input.role === 'reviewer') {
        const problems = await validateEngineeringReviewEvidence(result, reviewEvidence, controller.signal)
        if (problems.length > 0) throw new RoleInvocationError(`benchmark review lacks complete evidence: ${problems.join('; ')}`, 'NON_FALLBACKABLE', false)
        await persistReviewResult(input.root, run, result, reviewEvidence)
      }
      const outcome = input.testCase.kind !== 'review' && (input.role === 'challenger' || input.role === 'reviewer') && asRecord(result).decision !== 'ACCEPT' ? 'FAILED' : 'SUCCESS'
      const endedAt = new Date().toISOString()
      await run.lifecycle.settleAttempt(attemptId, { startedAt, endedAt, outcome })
      return { stage: input.stage, startedAt, endedAt, outcome, requestIds }
    } catch (error) {
      if (error instanceof RoleQuiescenceError) {
        run.confirmedStopped = false
        await run.lifecycle.settleAttempt(attemptId, { startedAt, endedAt: new Date().toISOString(), outcome: 'UNCERTAIN' })
      } else await run.lifecycle.settleAttempt(attemptId, { startedAt, endedAt: new Date().toISOString(), outcome: error instanceof CapabilityInsufficientError ? 'CAPABILITY_INSUFFICIENT' : 'FAILED' })
      throw error
    }
  }

  return {
    invoke,
    invokeFixedStage,
    async report(_strategy: EngineeringStrategyId, _testCase: EngineeringBenchmarkCase, cwd: string, receipts: readonly EngineeringStageReceipt[], _context?: EngineeringBenchmarkRunContext): Promise<EngineeringRunEvidence> {
      const run = runs.get(cwd)
      if (run === undefined) return { confirmedStopped: true }
      if (run.confirmedStopped) await run.lifecycle.recordRunState({ state: receipts.every(receipt => receipt.outcome === 'SUCCESS') ? 'COMPLETE' : 'FAILED', at: new Date().toISOString() })
      return { usageReport: await run.lifecycle.usageReport(), confirmedStopped: run.confirmedStopped }
    },
  }
}

async function outputSchema(root: string, role: DirectRole, review: boolean): Promise<{ structured: ObjectJsonSchema; validation: Record<string, unknown>; validate: ReturnType<Ajv['compile']> }> {
  let validation: Record<string, unknown>
  if (review) validation = JSON.parse(JSON.stringify(REVIEW_OUTPUT_SCHEMA))
  else if (role === 'implementer') validation = { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', minLength: 1 } }, required: ['summary'] }
  else if (role === 'challenger') validation = { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', minLength: 1 }, decision: { enum: ['ACCEPT', 'REVISE'] }, findings: { type: 'array', items: { type: 'string', minLength: 1 } } }, required: ['summary', 'decision', 'findings'] }
  else {
    const name = role === 'architect' ? 'plan' : role === 'reviewer' ? 'review' : 'investigation'
    const schema = JSON.parse(await readFile(join(root, '.agent/schemas', `${name}.schema.json`), 'utf8')) as Record<string, unknown>
    const properties = asRecord(schema.properties)
    for (const key of ['schemaVersion', 'taskId', 'taskRevision', 'workRevision']) delete properties[key]
    if (role === 'architect') {
      const bound = JSON.parse(await readFile(join(root, '.agent/schemas/plan-v2.schema.json'), 'utf8')) as Record<string, unknown>
      properties.verificationExtras = asRecord(bound.properties).verificationExtras
    }
    validation = { ...schema, properties, required: (Array.isArray(schema.required) ? schema.required.filter(key => typeof key === 'string' && key !== 'schemaVersion' && key !== 'taskId' && key !== 'taskRevision' && key !== 'workRevision' && key !== 'verificationExtras') : []) }
  }
  const definitions = asRecord(validation.definitions ?? {})
  const structured = structuredSchema(validation, definitions)
  assertObjectJsonSchema(structured)
  const validate = new Ajv({ strict: true, allErrors: true }).compile(validation)
  return { structured, validation, validate }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('benchmark role schema must be an object')
  return Object.fromEntries(Object.entries(value))
}

async function persistReviewResult(root: string, run: DirectRun, output: unknown, evidence: GitEvidenceRepository): Promise<void> {
  const result = asRecord(output)
  const directory = join(root, '.agent', 'reviews', run.taskId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const state = {
    schemaVersion: 1, taskId: run.taskId, state: 'REVIEW_COMPLETE', revision: 1, workRevision: 0, fixAttempts: 0,
    writer: null, updatedAt: new Date().toISOString(),
  }
  const document = {
    schemaVersion: 1, revision: 1, status: 'REVIEW_COMPLETE', taskId: run.taskId,
    snapshot: evidence.snapshot, state,
    summary: typeof result.summary === 'string' ? result.summary : 'Review completed.',
    findings: Array.isArray(result.findings) ? result.findings : [],
    inspectedEvidenceIds: Array.isArray(result.inspectedEvidenceIds) ? result.inspectedEvidenceIds : [],
    evidence: evidence.observedEvidence(),
    unresolvedQuestions: Array.isArray(result.unresolvedQuestions) ? result.unresolvedQuestions : [],
  }
  await writeFileAtomic(join(directory, 'RESULT.json'), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
}

function structuredSchema(value: unknown, definitions: Record<string, unknown>, path = 'schema'): JsonSchemaNode {
  const source = asRecord(value)
  if (typeof source.$ref === 'string') {
    const match = /^#\/definitions\/([^/]+)$/u.exec(source.$ref)
    const name = match?.[1]
    if (name === undefined || definitions[name] === undefined) throw new Error(`${path} has an unsupported local reference`)
    return structuredSchema(definitions[name], definitions, `${path}.$ref`)
  }
  const result: Record<string, unknown> = {}
  for (const key of ['title', 'description', 'default', 'examples']) if (source[key] !== undefined) result[key] = source[key]
  if (Array.isArray(source.oneOf)) result.oneOf = source.oneOf.map((branch, index) => structuredSchema(branch, definitions, `${path}.oneOf.${index}`))
  const enumValues = Array.isArray(source.enum) ? source.enum : undefined
  let type = source.type
  if (type === undefined && enumValues?.length && enumValues.every(item => typeof item === typeof enumValues[0])) type = enumValues[0] === null ? 'null' : typeof enumValues[0]
  if (typeof type === 'string') result.type = type
  if (enumValues !== undefined) result.enum = enumValues
  if (source.const !== undefined) result.const = source.const
  if (type === 'object') {
    const properties = asRecord(source.properties ?? {})
    result.properties = Object.fromEntries(Object.entries(properties).map(([key, item]) => [key, structuredSchema(item, definitions, `${path}.${key}`)]))
    if (Array.isArray(source.required)) result.required = source.required
    if (typeof source.additionalProperties === 'boolean') result.additionalProperties = source.additionalProperties
  }
  if (type === 'array' && source.items !== undefined) result.items = structuredSchema(source.items, definitions, `${path}.items`)
  assertObjectJsonSchema({ type: 'object', properties: { value: result } })
  return result as JsonSchemaNode
}
