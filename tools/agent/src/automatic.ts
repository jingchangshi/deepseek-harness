/** Durable engineering workflow with fixed role dispatch and command-owned acceptance. */

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { load } from 'js-yaml'
import Ajv from 'ajv'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { assertObjectJsonSchema, type JsonSchemaNode, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { assertRouteDispatchAllowed, resolveRoleAttempts } from './config.ts'
import type { HarnessConfig, ResolvedRoleRoute } from './config.ts'
import { PlanAssumptionBlocker, TaskRepository } from './repository.ts'
import { loadRepositoryKnowledge } from './knowledge.ts'
import { loadRepositoryVerificationContext } from './identity.ts'
import type { RepositoryKnowledge } from './knowledge.ts'
import { loadVerificationProfile, runCommand, runVerificationProfile, validateVerificationProfileId, verificationEvidence } from './verification.ts'
import type { TaskDocument, TaskStateRecord } from './types.ts'
import { taskRequiresStopConfirmation } from './state-machine.ts'
import { RoleInvocationError, RoleQuiescenceError, fallbackRoleAttempt, isAbortError, roleFailureAfterMutation } from './role-execution.ts'
import type { RoleAttemptRecord } from './role-execution.ts'
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
  knowledgeFile?: string
  knowledge?: RepositoryKnowledge
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
  state: Pick<TaskStateRecord, 'state' | 'revision' | 'workRevision' | 'fixAttempts'>
  context: Record<string, unknown>
  outputSchema: ObjectJsonSchema
  signal: AbortSignal
  /** Executors call this before dispatching any tool that may mutate project or external state. */
  markMutationStarted?: () => void
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
  status: 'ACCEPTED' | 'BLOCKED' | 'RUN_ALREADY_ACTIVE'
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

/** Read-only task listing used for status and explicit resumption choices. */
export interface EngineeringStatus {
  tasks: Array<{ task: TaskDocument; state: TaskStateRecord }>
  pendingTasks: TaskDocument[]
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
  if (state.state !== 'BLOCKED') return { nextAction: 'RESUME', requiresStopConfirmation: false }
  const blocker = state.blocker ?? ''
  if (/unresolved plan assumption|product scope|product decision|missing product|scope information/i.test(blocker)) {
    return { nextAction: 'REPLAN_WITH_SCOPE', requiresStopConfirmation: false }
  }
  return { nextAction: 'RECOVER', requiresStopConfirmation: taskRequiresStopConfirmation(state) }
}

function resultForState(taskId: string, state: TaskStateRecord): EngineeringRunResult {
  if (state.state !== 'ACCEPTED' && state.state !== 'BLOCKED') {
    throw new Error(`task ${taskId} cannot return a run result from ${state.state}`)
  }
  const action = nextActionForState(state)
  return {
    taskId,
    state,
    status: state.state === 'ACCEPTED' ? 'ACCEPTED' : 'BLOCKED',
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
  return {
    schemaVersion: 1, profile, adapter, dataClass,
    maxSteps: positive(source.maxSteps, 'maxSteps'),
    maxRoleCalls: positive(source.maxRoleCalls, 'maxRoleCalls'),
    commandTimeoutMs: positive(source.commandTimeoutMs, 'commandTimeoutMs'),
    ...knowledge,
  }
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
  return { structured: projected, validation }
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
  let entries: string[]
  try {
    entries = await readdir(join(root, '.agent/tasks'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tasks, pendingTasks }
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
  return { tasks, pendingTasks }
}

/**
 * Recover an interrupted task with fresh bounded budgets, requiring confirmation only when durable state may own live work.
 * @param root - project root.
 * @param taskId - exact interrupted task.
 * @param confirmedStopped - explicit confirmation when the current durable state may still own agent or command work.
 * @returns the task state after releasing any writer, entering REPLAN, and clearing execution and verification checkpoints.
 */
export async function recoverEngineeringTask(root: string, taskId: string, confirmedStopped: boolean): Promise<TaskStateRecord> {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(taskId)) throw new Error('invalid task ID')
  const canonical = await realpath(root)
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
      if (await optionalJson(join(directory, 'STATE.json')) === undefined) await repository.createTask(journal.pendingTask)
      journal.pendingTask = null
      await save()
    }
    const task = await repository.readTask(taskId)
    if (task.profile !== project.profile || task.dataClass !== project.dataClass) throw new Error('project profile or dataClass changed since task creation')
    let state = await repository.readState(taskId)
    await repository.assertDispatchAdmission(taskId, journal.completedWriterRevision ?? undefined)
    let reservation = Promise.resolve()
    const call = async (role: EngineeringRole, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      signal.throwIfAborted()
      const attempts = resolveRoleAttempts(config, role)
      const primary = attempts[0]
      if (primary === undefined) throw new Error(`role ${role} has no dispatch route`)
      assertRouteDispatchAllowed(config, primary.routeId, project.dataClass)
      let schemas: { structured: ObjectJsonSchema; validation: Record<string, unknown> } | undefined
      let primaryStart: { startedAt: string; execution: Promise<unknown> } | undefined
      const primaryMutation = { started: false }
      let preparedContext: Record<string, unknown> | undefined
      const start = reservation.then(async () => {
        signal.throwIfAborted()
        if (journal.roleCalls >= project.maxRoleCalls) throw new Error(`role-call budget exhausted for ${taskId}`)
        journal.roleCalls += 1
        await save()
        const context: Record<string, unknown> = project.knowledge === undefined ? {} : { repositoryKnowledge: project.knowledge }
        context.verificationPolicy = verificationContext.policy
        context.verificationInstances = verificationContext.gates
        context.verificationCommands = adapters
        context.acceptanceTier = verificationContext.tier
        for (const artifact of ['BASELINE', 'INVESTIGATION', 'PLAN', 'VERIFY', 'REVIEW']) {
          const value = await optionalJson(join(directory, `${artifact}.json`))
          if (value !== undefined) context[artifact] = value
        }
        preparedContext = context
        schemas = await outputSchemas(root, role)
        const primaryAttempt = attempts[0]!
        const startedAt = new Date().toISOString()
        primaryStart = {
          startedAt,
          execution: options.executeRole({
            role, route: primaryAttempt, attemptIndex: 1, root, taskId,
            request: journal.requests.join('\n\n'),
            state: { state: state.state, revision: state.revision, workRevision: state.workRevision, fixAttempts: state.fixAttempts },
            context: { ...preparedContext, ...extra }, outputSchema: schemas.structured, signal,
            markMutationStarted: () => { primaryMutation.started = true },
          }),
        }
      })
      reservation = start
      await start
      if (schemas === undefined || primaryStart === undefined) throw new Error(`role ${role} did not start`)
      const validator = new Ajv({ strict: true, allErrors: true }).compile(schemas.validation)
      const records: RoleAttemptRecord[] = []
      let quiescenceError: RoleQuiescenceError | undefined
      try {
        for (const [index, route] of attempts.entries()) {
          assertRouteDispatchAllowed(config, route.routeId, project.dataClass)
          const attemptIndex = index + 1
          if (attemptIndex > 1) signal.throwIfAborted()
          const startedAt = attemptIndex === 1 ? primaryStart.startedAt : new Date().toISOString()
          const mutation = attemptIndex === 1 ? primaryMutation : { started: false }
          const execution = attemptIndex === 1 ? primaryStart.execution : options.executeRole({
            role, route, attemptIndex, root, taskId,
            request: journal.requests.join('\n\n'),
            state: { state: state.state, revision: state.revision, workRevision: state.workRevision, fixAttempts: state.fixAttempts },
            context: { ...preparedContext, ...extra }, outputSchema: schemas.structured, signal,
            markMutationStarted: () => { mutation.started = true },
          })
          try {
            const result = await execution
            signal.throwIfAborted()
            if (!validator(result)) {
              throw new RoleInvocationError(`${role} returned invalid output: ${JSON.stringify(validator.errors)}`, 'SCHEMA_INVALID', true)
            }
            records.push({ role, attemptIndex, routeId: route.routeId, provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort,
              startedAt, endedAt: new Date().toISOString(), outcome: 'SUCCESS' })
            return object(result, `${role} output`)
          } catch (caught) {
            const error = mutation.started ? roleFailureAfterMutation(caught) : caught
            const fallback = fallbackRoleAttempt(error, signal)
            records.push({ role, attemptIndex, routeId: route.routeId, provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort,
              startedAt, endedAt: new Date().toISOString(), outcome: 'FAILED',
              ...fallback === undefined && error instanceof RoleInvocationError ? { failureClass: error.failureClass, fallbackReason: error.message.slice(0, 1000) }
                : fallback === undefined ? { failureClass: 'NON_FALLBACKABLE' as const, fallbackReason: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000) }
                : { failureClass: fallback.failureClass, fallbackReason: fallback.fallbackReason } })
            if (fallback !== undefined && attemptIndex < attempts.length) continue
            if (error instanceof RoleQuiescenceError) {
              quiescenceError = error
              throw error
            }
            if (error instanceof EngineeringRoleFailure) throw error
            if (!(error instanceof RoleInvocationError)) throw error
            if (signal.aborted || isAbortError(error)) throw error
            throw new EngineeringRoleFailure(error.message)
          }
        }
        throw new Error(`role ${role} exhausted its configured dispatch routes`)
      } finally {
        try {
          await appendRoleAttempts(root, taskId, role, records)
        } catch (error) {
          if (quiescenceError === undefined) throw error
          throw new RoleQuiescenceError(quiescenceError.message, {
            cause: new AggregateError([quiescenceError, error], 'Role quiescence and attempt audit persistence failed'),
          })
        }
      }
    }
    while (state.state !== 'ACCEPTED' && state.state !== 'BLOCKED') {
      signal.throwIfAborted()
      if (journal.steps >= project.maxSteps) throw new Error(`step budget exhausted for ${taskId}`)
      journal.steps += 1
      await save()
      options.onProgress?.(state)
      try {
        switch (state.state) {
        case 'NEW': {
          const head = await runCommand(root, { executable: 'git', args: ['rev-parse', 'HEAD'] }, project.commandTimeoutMs, signal)
          const dirty = await runCommand(root, { executable: 'git', args: ['status', '--porcelain'] }, project.commandTimeoutMs, signal)
          signal.throwIfAborted()
          if (head.status !== 'PASS' || dirty.status !== 'PASS') throw new Error('cannot capture Git baseline')
          state = await repository.baseline(taskId, state.revision, { repositoryHead: head.stdout.trim(), dirty: dirty.stdout.trim().length > 0, summary: journal.requests.join('\n\n') })
          break
        }
        case 'BASELINED':
        case 'REPLAN': {
          const results = await Promise.allSettled([call('scout-primary'), call('scout-secondary')])
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
          const plan = await call('architect', { challenge: await optionalJson(join(directory, 'CHALLENGE.json')) })
          const challenge = await call('challenger', { candidatePlan: plan })
          await writeFileAtomic(join(directory, 'CHALLENGE.json'), `${JSON.stringify(challenge)}\n`, { mode: 0o600 })
          if (challenge.decision === 'ACCEPT') state = await repository.freezePlan(taskId, state.revision, plan)
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
          state = await repository.finishVerification(taskId, state.revision, execution.verification)
          break
        }
        case 'VERIFIED':
        case 'REVIEWING': {
          await repository.verificationGates(taskId)
          if (journal.verifiedTreeHash === null || await worktreeHash(root) !== journal.verifiedTreeHash) throw new Error('worktree changed after verification; explicitly replan and rerun verification')
          const review = await call('reviewer')
          state = state.state === 'REVIEWING' ? await repository.finishReview(taskId, state.revision, review) : await repository.review(taskId, state.revision, review)
          break
        }
        case 'REVIEWED':
          if (journal.verifiedTreeHash === null || await worktreeHash(root) !== journal.verifiedTreeHash) throw new Error('worktree changed after verification; explicitly replan and rerun verification')
          state = await repository.accept(taskId, state.revision)
          break
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
        if (!(error instanceof EngineeringRoleFailure) && !(error instanceof PlanAssumptionBlocker)) throw error
        state = await repository.block(taskId, state.revision, error.message)
      }
    }
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
