/** Provider-backed fixed Git read lease for one execution-world root. */
import type { Context } from '@deepseek-ai/cordis'
import type { ExecutionWorkspaceId } from './types.ts'
import { bindReadOnlyExecutionWorld } from './read-only.ts'
import { validateGitArgv } from './git-argv.ts'

/** The only execution surface exposed to the consumer Git data plane. */
export interface ExecutionGitExecutor {
  readonly workspaceId: ExecutionWorkspaceId
  readonly emptyFile: 'NUL' | '/dev/null'
  readonly signal: AbortSignal
  execute(
    args: readonly string[],
    options: { maxBytes: number; timeoutMs: number; signal: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

/** A fixed Git executor plus its provider cleanup. */
export interface ExecutionGitLease {
  readonly workspaceId: ExecutionWorkspaceId
  readonly git: ExecutionGitExecutor
  dispose(): Promise<void>
}

/** Acquisition failed and provider cleanup could not be confirmed. */
export class ExecutionGitCleanupError extends Error {
  constructor(cause: AggregateError) {
    super('Git execution workspace cleanup could not be confirmed', { cause })
    this.name = 'ExecutionGitCleanupError'
  }
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_TIMEOUT_MS = 20_000
const GIT_ENV_TOMBSTONES = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_SYSTEM', 'GIT_EXTERNAL_DIFF', 'GIT_ASKPASS',
  'GIT_TRACE', 'GIT_TRACE_PACKET', 'GIT_TRACE_PACK_ACCESS', 'GIT_TRACE_PERFORMANCE',
  'GIT_TRACE_SETUP', 'GIT_TRACE_REFS', 'GIT_TRACE_SHALLOW', 'GIT_TRACE_CURL',
  'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF',
  'GIT_NAMESPACE', 'GIT_REPLACE_REF_BASE', 'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS', 'GIT_EXEC_PATH',
] as const

/** Bind fixed read-only Git execution to the same provider root used by file reads.
 * @param ctx - provider services for this execution world.
 * @param root - provider-resolved workspace root.
 * @param signal - cancellation of lease acquisition and execution.
 * @returns fixed Git executor with joined provider cleanup.
 */
export async function bindExecutionGitLease(ctx: Context, root: string, signal?: AbortSignal): Promise<ExecutionGitLease> {
  let binding: Awaited<ReturnType<typeof bindReadOnlyExecutionWorld>> | undefined
  try {
    binding = await bindReadOnlyExecutionWorld(ctx, root, signal, 'deny')
    const metadata = await binding.fs.stat('.git', signal)
    if (metadata?.type !== 'file' && metadata?.type !== 'directory') throw new Error('Git repository metadata must be inside the bound root')
    const environment = await binding.subprocess.terminalEnvironment(signal)
    if (signal?.aborted === true) signal.throwIfAborted()
    const emptyFile = environment.platform === 'windows' ? 'NUL' : '/dev/null'
    const gitEnvironment: NodeJS.ProcessEnv = Object.fromEntries(GIT_ENV_TOMBSTONES.map(key => [key, undefined]))
    Object.assign(gitEnvironment, {
      GIT_CONFIG_COUNT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyFile,
      GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_NO_LAZY_FETCH: '1', GIT_ATTR_NOSYSTEM: '1',
    })
    const leaseController = new AbortController()
    const abortLease = () => { leaseController.abort(signal?.reason) }
    signal?.addEventListener('abort', abortLease, { once: true })
    const lease = binding
    return {
      workspaceId: lease.workspaceId,
      git: {
        workspaceId: lease.workspaceId,
        emptyFile,
        signal: leaseController.signal,
        async execute(args, options) {
          const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 && options.maxBytes <= MAX_OUTPUT_BYTES
            ? options.maxBytes : 0
          const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 && options.timeoutMs <= MAX_TIMEOUT_MS
            ? options.timeoutMs : 0
          if (maxBytes === 0 || timeoutMs === 0) throw new Error('Git execution limits are not authorized')
          validateGitArgv(args, emptyFile)
          const operation = AbortSignal.any([leaseController.signal, options.signal, AbortSignal.timeout(timeoutMs)])
          const process = await lease.subprocess.start({
            argv: ['git', ...args], env: gitEnvironment, requireFullEnforcement: true,
            stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes }, graceMs: 1_000, signal: operation,
          })
          let outcome: Awaited<typeof process.handle.done>
          try {
            outcome = await process.handle.done
          } finally {
            const exited = await process.handle.waitForExit()
            if (!exited) throw new Error('Git process range did not reach quiescence')
          }
          operation.throwIfAborted()
          const stdout = process.handle.collected.stdout?.readFrom(0)
          const stderr = process.handle.collected.stderr?.readFrom(0)
          if (stdout === undefined || stderr === undefined || stdout.lossy || stderr.lossy) throw new Error('Git output exceeded its byte ceiling')
          if (Buffer.byteLength(stdout.text, 'utf8') > maxBytes || Buffer.byteLength(stderr.text, 'utf8') > maxBytes) {
            throw new Error('Git output exceeded its byte ceiling')
          }
          return { stdout: stdout.text, stderr: stderr.text, exitCode: outcome.exitCode ?? -1 }
        },
      },
      dispose: async () => {
        signal?.removeEventListener('abort', abortLease)
        leaseController.abort(new Error('Git lease disposed'))
        await lease.dispose()
      },
    }
  } catch (error) {
    try {
      await binding?.dispose()
    } catch (cleanupError) {
      throw new ExecutionGitCleanupError(new AggregateError([error, cleanupError], 'Git lease acquisition and cleanup failed'))
    }
    throw error
  }
}
