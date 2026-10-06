/** Cross-platform verification profile execution without shell parsing. */

import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { deepEqualJson, isJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { VerificationIdentity } from './identity.ts'
import { executeRunnerCommand, resolveRunner, resolveRunnerCommand } from './runner.ts'
import type { ResolvedRunnerCommand, Runner, RunnerContext, RunnerEnvironment } from './runner.ts'
import type { CheckStatus, EvidenceDocument, VerificationDocument } from './types.ts'

/** Canonical check-name and scope identity. */
export type VerificationInstanceId = Branded<'VerificationInstanceId'>

/** Canonical identity of a resolved provider invocation. */
export type VerificationCommandIdentity = Branded<'VerificationCommandIdentity'>

/** One logical verification gate. */
export interface VerificationGate {
  name: string
  category: string
  required: boolean
  timeoutMs: number
  scope: Record<string, JsonValue>
  adapter: string
}

/** Command adapter supplied by the target project. */
export interface CommandAdapter {
  executable: string
  args: string[]
  cwd?: string
  platforms?: NodeJS.Platform[]
  runner?: Runner
  env?: RunnerEnvironment
  terminationTimeoutMs?: number
  outputLimitBytes?: number
}

const PROJECT_ROOT_ARGUMENT = '{{PROJECT_ROOT}}'

/** Project-local adapters and tested target scope. */
export interface ProjectVerificationConfig {
  adapters: Readonly<Record<string, CommandAdapter>>
  scope?: Record<string, object | string | number | boolean | null>
  selectedTests?: string[]
  inputs?: string[]
}

/** Result and bounded diagnostics for one command. */
export interface CommandResult {
  status: CheckStatus
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  quiescence: 'CONFIRMED' | 'UNCERTAIN'
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`)
  return Object.fromEntries(Object.entries(value))
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`)
  return value
}

function scopeObject(value: unknown, field: string): Record<string, JsonValue> {
  if (!isJsonValue(value)) throw new Error(`${field} must be lossless JSON data`)
  return object(value, field) as Record<string, JsonValue>
}

function gate(value: unknown, index: number): VerificationGate {
  const item = object(value, `checks[${String(index)}]`)
  if (typeof item.required !== 'boolean') throw new Error(`checks[${String(index)}].required must be boolean`)
  if (!Number.isSafeInteger(item.timeoutMs) || typeof item.timeoutMs !== 'number' || item.timeoutMs < 1 || item.timeoutMs > 2147483647) {
    throw new Error(`checks[${String(index)}].timeoutMs must be a positive integer`)
  }
  return {
    name: text(item.name, `checks[${String(index)}].name`),
    category: text(item.category, `checks[${String(index)}].category`),
    required: item.required,
    timeoutMs: item.timeoutMs,
    scope: scopeObject(item.scope === undefined ? {} : item.scope, `checks[${String(index)}].scope`),
    adapter: item.adapter === undefined ? text(item.name, `checks[${String(index)}].name`) : text(item.adapter, `checks[${String(index)}].adapter`),
  }
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Derive an instance identity without interpreting repository scope values.
 * @param instance - check name and lossless JSON scope.
 * @returns SHA-256 of the canonical name-and-scope pair.
 */
export function verificationInstanceId(instance: { name: string; scope: Record<string, JsonValue> }): VerificationInstanceId {
  return createHash('sha256').update(canonicalJson([instance.name, instance.scope])).digest('hex') as VerificationInstanceId
}

/**
 * Validate durable instance uniqueness and current required profile results.
 * @param gates - current repository profile instances.
 * @param verification - parsed verification artifact.
 * @returns nothing when every required instance passes exactly once.
 */
export function assertRequiredVerification(gates: readonly VerificationGate[], verification: Omit<VerificationDocument, 'schemaVersion'>): void {
  const checks = new Map<VerificationInstanceId, VerificationDocument['checks'][number]>()
  for (const check of verification.checks) {
    if (!isJsonValue(check.scope)) throw new Error('verification scope must be lossless JSON data')
    const identity = verificationInstanceId(check)
    if (checks.has(identity)) throw new Error('verification has duplicate instances')
    checks.set(identity, check)
  }
  for (const gate of gates.filter(item => item.required)) {
    const check = checks.get(verificationInstanceId(gate))
    if (check === undefined || check.category !== gate.category || !check.required || check.status !== 'PASS' || check.evidenceIds.length === 0) {
      throw new Error(`acceptance lacks passing required instance ${gate.name}`)
    }
  }
}

/**
 * Require scoped, successful command records for every policy-required instance.
 * @param gates - current repository profile instances.
 * @param verification - validated current verification artifact.
 * @param evidence - validated immutable evidence records from this task.
 * @param identity - sealed source, policy and attempt identity required on each command record.
 * @param commands - resolved declared commands for each required instance.
 * @returns nothing when all required references resolve to matching completed commands.
 */
export function assertVerificationEvidence(gates: readonly VerificationGate[], verification: Omit<VerificationDocument, 'schemaVersion'>, evidence: readonly EvidenceDocument[], identity: VerificationIdentity, commands: ReadonlyMap<VerificationInstanceId, ResolvedRunnerCommand>): void {
  assertRequiredVerification(gates, verification)
  const referencedIds = new Set(verification.checks.flatMap(check => check.evidenceIds))
  const records = new Map<string, EvidenceDocument>()
  for (const record of evidence) {
    if (!referencedIds.has(record.id)) continue
    if (records.has(record.id)) throw new Error('acceptance has duplicate evidence IDs')
    records.set(record.id, record)
  }
  const checks = new Map(verification.checks.map(check => [verificationInstanceId(check), check]))
  for (const gate of gates.filter(item => item.required)) {
    const check = checks.get(verificationInstanceId(gate))
    if (check === undefined) throw new Error(`acceptance lacks passing required instance ${gate.name}`)
    const declared = commands.get(verificationInstanceId(gate))
    if (declared === undefined) throw new Error(`acceptance lacks declared command for ${gate.name}`)
    for (const id of check.evidenceIds) {
      const record = records.get(id)
      if (record === undefined || record.kind !== 'command' || record.status !== 'PASS' || record.taskId !== verification.taskId || record.workRevision !== verification.workRevision) {
        throw new Error(`acceptance lacks command evidence for ${gate.name}`)
      }
      if (record.scope.name !== gate.name || record.scope.category !== gate.category || !deepEqualJson(record.scope.verificationScope, gate.scope)) {
        throw new Error(`acceptance lacks scoped command evidence for ${gate.name}`)
      }
      if (!deepEqualJson(record.scope.identity, identity)) throw new Error(`acceptance evidence identity changed for ${gate.name}`)
      if (record.command?.exitCode !== 0 || record.command.timedOut !== false) throw new Error(`acceptance requires completed command for ${gate.name}`)
      if (record.scope.quiescence !== 'CONFIRMED') throw new Error(`acceptance requires confirmed command termination for ${gate.name}`)
      if (record.command.executable !== declared.executable || !deepEqualJson(record.command.args, [...declared.args]) || record.command.cwd !== declared.workingDirectory
        || record.scope.commandIdentity !== verificationCommandIdentity(declared)) throw new Error(`acceptance command identity changed for ${gate.name}`)
    }
  }
}

/**
 * Validate a repository-defined profile identifier before filesystem access.
 * @param value - identifier from CLI, project configuration, or a durable task.
 * @returns the identifier containing only lowercase ASCII letters, digits, and hyphens, starting with a letter or digit.
 */
export function validateVerificationProfileId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*(?![\s\S])/.test(value)) throw new Error('invalid verification profile ID')
  return value
}

/**
 * Load one committed verification profile.
 * @param root - repository root.
 * @param profile - lowercase ASCII identifier matching the committed file's declaration.
 * @param source - optional repository-captured profile bytes decoded as UTF-8.
 * @returns validated logical verification gates.
 */
export async function loadVerificationProfile(root: string, profile: string, source?: string): Promise<VerificationGate[]> {
  validateVerificationProfileId(profile)
  const value = object(load(source ?? await readFile(resolve(root, '.agent/profiles', `${profile}.yaml`), 'utf8')), profile)
  if (value.schemaVersion !== 1 || value.id !== profile || !Array.isArray(value.checks)) throw new Error(`invalid ${profile} profile`)
  const gates = value.checks.map(gate)
  if (new Set(gates.map(verificationInstanceId)).size !== gates.length) throw new Error(`${profile} profile has duplicate checks`)
  return gates
}

/**
 * Load target-owned command adapters from JSON or YAML.
 * @param filename - project verification configuration path.
 * @param source - optional repository-captured configuration bytes decoded as UTF-8.
 * @returns validated argv commands and optional tested scope.
 */
export async function loadProjectVerificationConfig(filename: string, source?: string): Promise<ProjectVerificationConfig> {
  const document = object(load(source ?? await readFile(filename, 'utf8')), filename)
  if (Object.keys(document).some(key => !['schemaVersion', 'adapters', 'commands', 'runners', 'scope', 'selectedTests', 'inputs'].includes(key))) throw new Error('unsupported command configuration field')
  if (document.schemaVersion !== undefined && document.schemaVersion !== 1) throw new Error('unsupported command configuration schemaVersion')
  const runners = document.runners === undefined ? {} : object(document.runners, `${filename}.runners`)
  const resolvedRunners = Object.fromEntries(Object.entries(runners).map(([name, configuration]) => [name, resolveRunner(configuration)]))
  const adapters: Record<string, CommandAdapter> = {}
  if (document.commands !== undefined && document.adapters !== undefined) throw new Error('declare commands or adapters, not both')
  for (const [name, rawValue] of Object.entries(object(document.commands ?? document.adapters, `${filename}.commands`))) {
    const value = object(rawValue, `${filename}.adapters.${name}`)
    if (Object.keys(value).some(key => !['executable', 'args', 'cwd', 'platforms', 'runner', 'env', 'terminationTimeoutMs', 'outputLimitBytes'].includes(key))) throw new Error(`unsupported command field for ${name}`)
    if (value.cwd !== undefined && value.runner !== undefined) throw new Error('cwd belongs to the named runner, not the command')
    if (!Array.isArray(value.args) || !value.args.every(argument => typeof argument === 'string')) {
      throw new Error(`${filename}.adapters.${name}.args must be a string array`)
    }
    if (value.platforms !== undefined && (!Array.isArray(value.platforms) || !value.platforms.every(platform => typeof platform === 'string'))) {
      throw new Error(`${filename}.adapters.${name}.platforms must be a string array`)
    }
    let runner: Runner | undefined
    if (value.runner !== undefined) {
      const id = text(value.runner, `${filename}.commands.${name}.runner`)
      runner = resolvedRunners[id]
      if (runner === undefined) throw new Error(`undeclared runner: ${id}`)
    }
    for (const field of ['terminationTimeoutMs', 'outputLimitBytes']) {
      if (value[field] !== undefined && (typeof value[field] !== 'number' || !Number.isSafeInteger(value[field]) || value[field] < 1 || value[field] > 2147483647)) throw new Error(`${field} must be a positive integer within the runner limit`)
    }
    const env = value.env === undefined ? undefined : object(value.env, `${filename}.commands.${name}.env`)
    if (env !== undefined && Object.keys(env).some(key => !['set', 'inherit'].includes(key))) throw new Error('unsupported env field')
    if (env !== undefined && (!Array.isArray(env.inherit) || !env.inherit.every(name => typeof name === 'string')
      || Object.values(object(env.set, 'env.set')).some(value => typeof value !== 'string'))) throw new Error('env requires string set values and an inherit array')
    adapters[name] = {
      executable: text(value.executable, `${filename}.adapters.${name}.executable`),
      args: value.args,
      ...value.cwd === undefined ? {} : { cwd: text(value.cwd, `${filename}.adapters.${name}.cwd`) },
      ...value.platforms === undefined ? {} : { platforms: value.platforms as NodeJS.Platform[] },
      ...runner === undefined ? {} : { runner },
      ...env === undefined ? {} : { env: { set: env.set as Record<string, string>, inherit: env.inherit as string[] } },
      ...value.terminationTimeoutMs === undefined ? {} : { terminationTimeoutMs: value.terminationTimeoutMs as number },
      ...value.outputLimitBytes === undefined ? {} : { outputLimitBytes: value.outputLimitBytes as number },
    }
    resolveVerificationCommand(resolve(filename, '../../..'), adapters[name], { projectRoot: resolve(filename, '../../..'), baseRevision: 'validation-only', changedFiles: [], selectedTests: [] })
  }
  if (document.selectedTests !== undefined && (!Array.isArray(document.selectedTests) || !document.selectedTests.every(value => typeof value === 'string'))) throw new Error('selectedTests must be a string array')
  if (document.inputs !== undefined && (!Array.isArray(document.inputs) || !document.inputs.every(value => typeof value === 'string' && value.length > 0))) throw new Error('inputs must be a nonempty-path string array')
  return {
    adapters,
    ...document.scope === undefined ? {} : { scope: scopeObject(document.scope, `${filename}.scope`) },
    ...document.selectedTests === undefined ? {} : { selectedTests: document.selectedTests as string[] },
    ...document.inputs === undefined ? {} : { inputs: document.inputs as string[] },
  }
}

/**
 * Resolve provider, environment and argv without evaluating shell strings.
 * @param root - target repository root.
 * @param adapter - declared command and execution provider.
 * @param context - frozen source and explicitly selected test arguments, if available.
 * @returns the exact host invocation used for command identity and execution.
 */
export function resolveVerificationCommand(root: string, adapter: CommandAdapter, context?: RunnerContext): ResolvedRunnerCommand {
  return resolveRunnerCommand(adapter.runner ?? { kind: 'local', workingDirectory: adapter.cwd ?? '.' }, {
    executable: adapter.executable, args: adapter.args,
    env: adapter.env ?? { set: {}, inherit: ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'USERPROFILE'].filter(name => process.env[name] !== undefined) },
  }, context ?? { projectRoot: resolve(root), baseRevision: '', changedFiles: [], selectedTests: [] })
}

/**
 * Identify the executed provider, argv, cwd and resolved environment.
 * @param command - resolved host invocation.
 * @returns canonical SHA-256 identity for deterministic command evidence.
 */
export function verificationCommandIdentity(command: ResolvedRunnerCommand): VerificationCommandIdentity {
  return createHash('sha256').update(canonicalJson({ kind: command.kind, executable: command.executable, args: [...command.args], cwd: command.workingDirectory, env: { ...command.env } })).digest('hex') as VerificationCommandIdentity
}

/**
 * Resolve the exact project-root argv placeholder without evaluating command text.
 * @param root - target project root.
 * @param adapter - configured executable and arguments.
 * @returns an adapter whose standalone project-root arguments are absolute paths.
 */
export function resolveCommandAdapter(root: string, adapter: CommandAdapter): CommandAdapter {
  for (const argument of adapter.args) {
    if (argument.includes(PROJECT_ROOT_ARGUMENT) && argument !== PROJECT_ROOT_ARGUMENT) {
      throw new Error(`${PROJECT_ROOT_ARGUMENT} must be a complete command argument`)
    }
  }
  return {
    ...adapter,
    args: adapter.args.map(argument => argument === PROJECT_ROOT_ARGUMENT ? resolve(root) : argument),
  }
}

/**
 * Execute one argv adapter with a bounded output capture.
 * @param root - target project root.
 * @param adapter - executable, arguments, and optional relative cwd.
 * @param timeoutMs - hard execution timeout.
 * @param signal - cancellation signal that waits for provider termination reporting.
 * @param context - frozen source and selected test arguments.
 * @returns terminal status and bounded process output.
 */
export async function runCommand(root: string, adapter: CommandAdapter, timeoutMs: number, signal?: AbortSignal, context?: RunnerContext): Promise<CommandResult> {
  if (adapter.platforms !== undefined && !adapter.platforms.includes(process.platform)) {
    return { status: 'NOT_RUN', exitCode: null, timedOut: false, stdout: '', stderr: `unsupported platform ${process.platform}`, quiescence: 'CONFIRMED' }
  }
  return executeRunnerCommand(resolveVerificationCommand(root, adapter, context), {
    timeoutMs, terminationTimeoutMs: adapter.terminationTimeoutMs ?? timeoutMs,
    outputLimitBytes: adapter.outputLimitBytes ?? 16384, ...signal === undefined ? {} : { signal },
  })
}

/**
 * Run a profile through target-owned command adapters.
 * @param root - target project root.
 * @param profile - task profile identifier.
 * @param project - target-owned commands and tested scope.
 * @param signal - optional cancellation signal.
 * @param effectiveGates - repository-resolved cumulative required instances.
 * @param context - frozen source arguments used for typed argv expansion.
 * @param identity - dispatch-time source and policy identity retained by every command result.
 * @param preflight - awaited identity validation before each command dispatch; required for identity-bearing results.
 * @returns verification input plus independent instance executions in profile order.
 */
export async function runVerificationProfile(
  root: string,
  profile: string,
  project: ProjectVerificationConfig,
  signal?: AbortSignal,
  effectiveGates?: readonly VerificationGate[],
  context?: RunnerContext,
  identity?: VerificationIdentity,
  preflight?: () => Promise<void>,
): Promise<VerificationExecution> {
  if (identity !== undefined && preflight === undefined) throw new Error('identity-bearing verification requires repository preflight')
  const gates = effectiveGates === undefined ? await loadVerificationProfile(root, profile) : effectiveGates
  const results: VerificationExecution['results'] = []
  const checks = []
  for (const item of gates) {
    if (signal?.aborted) break
    if (preflight !== undefined) await preflight()
    signal?.throwIfAborted()
    const adapter = project.adapters[item.adapter]
    const result = adapter === undefined
      ? { status: 'NOT_RUN' as const, exitCode: null, timedOut: false, stdout: '', stderr: 'adapter not configured', quiescence: 'CONFIRMED' as const }
      : await runCommand(root, adapter, item.timeoutMs, signal, context)
    const invocation = adapter === undefined ? undefined : resolveVerificationCommand(root, adapter, context)
    results.push({ instance: item, command: invocation === undefined ? undefined : { executable: invocation.executable, args: [...invocation.args], cwd: invocation.workingDirectory },
      result, ...invocation === undefined ? {} : { commandIdentity: verificationCommandIdentity(invocation) } })
    checks.push({ name: item.name, category: item.category, scope: item.scope, required: item.required, status: result.status, evidenceIds: [] })
    if (result.quiescence === 'UNCERTAIN') break
  }
  const required = checks.filter(item => item.required)
  const status: CheckStatus = checks.length !== gates.length ? 'INCOMPLETE' : required.some(item => item.status === 'FAIL')
    ? 'FAIL'
    : required.some(item => item.status === 'INCOMPLETE')
      ? 'INCOMPLETE'
      : required.some(item => item.status === 'NOT_RUN')
        ? 'NOT_RUN'
        : 'PASS'
  return {
    verification: { status, checks, scope: { profile, ...(project.scope ?? {}) }, ...identity === undefined ? {} : { identity } },
    results,
    ...identity === undefined ? {} : { identity },
  }
}

/** Independent executions and the verification artifact input they produce. */
export interface VerificationExecution {
  verification: Omit<VerificationDocument, 'schemaVersion' | 'taskId' | 'taskRevision' | 'workRevision'> & { identity?: VerificationIdentity }
  results: Array<{ instance: VerificationGate; command: CommandAdapter | undefined; result: CommandResult; commandIdentity?: VerificationCommandIdentity }>
  identity?: VerificationIdentity
}

/**
 * Assign fresh evidence references and project resolved command executions.
 * @param root - repository root used for command working directories.
 * @param execution - completed instance executions whose checks receive evidence references.
 * @returns immutable-record inputs for the repository evidence writer.
 */
export function verificationEvidence(root: string, execution: VerificationExecution): Array<Omit<EvidenceDocument, 'schemaVersion' | 'taskId' | 'workRevision'>> {
  const runId = randomUUID()
  return execution.results.map(({ instance, command, result, commandIdentity }, index) => {
    const id = `${runId}:${verificationInstanceId(instance)}`
    const check = execution.verification.checks[index]
    if (check === undefined) throw new Error('execution is missing its verification check')
    check.evidenceIds = [id]
    return {
      id, kind: 'command', status: result.status, timestamp: new Date().toISOString(), summary: `${instance.name}: ${result.status}`,
      scope: { name: instance.name, category: instance.category, verificationScope: instance.scope, stdout: result.stdout, stderr: result.stderr,
        quiescence: result.quiescence, ...commandIdentity === undefined ? {} : { commandIdentity }, ...execution.identity === undefined ? {} : { identity: execution.identity } },
      ...command === undefined ? {} : { command: { executable: command.executable, args: command.args, cwd: resolve(root, command.cwd ?? '.'), exitCode: result.exitCode, timedOut: result.timedOut } },
    }
  })
}
