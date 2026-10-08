/** Durable engineering workflow with fixed role dispatch and command-owned acceptance. */

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, readdir, realpath, lstat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { load } from 'js-yaml'
import Ajv from 'ajv'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { assertObjectJsonSchema, type JsonSchemaNode, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { assertRouteDispatchAllowed, resolveRoleAttempts, resolveRoleEscalations } from './config.ts'
import type { HarnessConfig, ResolvedRoleRoute, RoleBounds } from './config.ts'
import { BudgetExhaustedError } from './lifecycle.ts'
import type { TaskLifecycle, EngineeringInvocationId, EngineeringAttemptId } from './lifecycle.ts'
import { captureInvestigationDependencies, investigationPath, investigationScopeDigest } from './investigation.ts'
import type { InvestigationUnit, InspectionReceipt, InvestigationCheckpoint } from './investigation.ts'
import { PlanAssumptionBlocker, TaskRepository } from './repository.ts'
import { loadRepositoryKnowledge } from './knowledge.ts'
import { loadRepositoryVerificationContext } from './identity.ts'
import type { RepositoryKnowledge } from './knowledge.ts'
import { loadVerificationProfile, runCommand, runVerificationProfile, validateVerificationProfileId, verificationEvidence } from './verification.ts'
import type { TaskDocument, TaskStateRecord } from './types.ts'
import type { ReviewStateRecord, ReviewTaskDocument } from './review-types.ts'
import type { GitEvidenceRepository } from './git-evidence.ts'
import { taskRequiresStopConfirmation } from './state-machine.ts'
import { CapabilityInsufficientError, RoleInvocationError, RoleQuiescenceError, isAbortError, runRoleAttempts } from './role-execution.ts'
import type { RoleAttemptRecord } from './role-execution.ts'
import { roleResponseSchema, unwrapRoleResponse } from './role-response.ts'
import { classifyEngineeringTask, TaskSchedulingRepository } from './scheduling.ts'
import type { SchedulingPolicy, TaskClassification, DiagnosisOutput, DiagnosisObligation, SchedulingEscalationId } from './scheduling.ts'
import { isLiveWriterLockTimeout } from './run-lock.ts'

const execute = promisify(execFile)

/** Target-owned workflow settings; commandTimeoutMs applies only to baseline Git commands. */
export interface EngineeringProject {
  schemaVersion: 1
  profile: TaskDocument['profile']
  adapter: string
  dataClass: TaskDocument['dataClass']
  maxSteps: number
  maxRoleCalls: number
  commandTimeoutMs: number
  scheduling?: SchedulingPolicy
  knowledgeFile?: string
  knowledge?: RepositoryKnowledge
  /** Explicit bounded questions; omitted scope is generated from tracked source files. */
  investigationUnits?: Array<Pick<InvestigationUnit, 'id' | 'role' | 'question' | 'allowedPaths'>>
}

/** Trusted accounting and actual inspection callbacks, excluded from model input. */
export interface RoleExecutionControl {
  taskId: string
  routeId: string
  lifecycle: TaskLifecycle
  invocationId: EngineeringInvocationId
  attemptId: EngineeringAttemptId
  bounds: RoleBounds
  startedAt: string
  reserveToolCall: (executionId: string) => Promise<void>
  recordInspection: (receipt: InspectionReceipt) => Promise<void>
  checkpoint: () => Promise<void>
  /** Synchronous final body barrier; retries consume the same logical tool allowance. */
  markBodyStart: () => void
}

/** Model roles admitted by the automatic driver. */
export type EngineeringRole = 'scout-primary' | 'scout-secondary' | 'architect' | 'challenger' | 'implementer' | 'reviewer'

/** One isolated role request; no repository-owned writer token is exposed. */
export interface RoleInvocation {
  role: EngineeringRole
  route: ResolvedRoleRoute
  attemptIndex: number
  root: string
  taskId: string
  request: string
  state: Pick<TaskStateRecord | ReviewStateRecord, 'state' | 'revision' | 'workRevision' | 'fixAttempts'>
  context: Record<string, unknown>
  outputSchema: ObjectJsonSchema
  signal: AbortSignal
  /** Executors call this before dispatching any tool that may mutate project or external state. */
  markMutationStarted?: () => void
  /** Trusted Git query owner for a Review-only child; excluded from model prompt serialization. */
  reviewEvidence?: GitEvidenceRepository
  /** Structured read-only investigation assignment. */
  workUnit?: InvestigationUnit
  /** Process-local accounting authority; never serialized into a role prompt. */
  executionControl?: RoleExecutionControl
}

/** Executors must settle only after their agent and its owned writes have stopped, including cancellation. */
export type RoleExecutor = (invocation: RoleInvocation) => Promise<unknown>

/** A settled role failure that requires explicit operator recovery before another dispatch. */
export class EngineeringRoleFailure extends Error {
  /** Create a workflow-blocking role failure with a model-safe diagnostic. */
  constructor(message: string) {
    super(message)
    this.name = 'EngineeringRoleFailure'
  }
}

/** Inputs to one bounded run; deployment must be the snapshot used by the role executor's providers. */
export interface EngineeringRunOptions {
  root: string
  deployment: HarnessConfig
  request: string
  taskId?: string
  executeRole: RoleExecutor
  signal?: AbortSignal
  onTaskSelected?: (taskId: string) => Promise<void>
  onProgress?: (state: TaskStateRecord) => void
}

/** Authoritative state and the identifier needed for subsequent resumption. */
export interface EngineeringRunResult {
  status: 'ACCEPTED' | 'BLOCKED' | 'BUDGET_EXHAUSTED' | 'RUN_ALREADY_ACTIVE'
  taskId: string
  state?: TaskStateRecord
  summary: string
  nextAction: EngineeringNextAction
  requiresStopConfirmation?: boolean
}

/** Actionable instruction for the Coordinator after one `engineering_run` result. */
export type EngineeringNextAction =
  | 'NONE'
  | 'RESUME'
  | 'RECOVER'
  | 'REPLAN_WITH_SCOPE'
  | 'WAIT_FOR_CURRENT_RUN'
  | 'INCREASE_BUDGET'

/** Read-only task listing used for status and explicit resumption choices. */
export interface EngineeringStatus {
  tasks: Array<{ task: TaskDocument; state: TaskStateRecord }>
  pendingTasks: TaskDocument[]
  /** Review-only tasks, present when at least one selected review exists. */
  reviews?: Array<{ task: ReviewTaskDocument; state: ReviewStateRecord }>
}

interface Journal {
  schemaVersion: 1
  requests: string[]
  steps: number
  roleCalls: number
  completedWriterRevision: number | null
  pendingTask: TaskDocument | null
  verifiedTreeHash: string | null
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return Object.fromEntries(Object.entries(value))
}

function positive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

function nextActionForState(state: TaskStateRecord): { nextAction: EngineeringNextAction; requiresStopConfirmation: boolean } {
  if (state.state === 'ACCEPTED') return { nextAction: 'NONE', requiresStopConfirmation: false }
  if (taskRequiresStopConfirmation(state)) return { nextAction: 'RECOVER', requiresStopConfirmation: true }
  if (state.state === 'BUDGET_EXHAUSTED') return { nextAction: 'INCREASE_BUDGET', requiresStopConfirmation: false }
  if (state.state !== 'BLOCKED') return { nextAction: 'RESUME', requiresStopConfirmation: false }
  const blocker = state.blocker ?? ''
  if (/unresolved plan assumption|product scope|product decision|missing product|scope information/i.test(blocker)) {
    return { nextAction: 'REPLAN_WITH_SCOPE', requiresStopConfirmation: false }
  }
  return { nextAction: 'RECOVER', requiresStopConfirmation: taskRequiresStopConfirmation(state) }
}

function resultForState(taskId: string, state: TaskStateRecord): EngineeringRunResult {
  if (state.state !== 'ACCEPTED' && state.state !== 'BLOCKED' && state.state !== 'BUDGET_EXHAUSTED') {
    throw new Error(`task ${taskId} cannot return a run result from ${state.state}`)
  }
  const action = nextActionForState(state)
  return {
    taskId,
    state,
    status: state.state === 'ACCEPTED' ? 'ACCEPTED' : state.state === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXHAUSTED' : 'BLOCKED',
    summary: state.state === 'ACCEPTED' ? 'Required verification and independent review passed.' : state.blocker ?? 'Task blocked.',
    nextAction: action.nextAction,
    requiresStopConfirmation: action.requiresStopConfirmation,
  }
}

async function optionalJson(path: string): Promise<unknown> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(source)
}

/**
 * Materialize oversized role context as a hashed, readable workflow artifact.
 * @param directory - owning task artifact directory.
 * @param role - context reader and artifact name.
 * @param context - relevant current facts, without process-local controls.
 * @param maxBytes - configured maximum serialized context size.
 * @returns the inline context or an exact file reference; throws if the reference exceeds the limit.
 */
export async function boundedContext(directory: string, role: EngineeringRole, context: Record<string, unknown>, maxBytes: number): Promise<Record<string, unknown>> {
  const source = JSON.stringify(context)
  if (Buffer.byteLength(source) <= maxBytes) return context
  const digest = createHash('sha256').update(source).digest('hex')
  const path = join(directory, `CONTEXT-${role}-${digest}.json`)
  await writeFileAtomic(path, `${source}\n`, { mode: 0o600 })
  const result = { contextReference: { path, sha256: digest, bytes: Buffer.byteLength(source), instruction: 'Read the relevant fields from this workflow-owned context file; do not infer omitted facts.' } }
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new Error('maxRoleContextBytes is too small for a context reference')
  return result
}

/**
 * Preserve oversized task requirements in a referenced workflow artifact.
 * @param directory - owning task artifact directory.
 * @param request - complete requirement and scope clarifications.
 * @param maxBytes - configured maximum inline requirement size.
 * @returns inline text or a hashed request file reference.
 */
export async function boundedRequest(directory: string, request: string, maxBytes: number): Promise<string> {
  if (Buffer.byteLength(request) <= maxBytes) return request
  const digest = createHash('sha256').update(request).digest('hex')
  const path = join(directory, `REQUEST-${digest}.json`)
  await writeFileAtomic(path, `${JSON.stringify({ request })}\n`, { mode: 0o600 })
  const reference = `Read the complete task requirement from ${path}. Its request text SHA-256 is ${digest}. Apply all stated acceptance criteria; do not infer omitted requirements.`
  if (Buffer.byteLength(reference) > maxBytes) throw new Error('maxRoleContextBytes is too small for a task request reference')
  return reference
}

async function investigationUnits(root: string, project: EngineeringProject, config: HarnessConfig): Promise<InvestigationUnit[]> {
  if (project.investigationUnits !== undefined) return project.investigationUnits.map(unit => ({ ...unit, ...config.workflow.roleBounds[unit.role]!, evidenceFormat: 'inspection-receipts' }))
  const { stdout } = await execute('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', timeout: project.commandTimeoutMs, maxBuffer: config.workflow.reviewGitMaxOutputBytes })
  const paths = stdout.split('\0').filter(path => path && !path.split('/').some(part => part === '.agent' || part === '.git'))
  const maximum = config.workflow.maxInvestigationPaths
  if (paths.length > maximum * 2) throw new EngineeringRoleFailure(`Investigation requires explicit partitioned questions: ${paths.length} tracked files exceed the ${maximum * 2}-file automatic scope limit. Configure project.investigationUnits for the relevant source paths.`)
  return (['scout-primary', 'scout-secondary'] as const).map((role, index) => ({
    id: role, role, question: 'Inspect only this assigned source partition for the task requirement. Identify concrete dependencies and unresolved questions.',
    allowedPaths: paths.filter((_path, pathIndex) => pathIndex % 2 === index), ...config.workflow.roleBounds[role]!, evidenceFormat: 'inspection-receipts',
  }))
}

async function worktreeHash(root: string): Promise<string> {
  const options = { cwd: root, encoding: 'buffer' as const, maxBuffer: 64 * 1024 * 1024 }
  const [{ stdout: head }, { stdout: diff }, { stdout: names }] = await Promise.all([
    execute('git', ['rev-parse', 'HEAD'], options),
    execute('git', ['diff', '--binary', '--no-ext-diff', 'HEAD', '--', '.', ':(exclude).agent'], options),
    execute('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude).agent'], options),
  ])
  const digest = createHash('sha256').update(head).update('\0').update(diff)
  const paths = names.toString('utf8').split('\0').filter(Boolean).sort()
  for (const path of paths) digest.update('\0').update(path).update('\0').update(await readFile(resolve(root, path)))
  return digest.digest('hex')
}

/**
 * Load the project-owned automatic workflow settings and reject paths escaping the project.
 * @param root - project root containing `.agent/config/project.yaml`.
 * @returns validated settings, registered verification profile, absolute adapter filename, and optional repository knowledge catalog.
 */
export async function loadEngineeringProject(root: string): Promise<EngineeringProject> {
  const source = object(load(await readFile(join(root, '.agent/config/project.yaml'), 'utf8')), 'project.yaml')
  if (source.schemaVersion !== 1) throw new Error('project.yaml schemaVersion must be 1')
  const profile = validateVerificationProfileId(source.profile)
  await loadVerificationProfile(root, profile)
  const dataClass = source.dataClass
  if (dataClass !== 'public' && dataClass !== 'internal' && dataClass !== 'sensitive') throw new Error('invalid project dataClass')
  if (typeof source.adapter !== 'string' || !source.adapter) throw new Error('project adapter is required')
  const adapter = await realpath(resolve(root, source.adapter))
  const target = relative(await realpath(root), adapter)
  if (isAbsolute(target) || target === '..' || target.startsWith('../') || target.startsWith('..\\')) throw new Error('project adapter must stay inside the project')
  if (source.knowledge !== undefined && typeof source.knowledge !== 'string') throw new Error('project knowledge must be a repository-relative filename')
  const knowledge = source.knowledge === undefined ? {} : { knowledgeFile: source.knowledge, knowledge: await loadRepositoryKnowledge(root, source.knowledge) }
  let investigationUnits: EngineeringProject['investigationUnits']
  if (source.investigationUnits !== undefined) {
    if (!Array.isArray(source.investigationUnits) || source.investigationUnits.length === 0 || source.investigationUnits.length > 2) throw new Error('investigationUnits must contain one or two disjoint Scout questions')
    investigationUnits = source.investigationUnits.map(raw => {
      const unit = object(raw, 'investigation unit')
      if (typeof unit.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(unit.id) || typeof unit.question !== 'string' || !unit.question.trim()
        || unit.role !== 'scout-primary' && unit.role !== 'scout-secondary' || !Array.isArray(unit.allowedPaths)
        || unit.allowedPaths.length === 0 || !unit.allowedPaths.every(path => typeof path === 'string')) throw new Error('invalid investigation unit')
      return { id: unit.id, role: unit.role, question: unit.question, allowedPaths: unit.allowedPaths.map(investigationPath) }
    })
    if (new Set(investigationUnits.map(unit => unit.id)).size !== investigationUnits.length || new Set(investigationUnits.map(unit => unit.role)).size !== investigationUnits.length) throw new Error('investigation unit IDs and Scout roles must be distinct')
    const first = investigationUnits[0]!
    const second = investigationUnits[1]
    if (second !== undefined && first.allowedPaths.some(a => second.allowedPaths.some(b => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)))) throw new Error('investigation unit code scopes overlap')
  }
  return {
    schemaVersion: 1, profile, adapter, dataClass,
    maxSteps: positive(source.maxSteps, 'maxSteps'),
    maxRoleCalls: positive(source.maxRoleCalls, 'maxRoleCalls'),
    commandTimeoutMs: positive(source.commandTimeoutMs, 'commandTimeoutMs'),
    ...knowledge,
    ...(source.scheduling === undefined ? {} : { scheduling: parseSchedulingPolicy(source.scheduling) }),
    ...(investigationUnits === undefined ? {} : { investigationUnits }),
  }
}

function parseSchedulingPolicy(value: unknown): SchedulingPolicy {
  const source = object(value, 'scheduling')
  if (!['auto', 'simple', 'standard', 'complex'].includes(String(source.class))) throw new Error('invalid scheduling class')
  for (const key of ['scopePaths', 'acceptanceCriteria', 'risks']) {
    if (!Array.isArray(source[key]) || !source[key].every(item => typeof item === 'string' && item.trim())) throw new Error(`invalid scheduling ${key}`)
  }
  for (const key of ['needsInvestigation', 'needsChallenge']) if (typeof source[key] !== 'boolean') throw new Error(`invalid scheduling ${key}`)
  return {
    class: source.class as SchedulingPolicy['class'], scopePaths: (source.scopePaths as string[]).map(investigationPath),
    acceptanceCriteria: source.acceptanceCriteria as string[], risks: source.risks as string[],
    needsInvestigation: source.needsInvestigation as boolean, needsChallenge: source.needsChallenge as boolean,
  }
}

async function changedSourcePaths(root: string): Promise<string[]> {
  const options = { cwd: root, encoding: 'utf8' as const, maxBuffer: 64 * 1024 * 1024 }
  const [changed, untracked] = await Promise.all([
    execute('git', ['diff', '--name-only', '-z', 'HEAD', '--', '.', ':(exclude).agent'], options),
    execute('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude).agent'], options),
  ])
  return [...new Set(`${changed.stdout}\0${untracked.stdout}`.split('\0').filter(Boolean))].sort()
}

function projectDiagnosticSchema(): ObjectJsonSchema {
  return { type: 'object', additionalProperties: false, required: ['summary', 'observations', 'recommendation', 'repairConstraints', 'unresolvedQuestions'], properties: {
    summary: { type: 'string' }, observations: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string', enum: ['REPAIR_WITHIN_PLAN', 'REPLAN'] },
    repairConstraints: { type: 'array', items: { type: 'string' } }, unresolvedQuestions: { type: 'array', items: { type: 'string' } },
  } }
}

function parseDiagnosis(value: unknown): DiagnosisOutput {
  const validate = new Ajv({ strict: true }).compile<DiagnosisOutput>(projectDiagnosticSchema())
  if (!validate(value)) throw new EngineeringRoleFailure('Invalid dedicated diagnosis result')
  return value
}

async function classifyProject(root: string, project: EngineeringProject, request: string, config: HarnessConfig, previous?: TaskClassification): Promise<TaskClassification> {
  let invalidScope = false
  for (const path of project.scheduling?.scopePaths ?? []) {
    const target = resolve(root, path)
    try {
      const info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target) invalidScope = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { if (await realpath(resolve(target, '..')) !== resolve(target, '..')) invalidScope = true }
      catch { invalidScope = true /* Unresolved parents cannot authorize a file-only task. */ }
    }
  }
  const baselineDirty = (await changedSourcePaths(root)).length > 0
  const result = classifyEngineeringTask({ request, profile: project.profile, policy: project.scheduling, baselineDirty, previous }, { simpleMaxFiles: config.workflow.simpleMaxFiles, standardMaxFiles: config.workflow.standardMaxFiles })
  if (invalidScope && result.taskClass === 'simple') return { ...result, taskClass: 'standard', reasons: [...result.reasons, 'NON_CANONICAL_FILE_SCOPE'], needsInvestigation: true }
  return result
}

function structuredSchema(value: unknown, definitions: Record<string, unknown>, path = 'schema'): JsonSchemaNode {
  const source = object(value, path)
  if (typeof source.$ref === 'string') {
    const match = /^#\/definitions\/([^/]+)$/u.exec(source.$ref)
    const name = match?.[1]
    if (name === undefined || definitions[name] === undefined) throw new Error(`${path} has an unsupported or missing local reference`)
    return structuredSchema(definitions[name], definitions, `${path}.$ref`)
  }
  const result: Record<string, unknown> = {}
  for (const annotation of ['title', 'description', 'default', 'examples']) {
    if (source[annotation] !== undefined) result[annotation] = source[annotation]
  }
  if (Array.isArray(source.oneOf)) result.oneOf = source.oneOf.map((branch, index) => structuredSchema(branch, definitions, `${path}.oneOf.${index}`))
  const enumValues = Array.isArray(source.enum) ? source.enum : undefined
  let type = source.type
  if (type === undefined && enumValues !== undefined && enumValues.length > 0 && enumValues.every(item => typeof item === typeof enumValues[0])) {
    type = enumValues[0] === null ? 'null' : typeof enumValues[0]
  }
  if (typeof type === 'string') result.type = type
  if (enumValues !== undefined) result.enum = enumValues
  if (source.const !== undefined) result.const = source.const
  if (type === 'object') {
    const properties = source.properties === undefined ? {} : object(source.properties, `${path}.properties`)
    result.properties = Object.fromEntries(Object.entries(properties).map(([name, schema]) => [name, structuredSchema(schema, definitions, `${path}.properties.${name}`)]))
    if (Array.isArray(source.required)) result.required = source.required
    if (typeof source.additionalProperties === 'boolean') result.additionalProperties = source.additionalProperties
  }
  if (type === 'array' && source.items !== undefined) result.items = structuredSchema(source.items, definitions, `${path}.items`)
  assertObjectJsonSchema({ type: 'object', properties: { value: result } })
  return result
}

async function outputSchemas(root: string, role: EngineeringRole): Promise<{ structured: ObjectJsonSchema; validation: Record<string, unknown> }> {
  let validation: Record<string, unknown>
  if (role === 'implementer' || role === 'challenger') {
    const properties: Record<string, object> = { summary: { type: 'string', minLength: 1 } }
    if (role === 'challenger') {
      properties.decision = { enum: ['ACCEPT', 'REVISE'] }
      properties.findings = { type: 'array', items: { type: 'string', minLength: 1 } }
    }
    validation = { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) }
  } else {
    const name = role === 'architect' ? 'plan' : role === 'reviewer' ? 'review' : 'investigation'
    const schema = object(JSON.parse(await readFile(join(root, '.agent/schemas', `${name}.schema.json`), 'utf8')), 'schema')
    const properties = object(schema.properties, 'properties')
    const identity = ['schemaVersion', 'taskId', 'taskRevision', 'workRevision']
    for (const name of identity) delete properties[name]
    if (role === 'architect') {
      const bound = object(JSON.parse(await readFile(join(root, '.agent/schemas/plan-v2.schema.json'), 'utf8')), 'bound plan schema')
      properties.verificationExtras = object(bound.properties, 'bound plan properties').verificationExtras
    }
    delete schema.$id
    validation = { ...schema, properties, required: Object.keys(properties).filter(name => name !== 'blocker' && name !== 'verificationExtras') }
  }
  const definitions = validation.definitions === undefined ? {} : object(validation.definitions, 'schema.definitions')
  const projected = structuredSchema(validation, definitions)
  assertObjectJsonSchema(projected)
  return { structured: roleResponseSchema(projected), validation }
}

async function selectTask(root: string, repository: TaskRepository, taskId?: string): Promise<string | undefined> {
  if (taskId !== undefined) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(taskId)) throw new Error('invalid task ID')
    return taskId
  }
  const candidates: string[] = []
  for (const directory of await readdir(join(root, '.agent/tasks'), { withFileTypes: true })) {
    if (!directory.isDirectory()) continue
    const source = await optionalJson(join(root, '.agent/tasks', directory.name, 'AUTO.json'))
    if (source === undefined) continue
    const journal = journalFrom(source)
    if (journal.pendingTask !== null && await optionalJson(join(root, '.agent/tasks', directory.name, 'STATE.json')) === undefined) {
      candidates.push(directory.name)
    } else if ((await repository.readState(directory.name)).state !== 'ACCEPTED') candidates.push(directory.name)
  }
  if (candidates.length > 1) throw new Error(`multiple unfinished engineering tasks; select taskId: ${candidates.join(', ')}`)
  return candidates[0]
}

function journalFrom(value: unknown): Journal {
  const journal = object(value, 'AUTO.json')
  if (journal.schemaVersion !== 1 || !Array.isArray(journal.requests) || !journal.requests.every(value => typeof value === 'string')) throw new Error('invalid AUTO.json requests')
  for (const name of ['steps', 'roleCalls']) if (typeof journal[name] !== 'number' || !Number.isSafeInteger(journal[name]) || journal[name] < 0) throw new Error(`invalid AUTO.json ${name}`)
  const completed = journal.completedWriterRevision
  if (completed !== null && (typeof completed !== 'number' || !Number.isSafeInteger(completed) || completed < 0)) throw new Error('invalid AUTO.json writer checkpoint')
  const verifiedTreeHash = journal.verifiedTreeHash ?? null
  if (verifiedTreeHash !== null && (typeof verifiedTreeHash !== 'string' || !/^[a-f0-9]{64}$/.test(verifiedTreeHash))) throw new Error('invalid AUTO.json verified tree hash')
  let pendingTask: TaskDocument | null = null
  if (journal.pendingTask !== undefined && journal.pendingTask !== null) {
    const task = object(journal.pendingTask, 'AUTO.json pendingTask')
    if (task.schemaVersion !== 1 || typeof task.id !== 'string' || typeof task.title !== 'string' || typeof task.createdAt !== 'string'
      || (task.dataClass !== 'public' && task.dataClass !== 'internal' && task.dataClass !== 'sensitive')) throw new Error('invalid AUTO.json pendingTask')
    pendingTask = { schemaVersion: 1, id: task.id, title: task.title, createdAt: task.createdAt, profile: validateVerificationProfileId(task.profile), dataClass: task.dataClass }
  }
  return { schemaVersion: 1, requests: journal.requests, steps: Number(journal.steps), roleCalls: Number(journal.roleCalls), completedWriterRevision: completed, pendingTask, verifiedTreeHash }
}

/**
 * Persist one logical role invocation's attempt records outside the command
 * evidence chain. Read-only roles run before the first work revision, so their
 * records cannot satisfy the `command` evidence schema's `workRevision >= 1`
 * constraint.
 * @param root - project root.
 * @param taskId - task whose role invocation produced the records.
 * @param role - logical role whose invocation produced the records.
 * @param records - bounded primary/fallback attempt records.
 */
async function appendRoleAttempts(root: string, taskId: string, role: EngineeringRole, records: RoleAttemptRecord[]): Promise<void> {
  if (records.length === 0) return
  const filename = join(root, '.agent', 'tasks', taskId, `ROUTE_ATTEMPTS.${role}.jsonl`)
  let existing = ''
  try {
    existing = await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const lines = records.map(record => JSON.stringify({ schemaVersion: 1, ...record }))
  await writeFileAtomic(filename, `${existing}${lines.join('\n')}\n`, { mode: 0o600 })
}

/**
 * Read automatic task states without advancing a workflow.
 * @param root - project root.
 * @param taskId - optional exact task selection.
 * @returns durable metadata and state for each matching automatic task.
 */
export async function getEngineeringStatus(root: string, taskId?: string): Promise<EngineeringStatus> {
  if (taskId !== undefined && !/^[a-z0-9][a-z0-9._-]*$/.test(taskId)) throw new Error('invalid task ID')
  const repository = new TaskRepository(root)
  const tasks: EngineeringStatus['tasks'] = []
  const pendingTasks: TaskDocument[] = []
  const reviews: NonNullable<EngineeringStatus['reviews']> = []
  let reviewEntries: string[] = []
  try {
    reviewEntries = await readdir(join(root, '.agent/reviews'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const id of taskId === undefined ? reviewEntries : reviewEntries.filter(id => id === taskId)) {
    reviews.push({ task: await repository.readReview(id), state: await repository.readReviewState(id) })
  }
  const result = (): EngineeringStatus => ({ tasks, pendingTasks, ...reviews.length === 0 ? {} : { reviews } })
  let entries: string[]
  try {
    entries = await readdir(join(root, '.agent/tasks'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result()
    throw error
  }
  for (const id of taskId === undefined ? entries : [taskId]) {
    const source = await optionalJson(join(root, '.agent/tasks', id, 'AUTO.json'))
    if (source === undefined) continue
    const journal = journalFrom(source)
    if (journal.pendingTask !== null && await optionalJson(join(root, '.agent/tasks', id, 'STATE.json')) === undefined) {
      pendingTasks.push(journal.pendingTask)
      continue
    }
    tasks.push({ task: await repository.readTask(id), state: await repository.readState(id) })
  }
  return result()
}

/**
 * Recover an interrupted task without renewing its cumulative lifecycle allowance.
 * @param root - project root.
 * @param taskId - exact interrupted task.
 * @param confirmedStopped - explicit confirmation when the current durable state may still own agent or command work.
 * @returns the task state after releasing any writer, entering REPLAN, and clearing execution and verification checkpoints.
 */
export async function recoverEngineeringTask(root: string, taskId: string, confirmedStopped: boolean): Promise<TaskStateRecord | ReviewStateRecord> {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(taskId)) throw new Error('invalid task ID')
  const canonical = await realpath(root)
  if (await optionalJson(join(canonical, '.agent/reviews', taskId, 'TASK.json')) !== undefined) {
    return withFileLock(join(canonical, '.agent/AUTO_RUN'), async () => {
      const repository = new TaskRepository(canonical)
      const state = await repository.readReviewState(taskId)
      if (state.requiresStopConfirmation && !confirmedStopped) throw new Error('Review recovery requires confirmed stopped work')
      const directory = join(canonical, '.agent/reviews', taskId)
      if (await optionalJson(join(directory, 'SCHEDULING.json')) !== undefined || await optionalJson(join(directory, 'SCHEDULING.MARKER.json')) !== undefined) {
        await new TaskSchedulingRepository(canonical, taskId, 'review-only', { maxEscalations: Number.MAX_SAFE_INTEGER }).recover({ confirmedStopped })
      }
      return repository.recoverReview(taskId, confirmedStopped)
    })
  }
  return withFileLock(join(canonical, '.agent/AUTO_RUN'), async () => {
    const repository = new TaskRepository(canonical)
    await repository.init()
    let state = await repository.readState(taskId)
    const path = join(canonical, '.agent/tasks', taskId, 'AUTO.json')
    const journal = journalFrom(await optionalJson(path))
    const verifiedState = state.state === 'VERIFIED' || state.state === 'REVIEWING' || state.state === 'REVIEWED'
    const changedAfterVerification = verifiedState && journal.verifiedTreeHash !== null
      && await worktreeHash(canonical) !== journal.verifiedTreeHash
    if (!confirmedStopped && (taskRequiresStopConfirmation(state) || changedAfterVerification)) {
      throw new Error('recovery requires confirmation that the previous agent and container command have stopped')
    }
    await repository.assertDispatchAdmission(taskId, undefined, true)
    // Recovery always discards the current work revision. When the artifacts
    // already satisfy acceptance, that discard throws away a completed result
    // for nothing, so refuse and point at the transition that consumes it.
    // A reviewed revision whose acceptance is still blocked is NOT protected:
    // replanning is the only way forward for it.
    if (state.state === 'REVIEWED' && await repository.acceptanceReachable(taskId)) {
      throw new Error(`task ${taskId} holds an acceptable reviewed work revision; recovery would discard it. Call engineering_run with the same taskId to accept it, or supply a changed request to replan with explicit scope.`)
    }
    const scheduling = new TaskSchedulingRepository(canonical, taskId, 'development', { maxEscalations: Number.MAX_SAFE_INTEGER })
    if (await optionalJson(join(canonical, '.agent/tasks', taskId, 'SCHEDULING.json')) !== undefined || await optionalJson(join(canonical, '.agent/tasks', taskId, 'SCHEDULING.MARKER.json')) !== undefined) await scheduling.recover({ confirmedStopped })
    if (state.writer !== null) state = await repository.releaseImplementation(taskId, state.revision, state.writer.token)
    const replanned = await repository.replan(taskId, state.revision, confirmedStopped)
    await writeFileAtomic(path, `${JSON.stringify({
      ...journal, steps: 0, roleCalls: 0, completedWriterRevision: null, verifiedTreeHash: null,
    }, null, 2)}\n`, { mode: 0o600 })
    return replanned
  }, { waitMs: 0 })
}

/**
 * Run isolated roles, persist each transition, and accept only deterministic command evidence and independent review.
 * @param options - project, natural-language request, optional task selection, and quiescent role executor.
 * @returns the accepted or blocked state; errors retain resumable artifacts and budgets.
 */
export async function runEngineeringTask(options: EngineeringRunOptions): Promise<EngineeringRunResult> {
  const root = await realpath(options.root)
  const project = await loadEngineeringProject(root)
  const config = options.deployment
  const verificationContext = await loadRepositoryVerificationContext(root, project.profile)
  const adapters = verificationContext.verificationConfig
  if (adapters === null) throw new Error('verification commands are not configured')
  const gates = verificationContext.gates
  if (!gates.some(gate => gate.required)) throw new Error('engineering profile must have required verification gates')
  for (const gate of gates) if (gate.required && adapters.adapters[gate.adapter] === undefined) throw new Error(`missing required verification adapter: ${gate.adapter}`)
  const repository = new TaskRepository(root)
  await repository.init()
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const preselected = options.taskId === undefined ? await selectTask(root, repository, undefined) : undefined
  try {
    return await withFileLock(join(root, '.agent/AUTO_RUN'), async () => {
    signal.throwIfAborted()
    const selected = options.taskId === undefined ? preselected : await selectTask(root, repository, options.taskId)
    const taskId = selected ?? `task-${randomUUID()}`
    await options.onTaskSelected?.(taskId)
    signal.throwIfAborted()
    const directory = join(root, '.agent/tasks', taskId)
    let journal: Journal
  if (selected === undefined) {
      if (!options.request.trim()) throw new Error('a development request is required')
      journal = {
        schemaVersion: 1, requests: [options.request], steps: 0, roleCalls: 0, completedWriterRevision: null,
        pendingTask: { schemaVersion: 1, id: taskId, title: options.request.slice(0, 200), profile: project.profile, dataClass: project.dataClass, createdAt: new Date().toISOString() }, verifiedTreeHash: null,
      }
    } else {
      journal = journalFrom(await optionalJson(join(directory, 'AUTO.json')))
      if (options.request.trim() && !journal.requests.includes(options.request)) {
        const current = await repository.readState(taskId)
        const scopeReplan = current.state === 'BLOCKED' && nextActionForState(current).nextAction === 'REPLAN_WITH_SCOPE'
        if (current.state !== 'REPLAN' && !scopeReplan) throw new Error(`request differs from task ${taskId}; create a new task or explicitly replan the existing task before changing its scope`)
        if (scopeReplan) await repository.replan(taskId, current.revision)
        journal.requests.push(options.request)
        journal.steps = 0
        journal.roleCalls = 0
        journal.completedWriterRevision = null
        journal.verifiedTreeHash = null
      }
    }
    const save = async (): Promise<void> => writeFileAtomic(join(directory, 'AUTO.json'), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 })
    await save()
    if (journal.pendingTask !== null) {
      if (journal.pendingTask.id !== taskId) throw new Error('pending task identity does not match its directory')
      if (await optionalJson(join(directory, 'STATE.json')) === undefined) {
        await repository.createTask(journal.pendingTask)
        await new TaskSchedulingRepository(root, taskId, 'development', { maxEscalations: config.workflow.maxCapabilityEscalations }).initializeNew()
        await repository.initializeLifecycle(taskId, 'development', {
          ...config.workflow.lifecycleBudget,
          maxLogicalInvocations: Math.min(config.workflow.lifecycleBudget.maxLogicalInvocations ?? project.maxRoleCalls, project.maxRoleCalls),
        })
      }
      journal.pendingTask = null
      await save()
    }
    const task = await repository.readTask(taskId)
    if (task.profile !== project.profile || task.dataClass !== project.dataClass) throw new Error('project profile or dataClass changed since task creation')
    let state = await repository.readState(taskId)
    const scheduling = new TaskSchedulingRepository(root, taskId, 'development', { maxEscalations: config.workflow.maxCapabilityEscalations })
    if (state.state === 'ACCEPTED') return resultForState(taskId, state)
    const storedScheduling = await optionalJson(join(directory, 'SCHEDULING.json'))
    const history = storedScheduling === undefined ? undefined : await scheduling.read()
    let classification = await classifyProject(root, project, journal.requests.join('\n\n'), config, history?.classifications.at(-1))
    if (storedScheduling === undefined) classification = { ...classification, taskClass: 'complex', needsInvestigation: true, needsChallenge: true, reasons: [...classification.reasons, 'UNKNOWN_LEGACY_HISTORY'] }
    else classification = await scheduling.recordClassification(classification)
    await repository.assertDispatchAdmission(taskId, journal.completedWriterRevision ?? undefined, false, history?.diagnoses.some(item => item.status !== 'APPLIED') ?? false)
    if (state.state === 'BLOCKED' || state.state === 'BUDGET_EXHAUSTED') return resultForState(taskId, state)
    const lifecycle = await repository.lifecycle(taskId, 'development', {
      ...config.workflow.lifecycleBudget,
      maxLogicalInvocations: Math.min(config.workflow.lifecycleBudget.maxLogicalInvocations ?? project.maxRoleCalls, project.maxRoleCalls),
    })
    const priorUsage = await lifecycle.read()
    const invocationLimit = Math.min(config.workflow.lifecycleBudget.maxLogicalInvocations ?? project.maxRoleCalls, project.maxRoleCalls)
    if (priorUsage.counts.logicalInvocations >= invocationLimit) {
      state = await repository.budgetExhausted(taskId, state.revision, 'task lifecycle budget exhausted: logicalInvocations')
      return resultForState(taskId, state)
    }
    await lifecycle.recordRunState({ state: 'RUNNING', at: new Date().toISOString() })
    const roleRequest = await boundedRequest(directory, journal.requests.join('\n\n'), config.workflow.maxRoleContextBytes)
    let writerCapabilityFailureKey: string | undefined
    let reservation = Promise.resolve()
    type Override = { routes: ResolvedRoleRoute[]; validation: Record<string, unknown>; structured?: ObjectJsonSchema; escalationId: SchedulingEscalationId }
    const call = (role: EngineeringRole, extra: Record<string, unknown> = {}, unit?: InvestigationUnit, override?: Override): Promise<Record<string, unknown>> => {
      const predecessor = reservation
      let release!: () => void
      const admitted = new Promise<void>(resolve => { release = resolve })
      reservation = predecessor.then(() => admitted)
      return callReserved(role, extra, unit, predecessor, release, override).finally(release)
    }
    const callReserved = async (role: EngineeringRole, extra: Record<string, unknown>, unit: InvestigationUnit | undefined,
      predecessor: Promise<void>, release: () => void, override?: Override): Promise<Record<string, unknown>> => {
      signal.throwIfAborted()
      const dependencies = unit === undefined ? undefined : await captureInvestigationDependencies(root, unit.allowedPaths, config.workflow.maxInvestigationPaths)
      const scopeDigest = unit === undefined ? undefined : investigationScopeDigest(journal.requests.join('\n\n'), unit)
      const previous = unit === undefined ? undefined : await repository.readInvestigationCheckpoint(taskId, 'development', unit.id)
      const validPrevious = previous !== undefined && dependencies !== undefined && previous.scopeDigest === scopeDigest
        && previous.repositorySnapshot === dependencies.repositorySnapshot && previous.scopeMembershipDigest === dependencies.scopeMembershipDigest
        && JSON.stringify(previous.dependencies) === JSON.stringify(dependencies.dependencies)
      if (validPrevious) {
        for (const receipt of previous.evidence) {
          if (!await lifecycle.validateInspection(previous.attemptIds, receipt.executionId)) throw new Error('checkpoint inspection has no durable task attempt and tool execution')
        }
      }
      if (validPrevious && previous.status === 'COMPLETE' && previous.output !== null) {
        const schema = await outputSchemas(root, role)
        const validate = new Ajv({ strict: true, allErrors: true }).compile(schema.validation)
        if (!validate(previous.output)) throw new Error('persisted investigation output fails the current role schema')
        await repository.saveInvestigationCheckpoint({ ...previous, validatedForRevision: state.revision, updatedAt: new Date().toISOString() })
        return previous.output
      }
      const startedAt = new Date().toISOString()
      if (unit !== undefined) unit = { ...unit, question: await boundedRequest(directory, unit.question, config.workflow.maxRoleContextBytes) }
      let checkpoint: InvestigationCheckpoint | undefined = unit === undefined || dependencies === undefined || scopeDigest === undefined ? undefined : {
        schemaVersion: 1, taskId, workflow: 'development', unitId: unit.id, taskRevision: state.revision, validatedForRevision: state.revision,
        ...dependencies, scopeDigest, allowedPaths: unit.allowedPaths, evidence: validPrevious ? previous.evidence : [],
        output: null, status: 'PARTIAL', startedAt, updatedAt: startedAt, attemptIds: validPrevious ? [...previous.attemptIds] : [],
      }
      let checkpointTail = Promise.resolve()
      const persistCheckpoint = (): Promise<void> => {
        const pending = checkpointTail.then(async () => {
          if (checkpoint !== undefined) await repository.saveInvestigationCheckpoint({ ...checkpoint, updatedAt: new Date().toISOString() })
        })
        checkpointTail = pending.catch(() => {})
        return pending
      }
      let tools = 0
      let bodies = 0
      const seenTools = new Set<string>()
      let toolReservation = Promise.resolve()
      const bounds = config.workflow.roleBounds[role]!
      let invocationId: EngineeringInvocationId
      const attemptIds = new Map<number, EngineeringAttemptId>()
      const control = async (route: ResolvedRoleRoute, index: number): Promise<RoleExecutionControl> => {
        const attemptId = await lifecycle.reserveAttempt(invocationId, route)
        attemptIds.set(index, attemptId)
        if (checkpoint !== undefined) { checkpoint.attemptIds.push(attemptId); await persistCheckpoint() }
        const reserveToolCall = (executionId: string): Promise<void> => {
          const reservation = toolReservation.then(async () => {
            if (seenTools.has(executionId)) return
            if (tools >= bounds.maxToolCalls) throw new BudgetExhaustedError(`Role ${role} exhausted its ${bounds.maxToolCalls}-tool work-unit budget`)
            await lifecycle.reserveToolCall(attemptId, executionId)
            seenTools.add(executionId); tools += 1
          })
          toolReservation = reservation.catch(() => {})
          return reservation
        }
        return {
          taskId, routeId: route.routeId, lifecycle, invocationId, attemptId, bounds, startedAt,
          reserveToolCall,
          recordInspection: async receipt => {
            if (checkpoint === undefined || unit === undefined) return
            if (!unit.allowedPaths.some(path => receipt.path === path || receipt.path.startsWith(`${path}/`))) throw new Error('inspection receipt is outside the assigned investigation scope')
            const dependency = checkpoint.dependencies.find(item => item.path === receipt.path)
            if (dependency === undefined || dependency.hash !== receipt.contentHash) throw new Error('inspection content hash does not match the assigned source snapshot')
            await reserveToolCall(receipt.executionId)
            const existing = checkpoint.evidence.find(item => item.executionId === receipt.executionId)
            if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(receipt)) throw new Error('inspection receipt identity conflict')
            if (existing === undefined) checkpoint.evidence.push(receipt)
            await persistCheckpoint()
          },
          checkpoint: persistCheckpoint,
          markBodyStart: () => {
            if (bodies >= bounds.maxToolCalls) throw new BudgetExhaustedError(`Role ${role} exhausted its tool body budget`)
            bodies += 1
          },
        }
      }
      const inputDigest = createHash('sha256').update(JSON.stringify({ request: journal.requests, role, scopeDigest, workRevision: unit === undefined ? state.workRevision : null })).digest('hex')
      const reserved = override !== undefined || role === 'implementer' ? undefined : (await scheduling.read()).escalations.find(item => item.status === 'RESERVED' && item.role === role && item.dispatchInput?.inputDigest === inputDigest)
      if (reserved !== undefined) {
        if (reserved.sourceFingerprint !== await worktreeHash(root)) throw new EngineeringRoleFailure('Reserved escalation source fingerprint changed; explicit scope information is required.')
        const restored = resolveRoleEscalations(config, role, reserved.dispatchInput!.failedRouteId)
        if (restored.candidates.length === 0) throw new EngineeringRoleFailure('Reserved escalation has no qualified stronger route in current configuration.')
        const schemas = await outputSchemas(root, role)
        override = { routes: [...restored.candidates, ...restored.fallbackCandidates], validation: schemas.validation, structured: schemas.structured, escalationId: reserved.id }
        extra = { ...extra, capabilityPartialAssertions: reserved.dispatchInput!.partial }
      }
      const attempts = override?.routes ?? resolveRoleAttempts(config, role)
      const primary = attempts[0]
      if (primary === undefined) throw new Error(`role ${role} has no dispatch route`)
      assertRouteDispatchAllowed(config, primary.routeId, project.dataClass)
      let schemas: { structured: ObjectJsonSchema; validation: Record<string, unknown> } | undefined
      let primaryStart: { startedAt: string; execution: Promise<unknown> } | undefined
      const primaryMutation = { started: false }
      let preparedContext: Record<string, unknown> | undefined
      const start = predecessor.then(async () => {
        signal.throwIfAborted()
        invocationId = await lifecycle.reserveInvocation(role)
        journal.roleCalls += 1
        await save()
        const context: Record<string, unknown> = project.knowledge === undefined ? {} : { repositoryKnowledge: project.knowledge }
        context.taskClassification = classification
        context.verificationPolicy = verificationContext.policy
        context.verificationInstances = verificationContext.gates
        context.verificationCommands = adapters
        context.acceptanceTier = verificationContext.tier
        for (const artifact of ['BASELINE', 'INVESTIGATION', 'PLAN', 'VERIFY', 'REVIEW']) {
          const value = await optionalJson(join(directory, `${artifact}.json`))
          if (value !== undefined) context[artifact] = value
        }
        preparedContext = { ...context, ...extra }
        if (validPrevious && previous.evidence.length > 0) preparedContext.partialInvestigationEvidence = previous.evidence
        preparedContext = await boundedContext(directory, role, preparedContext, config.workflow.maxRoleContextBytes)
        schemas = override === undefined ? await outputSchemas(root, role) : { validation: override.validation, structured: override.structured ?? roleResponseSchema(projectDiagnosticSchema()) }
        const primaryAttempt = attempts[0]!
        const executionControl = await control(primaryAttempt, 1)
        if (override !== undefined) await scheduling.beginDispatch(override.escalationId, executionControl.attemptId)
        primaryStart = {
          startedAt,
          execution: options.executeRole({
            role, route: primaryAttempt, attemptIndex: 1, root, taskId,
            request: roleRequest,
            state: { state: state.state, revision: state.revision, workRevision: state.workRevision, fixAttempts: state.fixAttempts },
            context: preparedContext, outputSchema: schemas.structured, signal,
            markMutationStarted: () => { primaryMutation.started = true },
            executionControl, ...(unit === undefined ? {} : { workUnit: unit }),
          }),
        }
      })
      await start
      release()
      if (schemas === undefined || primaryStart === undefined) throw new Error(`role ${role} did not start`)
      const escalation = resolveRoleEscalations(config, role, primary.routeId)
      let escalationFingerprint: string | undefined
      let capabilityPartial: unknown
      const validator = new Ajv({ strict: true, allErrors: true }).compile(schemas.validation)
      try {
        const output = await runRoleAttempts<Record<string, unknown>>({
          role, attempts, signal, ...(override === undefined ? {} : { initialEscalationId: override.escalationId }), primary: { ...primaryStart, mutation: primaryMutation },
          escalationCandidates: role === 'implementer' || override !== undefined ? [] : escalation.candidates,
          escalationFallbackCandidates: role === 'implementer' || override !== undefined ? [] : escalation.fallbackCandidates,
          onEscalate: async (failure, failedRoute, failedIndex) => {
            resolveRoleEscalations(config, role, failedRoute.routeId)
            escalationFingerprint = await worktreeHash(root)
            capabilityPartial = failure.partial
            const record = await scheduling.reserveEscalation({ failureKey: `attempt:${attemptIds.get(failedIndex)}:capability`, recoveryEpoch: (await scheduling.read()).recoveryEpoch, role, reason: failure.reason, sourceFingerprint: escalationFingerprint, dispatchInput: { failedRouteId: failedRoute.routeId, partial: failure.partial, inputDigest } })
            return { escalationId: record.id }
          },
          beforeEscalationDispatch: (id, attemptId) => scheduling.beginDispatch(id, attemptId).then(() => {}),
          onEscalationSettled: async (id, outcome) => {
            const after = await worktreeHash(root)
            if (outcome.error !== undefined) {
              const failure = after !== escalationFingerprint ? new RoleQuiescenceError('Read-only escalation changed source before failing; confirm stopped work before recovery', { cause: outcome.error }) : outcome.error
              try { await scheduling.failEscalation(id, failure instanceof RoleQuiescenceError) }
              catch (auditError) { if (failure instanceof RoleQuiescenceError) throw new RoleQuiescenceError(failure.message, { cause: new AggregateError([failure, auditError]) }); throw auditError }
              if (failure instanceof RoleQuiescenceError) throw failure
              return
            }
            if (after !== escalationFingerprint) {
              const error = new RoleQuiescenceError('Read-only capability escalation changed the source fingerprint; confirm stopped work before recovery')
              try { await scheduling.failEscalation(id, true) }
              catch (auditError) { throw new RoleQuiescenceError(error.message, { cause: new AggregateError([error, auditError]) }) }
              throw error
            }
            await scheduling.completeEscalation(id, object(outcome.output, 'escalation output'), after)
          },
          executeAttempt: async (route, attemptIndex, markMutationStarted, dispatch) => {
            assertRouteDispatchAllowed(config, route.routeId, project.dataClass)
            const executionControl = await control(route, attemptIndex)
            await dispatch?.onReservedAttempt?.(executionControl.attemptId)
            const fallbackContext = await boundedContext(directory, role, {
              ...preparedContext, ...(capabilityPartial === undefined ? {} : { capabilityPartialAssertions: capabilityPartial }), ...(checkpoint === undefined ? {} : { partialInvestigationEvidence: checkpoint.evidence }),
            }, config.workflow.maxRoleContextBytes)
            return options.executeRole({
              role, route, attemptIndex, root, taskId,
              request: roleRequest,
              state: { state: state.state, revision: state.revision, workRevision: state.workRevision, fixAttempts: state.fixAttempts },
              context: fallbackContext, outputSchema: schemas!.structured, signal, markMutationStarted,
              executionControl, ...(unit === undefined ? {} : { workUnit: unit }),
            })
          },
          validateOutput: value => {
            const result = unwrapRoleResponse(value, schemas!.validation)
            if (!validator(result)) throw new RoleInvocationError(`${role} returned invalid output: ${JSON.stringify(validator.errors)}`, 'SCHEMA_INVALID', true)
            return object(result, `${role} output`)
          },
          persistAttempts: async records => {
            await appendRoleAttempts(root, taskId, role, records)
            for (const record of records) {
              const attemptId = attemptIds.get(record.attemptIndex)
              if (attemptId !== undefined) await lifecycle.settleAttempt(attemptId, {
                startedAt: record.startedAt, endedAt: record.endedAt, outcome: record.semanticOutcome ?? record.outcome,
              })
            }
          },
        })
        if (checkpoint !== undefined && checkpoint.evidence.length > 0 && !JSON.stringify(output).match(/\bplaceholder\b/i)) {
          const after = await captureInvestigationDependencies(root, checkpoint.allowedPaths, config.workflow.maxInvestigationPaths)
          if (after.repositorySnapshot !== checkpoint.repositorySnapshot) throw new Error('investigation source changed while evidence was collected')
          checkpoint = { ...checkpoint, output, status: 'COMPLETE' }
          await persistCheckpoint()
        }
        if (reserved !== undefined) {
          const fingerprint = await worktreeHash(root)
          if (fingerprint !== reserved.sourceFingerprint) throw new RoleQuiescenceError('Resumed read-only escalation changed source; confirm stopped work before recovery')
          await scheduling.completeEscalation(reserved.id, output, fingerprint)
        }
        await lifecycle.remainingElapsedMs()
        return output
      } catch (caught) {
        const error = reserved !== undefined && await worktreeHash(root) !== reserved.sourceFingerprint ? new RoleQuiescenceError('Resumed read-only escalation changed source before failing; confirm stopped work', { cause: caught }) : caught
        if (reserved !== undefined) {
          try { await scheduling.failEscalation(reserved.id, error instanceof RoleQuiescenceError) }
          catch (auditError) {
            if (error instanceof RoleQuiescenceError) throw new RoleQuiescenceError(error.message, { cause: new AggregateError([error, auditError], 'Uncertain resumed escalation and audit failed') })
            throw auditError
          }
        }
        try { await persistCheckpoint() }
        catch (persistenceError) {
          if (error instanceof RoleQuiescenceError) throw new RoleQuiescenceError(error.message, { cause: new AggregateError([error, persistenceError], 'Uncertain role shutdown and checkpoint persistence failed') })
          throw persistenceError
        }
        if (error instanceof CapabilityInsufficientError) {
          writerCapabilityFailureKey = `attempt:${attemptIds.get(error.failedAttemptIndex ?? 1)}:capability`
          throw error
        }
        if (error instanceof BudgetExhaustedError) throw error
        if (error instanceof RoleQuiescenceError || !(error instanceof RoleInvocationError) || signal.aborted || isAbortError(error)) throw error
        throw new EngineeringRoleFailure(error.message)
      }
    }
    const diagnose = async (obligation: DiagnosisObligation, failedRouteId?: string): Promise<void> => {
      await repository.assertDispatchAdmission(taskId, undefined, false, true)
      const fingerprint = await worktreeHash(root)
      if (fingerprint !== obligation.sourceFingerprint) throw new EngineeringRoleFailure('Diagnosis source fingerprint changed; explicit scope information is required.')
      if (obligation.status === 'PENDING') {
        const origin = failedRouteId ?? resolveRoleAttempts(config, 'implementer')[0]!.routeId
        const routes = resolveRoleEscalations(config, 'implementer', origin)
        if (routes.candidates.length === 0) throw new EngineeringRoleFailure('No stronger read-only diagnosis route is configured for the implementer.')
        const prior = (await scheduling.read()).escalations.find(item => item.failureKey === obligation.failureKey && item.sourceFingerprint === fingerprint && (item.status === 'RESERVED' || item.status === 'COMPLETE'))
        const reservation = prior ?? await scheduling.reserveEscalation({ failureKey: obligation.failureKey, recoveryEpoch: (await scheduling.read()).recoveryEpoch, role: 'architect', reason: 'DESIGN_ERROR', sourceFingerprint: fingerprint })
        if (reservation.status === 'COMPLETE') {
          await scheduling.completeDiagnosis(obligation.failureKey, parseDiagnosis(reservation.output), fingerprint)
        } else {
          const architect = resolveRoleAttempts(config, 'architect')[0]!
          const validation = { ...projectDiagnosticSchema(), properties: { ...projectDiagnosticSchema().properties, summary: { type: 'string', minLength: 1 } } }
          try {
            const output = await call('architect', { diagnosisObligation: obligation, instruction: 'Diagnose the stopped implementation with read-only evidence. Return diagnosis fields; do not replace or implement the frozen plan.' }, undefined, {
              routes: [...routes.candidates, ...routes.fallbackCandidates].map(route => ({ ...route, role: 'architect', writable: false, ...(architect.toolName === undefined ? {} : { toolName: architect.toolName }) })), validation, escalationId: reservation.id,
            })
            const after = await worktreeHash(root)
            if (after !== fingerprint) throw new RoleQuiescenceError('Read-only diagnosis changed repository source; termination and source ownership require operator confirmation')
            await scheduling.completeEscalation(reservation.id, output, after)
            await scheduling.completeDiagnosis(obligation.failureKey, parseDiagnosis(output), after)
          } catch (caught) {
            const error = await worktreeHash(root) !== fingerprint ? new RoleQuiescenceError('Read-only diagnosis changed source before failing; confirm stopped work', { cause: caught }) : caught
            try { await scheduling.failEscalation(reservation.id, error instanceof RoleQuiescenceError) }
            catch (auditError) { if (error instanceof RoleQuiescenceError) throw new RoleQuiescenceError(error.message, { cause: new AggregateError([error, auditError]) }); throw auditError }
            throw error
          }
        }
      }
      const current = (await scheduling.read()).diagnoses.find(item => item.failureKey === obligation.failureKey)!
      if (current.status === 'APPLIED') return
      if (current.status !== 'COMPLETE' || current.output === undefined) throw new EngineeringRoleFailure('Diagnosis remains incomplete and blocks writer admission.')
      // A diagnosis cannot grant new write intent. Require a new frozen plan for either recommendation.
      if (state.state !== 'REPLAN') state = await repository.replan(taskId, state.revision)
      await scheduling.recordDiagnosisApplication(obligation.failureKey, { stateRevision: state.revision, planDigest: obligation.planDigest, recommendation: 'REPLAN', repairConstraints: current.output.repairConstraints })
      await scheduling.applyDiagnosis(obligation.failureKey, state.revision)
      journal.completedWriterRevision = null
      journal.verifiedTreeHash = null
      await save()
    }
    const assertFrozenScope = async (): Promise<void> => {
      const planScheduling = await optionalJson(join(directory, `PLAN-SCHEDULING-${state.workRevision}.json`))
      if (storedScheduling !== undefined && planScheduling === undefined) throw new EngineeringRoleFailure('Frozen plan scheduling evidence is missing; provide scope information and replan.')
      let simpleScope: string[] | undefined
      if (planScheduling !== undefined) {
        const binding = object(planScheduling, 'plan scheduling')
        const frozen = object(binding.classification, 'frozen classification')
        if (binding.taskId !== taskId || binding.workRevision !== state.workRevision) throw new Error('Plan scheduling identity mismatch')
        if (frozen.taskClass === 'simple') {
          if (!Array.isArray(frozen.scopePaths) || !frozen.scopePaths.every(path => typeof path === 'string')) throw new Error('Invalid frozen simple scope')
          simpleScope = frozen.scopePaths
        }
      }
      const baseline = object(await optionalJson(join(directory, 'BASELINE.json')), 'baseline')
      const head = await execute('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
      if (simpleScope !== undefined && (head.stdout.trim() !== baseline.repositoryHead || (await changedSourcePaths(root)).some(path => !simpleScope.includes(path)))) {
        classification = { ...classification, taskClass: 'complex', needsInvestigation: true, needsChallenge: true, reasons: [...classification.reasons, 'OUT_OF_SCOPE_WRITE'] }
        classification = await scheduling.recordClassification(classification)
        throw new EngineeringRoleFailure('Implementation changed files outside the authorized product scope; provide explicit scope information before replanning.')
      }
    }
    const reserveRepairDiagnosis = async (failureKey: string): Promise<DiagnosisObligation> => {
      const plan = object(await optionalJson(join(directory, 'PLAN.json')), 'bound plan')
      return scheduling.recordDiagnosisObligation({ failureKey, writerRevision: state.workRevision, planDigest: String(plan.intentDigest), sourceFingerprint: await worktreeHash(root) })
    }
    for (const pending of history?.diagnoses.filter(item => item.status !== 'APPLIED') ?? []) await diagnose(pending)
    await repository.assertDispatchAdmission(taskId, journal.completedWriterRevision ?? undefined)
    while (state.state !== 'ACCEPTED' && state.state !== 'BLOCKED' && state.state !== 'BUDGET_EXHAUSTED') {
      signal.throwIfAborted()
      if (journal.steps >= project.maxSteps) throw new Error(`step budget exhausted for ${taskId}`)
      journal.steps += 1
      await save()
      options.onProgress?.(state)
      try {
        await lifecycle.remainingElapsedMs()
        switch (state.state) {
        case 'NEW': {
          const head = await runCommand(root, { executable: 'git', args: ['rev-parse', 'HEAD'] }, project.commandTimeoutMs, signal)
          const dirty = await runCommand(root, { executable: 'git', args: ['status', '--porcelain', '--', '.', ':(exclude).agent'] }, project.commandTimeoutMs, signal)
          signal.throwIfAborted()
          if (head.status !== 'PASS' || dirty.status !== 'PASS') throw new Error('cannot capture Git baseline')
          state = await repository.baseline(taskId, state.revision, { repositoryHead: head.stdout.trim(), dirty: dirty.stdout.trim().length > 0, summary: journal.requests.join('\n\n') })
          break
        }
        case 'BASELINED':
        case 'REPLAN': {
          if (!classification.needsInvestigation) {
            state = await repository.investigate(taskId, state.revision, { findings: ['Explicit repository-owned scope and acceptance criteria; source investigation was not requested.'], hypotheses: [], unresolvedAssumptions: [] })
            break
          }
          const units = await investigationUnits(root, project, config)
          const results = await Promise.allSettled(units.map(unit => call(unit.role, {}, unit)))
          const uncertain = results.find(result => result.status === 'rejected' && result.reason instanceof RoleQuiescenceError)
          if (uncertain?.status === 'rejected') throw uncertain.reason
          const exhausted = results.find(result => result.status === 'rejected' && result.reason instanceof BudgetExhaustedError)
          if (exhausted?.status === 'rejected') throw exhausted.reason
          const scouts: Record<string, unknown>[] = []
          for (const result of results) {
            if (result.status === 'rejected') throw result.reason
            scouts.push(result.value)
          }
          state = await repository.investigate(taskId, state.revision, {
            findings: scouts.flatMap(result => result.findings as string[]),
            hypotheses: scouts.flatMap(result => result.hypotheses as object[]),
            unresolvedAssumptions: scouts.flatMap(result => result.unresolvedAssumptions as string[]),
          })
          break
        }
        case 'INVESTIGATED': {
          const plan = classification.taskClass === 'simple' ? {
            problemStatement: journal.requests.join('\n\n'), hypotheses: ['Explicit acceptance criteria define the requested result.'],
            selectedApproach: `Implement only the declared files: ${classification.scopePaths.join(', ')}`, rejectedAlternatives: ['Modify undeclared files'],
            invariants: ['Preserve all files outside the declared scope'], expectedComponents: classification.scopePaths, implementationScope: classification.scopePaths,
            falsificationTests: project.scheduling!.acceptanceCriteria, acceptanceGates: gates.filter(gate => gate.required).map(gate => gate.name), unresolvedAssumptions: [],
          } : await call('architect', { challenge: await optionalJson(join(directory, 'CHALLENGE.json')) })
          const challenge = classification.needsChallenge ? await call('challenger', { candidatePlan: plan }) : { decision: 'ACCEPT', summary: 'Classification does not require an additional challenge.', findings: [] }
          await writeFileAtomic(join(directory, 'CHALLENGE.json'), `${JSON.stringify(challenge)}\n`, { mode: 0o600 })
          if (challenge.decision === 'ACCEPT') {
            await writeFileAtomic(join(directory, `PLAN-SCHEDULING-${state.workRevision + 1}.json`), `${JSON.stringify({ taskId, workRevision: state.workRevision + 1, classification })}\n`, { mode: 0o600 })
            state = await repository.freezePlan(taskId, state.revision, plan)
          }
          break
        }
        case 'PLAN_FROZEN':
        case 'IMPLEMENTING': {
          if (state.writer !== null) {
            if (journal.completedWriterRevision !== state.revision) throw new Error(`task ${taskId} has an interrupted writer; stop its agent and explicitly release its lease before resuming`)
          } else {
            state = await repository.startImplementation(taskId, state.revision)
            const token = state.writer?.token
            if (token === undefined) throw new Error('implementation did not acquire its writer lease')
            try {
              const implementation = await call('implementer')
              await writeFileAtomic(join(directory, 'IMPLEMENTATION.json'), `${JSON.stringify(implementation)}\n`, { mode: 0o600 })
              journal.completedWriterRevision = state.revision
              await save()
            } catch (error) {
              if (error instanceof RoleQuiescenceError) throw error
              if (error instanceof CapabilityInsufficientError) {
                const plan = object(await optionalJson(join(directory, 'PLAN.json')), 'bound plan')
                await scheduling.recordDiagnosisObligation({ failureKey: writerCapabilityFailureKey ?? `writer:${state.revision}`, writerRevision: state.workRevision, planDigest: String(plan.intentDigest), sourceFingerprint: await worktreeHash(root) })
              }
              state = await repository.releaseImplementation(taskId, state.revision, token)
              throw error
            }
          }
          state = await repository.beginVerification(taskId, state.revision, state.writer?.token ?? '')
          break
        }
        case 'VERIFYING': {
          const snapshot = await repository.verificationExecutionContext(taskId)
          const assertCurrent = async (): Promise<void> => {
            signal.throwIfAborted()
            await repository.assertVerificationExecutionContext(taskId, snapshot)
            signal.throwIfAborted()
          }
          const execution = await runVerificationProfile(root, project.profile, snapshot.config, signal, snapshot.gates, snapshot.arguments, snapshot.identity, assertCurrent)
          if (execution.results.some(({ result }) => result.quiescence === 'UNCERTAIN')) {
            state = await repository.block(taskId, state.revision, 'Verification executor termination is uncertain. Confirm that all command writes have stopped before explicitly replanning this task.')
            if (signal.aborted) signal.throwIfAborted()
            break
          }
          signal.throwIfAborted()
          await assertCurrent()
          const evidence = verificationEvidence(root, execution)
          await repository.appendEvidence(taskId, state.workRevision, evidence, state.revision)
          journal.verifiedTreeHash = await worktreeHash(root)
          await save()
          let repairDiagnosis: DiagnosisObligation | undefined
          if (execution.verification.status !== 'PASS' && state.fixAttempts + 1 >= config.workflow.repairEscalationThreshold) {
            const digest = createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
            repairDiagnosis = await reserveRepairDiagnosis(`verification:${state.workRevision}:${state.fixAttempts + 1}:${digest}`)
          }
          state = await repository.finishVerification(taskId, state.revision, execution.verification)
          if (repairDiagnosis !== undefined) await diagnose(repairDiagnosis)
          break
        }
        case 'VERIFIED':
        case 'REVIEWING': {
          await repository.verificationGates(taskId)
          if (journal.verifiedTreeHash === null || await worktreeHash(root) !== journal.verifiedTreeHash) throw new Error('worktree changed after verification; explicitly replan and rerun verification')
          const review = await call('reviewer')
          await assertFrozenScope()
          let repairDiagnosis: DiagnosisObligation | undefined
          if (review.decision === 'REPLAN' || review.decision === 'FIX_BOUNDED' && state.fixAttempts + 1 >= config.workflow.repairEscalationThreshold) {
            const digest = createHash('sha256').update(JSON.stringify(review)).digest('hex')
            repairDiagnosis = await reserveRepairDiagnosis(`review:${state.workRevision}:${state.fixAttempts + 1}:${digest}`)
          }
          state = state.state === 'REVIEWING' ? await repository.finishReview(taskId, state.revision, review) : await repository.review(taskId, state.revision, review)
          if (repairDiagnosis !== undefined) await diagnose(repairDiagnosis)
          break
        }
        case 'REVIEWED': {
          await assertFrozenScope()
          if (journal.verifiedTreeHash === null || await worktreeHash(root) !== journal.verifiedTreeHash) throw new Error('worktree changed after verification; explicitly replan and rerun verification')
          state = await repository.accept(taskId, state.revision)
          break
        }
        }
      } catch (error) {
        if (error instanceof RoleQuiescenceError) {
          if (state.writer !== null) throw error
          state = await repository.block(taskId, state.revision,
            `${error.message}. Termination is uncertain. Confirm that all agent and command work has stopped before recovery.`)
          if (signal.aborted) throw error
          break
        }
        if (signal.aborted) throw error
        if (error instanceof CapabilityInsufficientError) {
          const pending = (await scheduling.read()).diagnoses.find(item => item.failureKey === writerCapabilityFailureKey && item.status !== 'APPLIED')
          if (pending === undefined) { state = await repository.block(taskId, state.revision, `Capability exhausted without a stronger route: ${error.details}`); break }
          try { await diagnose(pending, error.failedRouteId) }
          catch (diagnosisError) {
            if (diagnosisError instanceof BudgetExhaustedError) state = await repository.budgetExhausted(taskId, state.revision, diagnosisError.message)
            else if (diagnosisError instanceof EngineeringRoleFailure) state = await repository.block(taskId, state.revision, diagnosisError.message)
            else throw diagnosisError
            break
          }
          continue
        }
        if (error instanceof BudgetExhaustedError) {
          state = await repository.budgetExhausted(taskId, state.revision, error.message)
          break
        }
        if (!(error instanceof EngineeringRoleFailure) && !(error instanceof PlanAssumptionBlocker)) throw error
        state = await repository.block(taskId, state.revision, error.message)
      }
    }
    await lifecycle.recordRunState({ state: state.state === 'ACCEPTED' ? 'COMPLETE' : state.state === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXHAUSTED' : 'BLOCKED', at: state.updatedAt })
    options.onProgress?.(state)
    return resultForState(taskId, state)
  }, { waitMs: 0 })
  } catch (error) {
    if (signal.aborted) throw error
    if (await isLiveWriterLockTimeout(error, join(root, '.agent/AUTO_RUN'))) {
      const taskId = options.taskId ?? preselected ?? ''
      let state: TaskStateRecord | undefined
      if (taskId !== '') {
        try { state = await repository.readState(taskId) } catch { /* an active run may not have committed its selected task yet */ }
      }
      return {
        status: 'RUN_ALREADY_ACTIVE',
        taskId,
        ...state === undefined ? {} : { state },
        summary: 'Another engineering_run is active for this repository.',
        nextAction: 'WAIT_FOR_CURRENT_RUN',
        requiresStopConfirmation: false,
      }
    }
    throw error
  }
}
