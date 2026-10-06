/** Shell-free runner resolution and process-group teardown for verification commands. */

import { isAbsolute, posix, resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import { launchLinuxScope, probeLinuxNative } from '@deepseek-ai/dsh-subprocess-local/src/linux-scope.ts'

/** Local commands use a project-relative or absolute working directory. */
export interface LocalRunner {
  kind: 'local'
  workingDirectory: string
}

/** Docker executes inside an existing container; every deployment choice is explicit. */
export interface DockerRunner {
  kind: 'docker'
  executable: string
  container: string
  user: string
  home: string
  workingDirectory: string
}

/** Supported execution providers; SSH and remote configuration are rejected. */
export type Runner = LocalRunner | DockerRunner

/** Only named host variables and literal assignments reach the command. Secret names are forbidden. */
export interface RunnerEnvironment {
  set: Readonly<Record<string, string>>
  inherit: readonly string[]
}

/** Arguments are individual tokens, never shell text; env is mandatory even when empty. */
export interface RunnerCommand {
  executable: string
  args: readonly string[]
  env: RunnerEnvironment
}

/** Placeholder values in the execution filesystem; empty baseRevision is valid unless its placeholder is used. */
export interface RunnerContext {
  projectRoot: string
  baseRevision: string
  changedFiles: readonly string[]
  selectedTests: readonly string[]
}

/** Fully resolved host invocation, including target env in Docker exec arguments. */
export interface ResolvedRunnerCommand {
  kind: Runner['kind']
  executable: string
  args: readonly string[]
  workingDirectory: string
  env: Readonly<Record<string, string>>
}

/** Explicit execution limits; terminationTimeoutMs bounds descendant confirmation, not parent exit. */
export interface RunnerExecutionOptions {
  timeoutMs: number
  terminationTimeoutMs: number
  outputLimitBytes: number
  signal?: AbortSignal
}

/** Independent execution outcomes; UNCERTAIN forbids treating a successful exit as safe recovery. */
export interface RunnerResult {
  status: 'PASS' | 'FAIL' | 'INCOMPLETE' | 'NOT_RUN'
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  quiescence: 'CONFIRMED' | 'UNCERTAIN'
}

const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD/i
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function object(value: unknown, field: string, keys?: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${field} must be a plain object`)
  }
  const record = value as Record<string, unknown>
  if (keys !== undefined) {
    for (const key of Object.keys(record)) {
      if (!keys.includes(key)) throw new Error(`${field}.${key} is not supported`)
    }
  }
  return record
}

function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0) || value.includes('\0')) {
    throw new Error(`${field} must be ${allowEmpty ? 'a' : 'a nonempty'} NUL-free string`)
  }
  return value
}

function texts(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be a string array`)
  return Array.from(value, (entry: unknown, index) => text(entry, `${field}[${index}]`, true))
}

function envName(value: unknown): string {
  const name = text(value, 'env name')
  if (!ENV_NAME.test(name) || SECRET_NAME.test(name)) throw new Error(`env name ${name} is invalid or secret-bearing`)
  return name
}

function environment(value: unknown): RunnerEnvironment {
  const raw = object(value, 'env', ['set', 'inherit'])
  const set: Record<string, string> = Object.create(null)
  for (const [name, entry] of Object.entries(object(raw.set, 'env.set'))) {
    set[envName(name)] = text(entry, `env.set.${name}`, true)
  }
  const inherit = texts(raw.inherit, 'env.inherit').map(envName)
  const names = [...Object.keys(set), ...inherit].map(name => name.toUpperCase())
  if (new Set(names).size !== names.length) throw new Error('env names must be unique across set and inherit, ignoring case')
  return { set, inherit }
}

function absolute(value: unknown, field: string, docker = false): string {
  const path = text(value, field)
  if (!(docker ? posix.isAbsolute(path) : isAbsolute(path))) throw new Error(`${field} must be absolute`)
  return path
}

/**
 * Validate runner configuration with no implicit deployment defaults or unknown keys.
 * @param config - local { kind, workingDirectory } or Docker { kind, executable, container, user, home, workingDirectory }.
 * @returns a validated copy; SSH, remote, and unknown providers throw unsupported errors.
 */
export function resolveRunner(config: unknown): Runner {
  const raw = object(config, 'runner')
  switch (raw.kind) {
    case 'local':
      object(raw, 'runner', ['kind', 'workingDirectory'])
      return { kind: 'local', workingDirectory: text(raw.workingDirectory, 'runner.workingDirectory') }
    case 'docker': {
      object(raw, 'runner', ['kind', 'executable', 'container', 'user', 'home', 'workingDirectory'])
      const container = text(raw.container, 'runner.container')
      const user = text(raw.user, 'runner.user')
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) throw new Error('runner.container must be a container name or ID')
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(user)) throw new Error('runner.user must be a user or uid[:gid]')
      return {
        kind: 'docker', executable: absolute(raw.executable, 'runner.executable'), container, user,
        home: absolute(raw.home, 'runner.home', true),
        workingDirectory: raw.workingDirectory === '{{PROJECT_ROOT}}' ? raw.workingDirectory : absolute(raw.workingDirectory, 'runner.workingDirectory', true),
      }
    }
    default:
      throw new Error(`unsupported runner kind: ${String(raw.kind)}`)
  }
}

function expand(argument: string, context: RunnerContext): string[] {
  switch (argument) {
    case '{{PROJECT_ROOT}}': return [context.projectRoot]
    case '{{BASE_REVISION}}':
      if (context.baseRevision.length === 0) throw new Error('{{BASE_REVISION}} requires a nonempty context.baseRevision')
      return [context.baseRevision]
    case '{{CHANGED_FILES}}': return [...context.changedFiles]
    case '{{SELECTED_TESTS}}': return [...context.selectedTests]
    default:
      if (argument.includes('{{') || argument.includes('}}')) throw new Error('argv placeholders must be known, complete arguments')
      return [argument]
  }
}

/**
 * Resolve exact scalar/list argv placeholders and an allowlisted environment without shell parsing.
 * @param runner - validated provider; local workingDirectory resolves against context.projectRoot.
 * @param command - executable, argv, and explicit env.set/env.inherit; missing inherited values throw.
 * @param context - all four placeholder values; projectRoot is also Docker's absolute host cwd.
 * @param hostEnvironment - host values available for explicit inheritance; defaults to process.env.
 * @returns a host invocation; Docker HOME belongs exclusively to runner.home, and no ambient env is copied.
 */
export function resolveRunnerCommand(
  runner: Runner,
  command: RunnerCommand,
  context: RunnerContext,
  hostEnvironment: NodeJS.ProcessEnv = process.env,
): ResolvedRunnerCommand {
  const provider = resolveRunner(runner)
  const raw = object(command, 'command', ['executable', 'args', 'env'])
  const executable = text(raw.executable, 'command.executable')
  if (executable.includes('{{') || executable.includes('}}')) throw new Error('command.executable cannot contain placeholders')
  const input = object(context, 'context', ['projectRoot', 'baseRevision', 'changedFiles', 'selectedTests'])
  const values: RunnerContext = {
    projectRoot: absolute(input.projectRoot, 'context.projectRoot', provider.kind === 'docker'),
    baseRevision: text(input.baseRevision, 'context.baseRevision', true),
    changedFiles: texts(input.changedFiles, 'context.changedFiles'),
    selectedTests: texts(input.selectedTests, 'context.selectedTests'),
  }
  const args = texts(raw.args, 'command.args').flatMap(argument => expand(argument, values))
  const envConfig = environment(raw.env)
  const env: Record<string, string> = Object.create(null)
  for (const name of envConfig.inherit) {
    if (!Object.hasOwn(hostEnvironment, name) || hostEnvironment[name] === undefined) throw new Error(`env.inherit.${name} is absent from host environment`)
    env[name] = text(hostEnvironment[name], `host env.${name}`, true)
  }
  Object.assign(env, envConfig.set)
  switch (provider.kind) {
    case 'local':
      return { kind: 'local', executable, args, workingDirectory: resolve(values.projectRoot, provider.workingDirectory), env }
    case 'docker': {
      if (Object.keys(env).some(name => name.toUpperCase() === 'HOME')) throw new Error('Docker HOME must be supplied through runner.home, not command.env')
      return {
        kind: 'docker', executable: provider.executable, workingDirectory: values.projectRoot, env,
        args: [
          'exec', '--user', provider.user, '--workdir', provider.workingDirectory === '{{PROJECT_ROOT}}' ? values.projectRoot : provider.workingDirectory, '--env', `HOME=${provider.home}`,
          ...Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
          '--', provider.container, executable, ...args,
        ],
      }
    }
  }
}

function positive(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
    throw new Error(`${field} must be an integer between 1 and 2147483647`)
  }
  return value
}

let nativeProbePassed = false

/**
 * Execute commands in the maintained Linux subprocess scope and prove the managed range empty.
 * @param command - resolved provider invocation with an explicit target environment.
 * @param options - command timeout, range-confirmation timeout and output limit.
 * @returns independent status, exit, timeout, output and range-quiescence outcomes.
 */
export async function executeRunnerCommand(command: ResolvedRunnerCommand, options: RunnerExecutionOptions): Promise<RunnerResult> {
  const raw = object(command, 'resolved command', ['kind', 'executable', 'args', 'workingDirectory', 'env'])
  if (raw.kind !== 'local' && raw.kind !== 'docker') throw new Error(`unsupported runner kind: ${String(raw.kind)}`)
  const kind = raw.kind
  const executable = text(raw.executable, 'resolved executable')
  const args = texts(raw.args, 'resolved args')
  const cwd = absolute(raw.workingDirectory, 'resolved workingDirectory')
  const env = environment({ set: raw.env, inherit: [] }).set
  const limits = object(options, 'execution options', ['timeoutMs', 'terminationTimeoutMs', 'outputLimitBytes', 'signal'])
  const timeoutMs = positive(limits.timeoutMs, 'timeoutMs')
  const terminationTimeoutMs = positive(limits.terminationTimeoutMs, 'terminationTimeoutMs')
  const outputLimitBytes = positive(limits.outputLimitBytes, 'outputLimitBytes')
  const signal = limits.signal
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('signal must be an AbortSignal')
  if (signal?.aborted) return { status: 'INCOMPLETE', exitCode: null, timedOut: false, stdout: '', stderr: '', quiescence: 'CONFIRMED' }
  if (process.platform !== 'linux' || !(nativeProbePassed || probeLinuxNative())) {
    return { status: 'NOT_RUN', exitCode: null, timedOut: false, stdout: '', stderr: 'OS-owned Linux process containment is unavailable; no command was launched', quiescence: 'CONFIRMED' }
  }
  nativeProbePassed = true
  const launch = launchLinuxScope({ argv: [executable, ...args], cwd, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: terminationTimeoutMs }, { ...env })
  let stdout: Buffer = Buffer.alloc(0)
  let stderr: Buffer = Buffer.alloc(0)
  const append = (current: Buffer, chunk: Buffer): Buffer => Buffer.concat([current, chunk]).subarray(-outputLimitBytes)
  launch.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
  launch.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
  let timedOut = false
  let cancelled = false
  let launchFailed = false
  const terminate = (): void => {
    try { launch.owner.signal('SIGKILL') } catch (error) { stderr = append(stderr, Buffer.from(String(error))) }
  }
  const abort = (): void => { cancelled = true; terminate() }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const timeout = setTimeout(() => { timedOut = true; terminate() }, timeoutMs)
  let exitCode: number | null = null
  try {
    exitCode = (await launch.direct).exitCode
  } catch (error) {
    launchFailed = true
    stderr = append(stderr, Buffer.from(String(error)))
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
  terminate()
  let confirmationTimer: ReturnType<typeof setTimeout> | undefined
  const stopped = launch.owner.waitForExit().then(() => true, error => {
    stderr = append(stderr, Buffer.from(String(error)))
    return false
  })
  const confirmed = await Promise.race([stopped, new Promise<boolean>(settle => {
    confirmationTimer = setTimeout(() => { settle(false) }, terminationTimeoutMs)
  })])
  clearTimeout(confirmationTimer)
  if (confirmed) {
    await Promise.all([launch.stdout, launch.stderr].flatMap(stream => stream === null ? [] : [finished(stream, { cleanup: true }).catch(error => {
      launchFailed = true
      stderr = append(stderr, Buffer.from(String(error)))
    })]))
    launch.owner.cleanup?.()
  } else {
    launch.stdout?.destroy()
    launch.stderr?.destroy()
    void stopped.then(empty => { if (empty) launch.owner.cleanup?.() })
  }
  const uncertain = !confirmed || (kind === 'docker' && (timedOut || cancelled))
  return {
    status: cancelled ? 'INCOMPLETE' : timedOut || exitCode !== 0 || launchFailed || uncertain ? 'FAIL' : 'PASS',
    exitCode, timedOut, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), quiescence: uncertain ? 'UNCERTAIN' : 'CONFIRMED',
  }
}
