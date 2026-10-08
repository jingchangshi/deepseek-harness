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
import { loadEngineeringProject } from './automatic.ts'
import type { EngineeringRole, RoleExecutor, RoleInvocation, EngineeringProject } from './automatic.ts'
import { TaskRepository } from './repository.ts'
import { loadRepositoryVerificationContext } from './identity.ts'
import type { TaskStateRecord } from './types.ts'
import { runCommand, runVerificationProfile, verificationEvidence } from './verification.ts'
import type { EngineeringBenchmarkCase, EngineeringStageReceipt, EngineeringRunEvidence, EngineeringStrategyId, EngineeringBenchmarkRunContext, ProductionBenchmarkRoleInvoker } from './benchmark.ts'
import { createGitSnapshot, GitEvidenceRepository } from './git-evidence.ts'
import type { GitReviewTarget } from './git-evidence.ts'

type DirectRole = 'scout-primary' | 'architect' | 'challenger' | 'implementer' | 'reviewer'

interface DirectRun {
  lifecycle: TaskLifecycle
  taskId: string
  workflow: 'development' | 'review-only'
  started: boolean
  confirmedStopped: boolean
  repository: TaskRepository
  project?: EngineeringProject
  state?: TaskStateRecord
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
  signal?: AbortSignal
}): ProductionBenchmarkRoleInvoker {
  const runs = new Map<string, DirectRun>()
  const contexts = new Map<string, Record<string, unknown>>()
  const getRun = async (root: string, testCase: EngineeringBenchmarkCase): Promise<DirectRun> => {
    options.signal?.throwIfAborted()
    const key = root
    if (!contexts.has(key)) contexts.set(key, {})
    const prior = runs.get(key)
    if (prior !== undefined) return prior
    const workflow = testCase.kind === 'review' ? 'review-only' : 'development'
    const taskId = `benchmark-${createHash('sha256').update(`${testCase.id}\0${root}`).digest('hex').slice(0, 24)}`
    await mkdir(join(root, '.agent', workflow === 'development' ? 'tasks' : 'reviews', taskId), { recursive: true, mode: 0o700 })
    const repository = new TaskRepository(root)
    await repository.init()
    const limits = options.limits ?? options.deployment.workflow.lifecycleBudget
    let state: TaskStateRecord | undefined
    let project: EngineeringProject | undefined
    let lifecycle: TaskLifecycle
    if (workflow === 'development') {
      project = await loadEngineeringProject(root)
      state = await repository.createTask({ schemaVersion: 1, id: taskId, title: testCase.request, profile: project.profile,
        dataClass: project.dataClass, createdAt: new Date().toISOString() })
      lifecycle = await repository.initializeLifecycle(taskId, workflow, limits)
      const head = await runCommand(root, { executable: 'git', args: ['rev-parse', 'HEAD'] }, project.commandTimeoutMs, options.signal)
      const dirty = await runCommand(root, { executable: 'git', args: ['status', '--porcelain', '--', '.', ':(exclude).agent'] }, project.commandTimeoutMs, options.signal)
      if (head.status !== 'PASS' || dirty.status !== 'PASS') throw new Error('cannot capture benchmark Git baseline')
      state = await repository.baseline(taskId, state.revision, { repositoryHead: head.stdout.trim(), dirty: dirty.stdout.trim().length > 0, summary: testCase.request })
    } else {
      lifecycle = new FileTaskLifecycle(root, taskId, workflow, limits, () => new Date().toISOString(), 0, false)
      await lifecycle.initialize()
    }
    const run: DirectRun = { lifecycle, taskId, workflow, started: false, confirmedStopped: true, repository,
      ...(state === undefined ? {} : { state }), ...(project === undefined ? {} : { project }) }
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
      const run = await getRun(input.root, input.testCase)
      if (!run.confirmedStopped) throw new Error('benchmark writer quiescence is uncertain; confirm stopped work before dispatch')
      let passed: boolean
      if (run.workflow === 'review-only') passed = await options.verify(input.testCase, input.root)
      else {
        if (run.state?.state !== 'VERIFYING' || run.project === undefined) throw new Error('benchmark verification requires a completed writer')
        const snapshot = await run.repository.verificationExecutionContext(run.taskId)
        const assertCurrent = async (): Promise<void> => {
          options.signal?.throwIfAborted()
          await run.repository.assertVerificationExecutionContext(run.taskId, snapshot)
          options.signal?.throwIfAborted()
        }
        const execution = await runVerificationProfile(input.root, run.project.profile, snapshot.config, options.signal,
          snapshot.gates, snapshot.arguments, snapshot.identity, assertCurrent)
        if (execution.results.some(({ result }) => result.quiescence === 'UNCERTAIN')) {
          run.confirmedStopped = false
          throw new RoleQuiescenceError('benchmark verification termination is uncertain')
        }
        await assertCurrent()
        await run.repository.appendEvidence(run.taskId, run.state.workRevision, verificationEvidence(input.root, execution), run.state.revision)
        run.state = await run.repository.finishVerification(run.taskId, run.state.revision, execution.verification)
        contexts.get(input.root)!.verification = JSON.parse(await readFile(join(input.root, '.agent/tasks', run.taskId, 'VERIFY.json'), 'utf8'))
        passed = execution.verification.status === 'PASS'
      }
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
    if (!run.confirmedStopped) throw new Error('benchmark writer quiescence is uncertain; confirm stopped work before dispatch')
    await run.repository.assertDispatchAdmission(run.taskId)
    if (run.workflow === 'development' && input.role === 'reviewer' && run.state?.state !== 'VERIFIED') {
      throw new Error('benchmark Reviewer requires successful verification')
    }
    if (run.workflow === 'development' && input.role === 'reviewer') await run.repository.verificationGates(run.taskId)
    if (!run.started) {
      await run.lifecycle.recordRunState({ state: 'RUNNING', at: new Date().toISOString() })
      run.started = true
    }
    const schema = await outputSchema(input.root, input.role, input.testCase.kind === 'review')
    const context = contexts.get(input.root) ?? {}
    const reviewEvidence = input.testCase.kind === 'review'
      ? new GitEvidenceRepository(await createGitSnapshot(input.root, options.reviewTarget(input.testCase)))
      : undefined
    if (run.workflow === 'development') {
      const verification = await loadRepositoryVerificationContext(input.root, run.project!.profile)
      context.verificationPolicy = verification.policy
      context.verificationInstances = verification.gates
      context.verificationCommands = verification.verificationConfig
      context.acceptanceTier = verification.tier
    }
    const bounds = options.deployment.workflow.roleBounds[input.role]
    if (bounds === undefined) throw new Error(`benchmark role ${input.role} has no configured execution bounds`)
    const invocationId = await run.lifecycle.reserveInvocation(input.role)
    const attemptId = await run.lifecycle.reserveAttempt(invocationId, effectiveRoute)
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
    const startedAt = new Date().toISOString()
    const controller = new AbortController()
    const signal = options.signal ?? controller.signal
    let ownedWriterToken: string | undefined
    try {
      signal.throwIfAborted()
      if (run.workflow === 'development' && input.role === 'implementer') {
        await prepareWriter(run, input.root, input.testCase)
        ownedWriterToken = run.state?.writer?.token
      }
      const output = await options.executeRole({
        role: input.role as EngineeringRole, route: effectiveRoute, attemptIndex: 1, root: input.root, taskId: run.taskId,
        request: input.request, state: run.state === undefined
          ? { state: 'REVIEWING', revision: 0, workRevision: 0, fixAttempts: 0 }
          : { state: run.state.state, revision: run.state.revision, workRevision: run.state.workRevision, fixAttempts: run.state.fixAttempts },
        context: { ...context, benchmark: { caseId: input.testCase.id, kind: input.testCase.kind, criteria: input.testCase.criteria, allowedPaths: input.testCase.allowedPaths, commandProfile: input.testCase.commandProfile, failureInjection: input.testCase.failureInjection }, ...input.context },
        outputSchema: roleResponseSchema(schema.structured), signal, executionControl,
        ...(reviewEvidence === undefined ? {} : { reviewEvidence }),
        ...(!input.readOnly ? { markMutationStarted: () => {} } : {}),
      })
      signal.throwIfAborted()
      const result = unwrapRoleResponse(output, schema.validation)
      if (!schema.validate(result)) throw new RoleInvocationError(`benchmark ${input.role} returned invalid output: ${JSON.stringify(schema.validate.errors)}`, 'SCHEMA_INVALID', false)
      context[input.role] = result
      contexts.set(input.root, context)
      if (run.workflow === 'development' && run.state !== undefined) {
        if (input.role === 'scout-primary') {
          run.state = await run.repository.investigate(run.taskId, run.state.revision, asRecord(result))
        } else if (input.role === 'architect') context.candidatePlan = result
        else if (input.role === 'challenger' && asRecord(result).decision === 'ACCEPT') {
          run.state = await run.repository.freezePlan(run.taskId, run.state.revision, asRecord(context.candidatePlan))
          context.plan = JSON.parse(await readFile(join(input.root, '.agent/tasks', run.taskId, 'PLAN.json'), 'utf8'))
        } else if (input.role === 'implementer') {
          const token = run.state.writer?.token
          if (token === undefined) throw new Error('benchmark implementation has no writer lease')
          run.state = await run.repository.beginVerification(run.taskId, run.state.revision, token)
        }
      }
      if (input.testCase.kind === 'review' && reviewEvidence !== undefined && input.role === 'reviewer') {
        const problems = await validateEngineeringReviewEvidence(result, reviewEvidence, signal)
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
      } else {
        if (input.role === 'implementer' && ownedWriterToken !== undefined && run.state?.writer?.token === ownedWriterToken) {
          run.state = await run.repository.releaseImplementation(run.taskId, run.state.revision, ownedWriterToken)
        }
        await run.lifecycle.settleAttempt(attemptId, { startedAt, endedAt: new Date().toISOString(), outcome: error instanceof CapabilityInsufficientError ? 'CAPABILITY_INSUFFICIENT' : 'FAILED' })
      }
      throw error
    }
  }

  async function prepareWriter(run: DirectRun, root: string, testCase: EngineeringBenchmarkCase): Promise<void> {
    let state = run.state
    if (state === undefined) throw new Error('benchmark development task has no state')
    const context = contexts.get(root)!
    if (state.state === 'BASELINED') {
      state = await run.repository.investigate(run.taskId, state.revision, {
        findings: ['Explicit evaluation-owned scope and acceptance criteria; source investigation was not requested.'],
        hypotheses: [], unresolvedAssumptions: [],
      })
      const { gates } = await loadRepositoryVerificationContext(root, run.project!.profile)
      state = await run.repository.freezePlan(run.taskId, state.revision, {
        problemStatement: testCase.request, hypotheses: ['Explicit acceptance criteria define the requested result.'],
        selectedApproach: `Implement only the declared files: ${testCase.allowedPaths.join(', ')}`,
        rejectedAlternatives: ['Modify undeclared files'], invariants: ['Preserve all files outside the declared scope'],
        expectedComponents: testCase.allowedPaths, implementationScope: testCase.allowedPaths,
        falsificationTests: [testCase.criteria], acceptanceGates: gates.filter(gate => gate.required).map(gate => gate.name),
        unresolvedAssumptions: [],
      })
      context.plan = JSON.parse(await readFile(join(root, '.agent/tasks', run.taskId, 'PLAN.json'), 'utf8'))
    }
    if (state.state !== 'PLAN_FROZEN' && state.state !== 'IMPLEMENTING') throw new Error('benchmark writer requires an accepted frozen plan')
    run.state = state
    run.state = await run.repository.startImplementation(run.taskId, state.revision)
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
