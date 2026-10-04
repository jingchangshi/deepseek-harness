/** Parent-side invocation and bootstrap state for the private native runner. */

import type { StdioOptions } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import { inspect } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { childEnv } from './spawn.ts'
import { controlEnvironment } from './control-spawn.ts'
import { SUBPROCESS_RUNNER_ENV } from './runner-bootstrap.ts'
import { SUBPROCESS_CONTROL_FD } from '@deepseek-ai/dsh-subprocess/control'

export { consumeRunnerSelection, parseRunnerTargetArgv, resolveWindowsExecutable, SUBPROCESS_RUNNER_ENV, WINDOWS_RUNNER_SELECTION } from './runner-bootstrap.ts'

/** Non-empty command tuple used to launch the private runner entry. */
export type RunnerInvocation = [string, ...string[]]

const SOURCE_TSCONFIG_PATH = fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url))
const RUNNER_CONTROL_ENV_PREFIXES = ['NODE_', 'TSX_'] as const

/**
 * Resolve the source, built, or packaged entry that calls the same runner core.
 * @returns executable and arguments for the active runtime form.
 */
export function spawnRunnerInvocation(): RunnerInvocation {
  if ('pkg' in process) return [process.execPath]
  /* v8 ignore next -- built-artifact smoke imports the emitted JavaScript runner entry;
   * source-unit coverage cannot change import.meta.url. */
  if (extname(fileURLToPath(import.meta.url)) !== '.ts') {
    return [process.execPath, fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/runner'))]
  }
  return [
    process.execPath,
    '--import',
    import.meta.resolve('tsx/esm'),
    fileURLToPath(new URL('./bin.ts', import.meta.url)),
  ]
}

/**
 * Check the concrete runner executable and entry paths without executing a probe mode.
 * @param invocation - resolved executable and runner-entry arguments.
 * @returns whether every concrete executable or entry path is accessible.
 */
export function runnerInvocationAvailable(invocation: RunnerInvocation = spawnRunnerInvocation()): boolean {
  try {
    if (isAbsolute(invocation[0])) accessSync(invocation[0], fsConstants.X_OK)
    const entry = invocation.at(-1)
    if (entry !== undefined && entry !== invocation[0] && isAbsolute(entry)) {
      accessSync(entry, fsConstants.R_OK)
    }
    return true
  } catch {
    return false
  }
}

/**
 * Build the bootstrap-safe environment; target overrides arrive through request/IPC.
 * @param selection - private runner selector or Linux launch-request locator.
 * @param invocation - resolved runner invocation whose source form needs the workspace paths map.
 * @returns environment for the runner before target state is restored.
 */
export function runnerEnvironment(
  selection: string,
  invocation?: RunnerInvocation,
): NodeJS.ProcessEnv {
  const entry = invocation?.at(-1)
  const env = childEnv()
  for (const name of Object.keys(env)) {
    const normalized = name.toUpperCase()
    if (RUNNER_CONTROL_ENV_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
      Reflect.deleteProperty(env, name)
    }
  }
  return {
    ...env,
    [SUBPROCESS_RUNNER_ENV]: selection,
    SYSTEMD_LOG_TARGET: 'null',
    ...entry?.endsWith('.ts') === true ? { TSX_TSCONFIG_PATH: SOURCE_TSCONFIG_PATH } : {},
  }
}

/**
 * Build direct Linux target stdio, or isolated Windows runner stdio with IPC
 * on fd 3 and target carriers on fd 4 through fd 6; optional control uses fd 7.
 * @param spec - ordinary subprocess request whose stdio modes are preserved.
 * @param ipc - whether to isolate the runner and add its private Node IPC descriptor.
 * @param stdinCarrier - runner fd 4 carrier; Windows ignore passes an opened null-device fd.
 * @returns child-process stdio options for the runner.
 */
export function runnerStdio(
  spec: SubprocessSpawnSpec,
  ipc: boolean,
  stdinCarrier: 'pipe' | number = 'pipe',
): StdioOptions {
  const targetStdio: StdioOptions = [
    spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe',
    spec.stdio.stdout === 'inherit' ? 'inherit' : 'pipe',
    spec.stdio.stderr === 'inherit' ? 'inherit' : 'pipe',
  ]
  if (!ipc) {
    if (spec.stdio.control === 'pipe') {
      while (targetStdio.length < SUBPROCESS_CONTROL_FD) targetStdio.push('ignore')
      targetStdio.push('overlapped')
    }
    return targetStdio
  }
  const runner: StdioOptions = [
    'ignore',
    'ignore',
    'ignore',
    'ipc',
    stdinCarrier,
    spec.stdio.stdout === 'inherit' ? 1 : 'pipe',
    spec.stdio.stderr === 'inherit' ? 2 : 'pipe',
  ]
  if (spec.stdio.control === 'pipe') runner.push('overlapped')
  return runner
}

function throwNullByteError(property: string, value: string, argument: boolean): never {
  const subject = argument ? `The argument '${property}'` : `The property '${property}'`
  const error = new TypeError(`${subject} must be a string without null bytes. Received ${inspect(value)}`)
  Object.assign(error, { code: 'ERR_INVALID_ARG_VALUE' })
  throw error
}

function validateNoNullByte(property: string, value: string, argument = false): void {
  if (value.includes('\0')) throwNullByteError(property, value, argument)
}

/**
 * Materialize and synchronously validate the final target environment.
 * @param spec - final target argv, cwd, and environment overrides.
 * @returns complete target environment after Node-equivalent validation.
 */
export function targetEnvironment(
  spec: Pick<SubprocessSpawnSpec, 'argv' | 'cwd' | 'env'> & { stdio?: SubprocessSpawnSpec['stdio'] },
): Record<string, string> {
  spec.argv.forEach((value, index) => {
    validateNoNullByte(index === 0 ? 'file' : `args[${String(index - 1)}]`, value, true)
  })
  validateNoNullByte('options.cwd', spec.cwd)
  const env = Object.fromEntries(
    Object.entries(childEnv(spec.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  for (const [key, value] of Object.entries(env)) {
    validateNoNullByte(`options.env['${key}']`, key)
    validateNoNullByte(`options.env['${key}']`, value)
  }
  return controlEnvironment(env, spec.stdio?.control)
}
