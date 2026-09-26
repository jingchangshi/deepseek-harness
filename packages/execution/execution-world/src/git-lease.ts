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

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_TIMEOUT_MS = 20_000

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
    const environment = await ctx.subprocess.terminalEnvironment(signal)
    if (signal?.aborted === true) signal.throwIfAborted()
    const emptyFile = environment.platform === 'windows' ? 'NUL' : '/dev/null'
    const leaseController = new AbortController()
    if (signal !== undefined) signal.addEventListener('abort', () => leaseController.abort(signal.reason), { once: true })
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
            argv: ['git', ...args], stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes }, graceMs: 1_000, signal: operation,
          })
          const outcome = await process.handle.done
          const exited = await process.handle.waitForExit()
          if (!exited) throw new Error('Git process range did not reach quiescence')
          operation.throwIfAborted()
          const stdout = process.handle.collected.stdout?.readFrom(0)
          const stderr = process.handle.collected.stderr?.readFrom(0)
          if (stdout === undefined || stderr === undefined || stdout.lossy || stderr.lossy) throw new Error('Git output exceeded its byte ceiling')
          return { stdout: stdout.text, stderr: stderr.text, exitCode: outcome.exitCode ?? -1 }
        },
      },
      dispose: async () => { leaseController.abort(new Error('Git lease disposed')); await lease.dispose() },
    }
  } catch (error) {
    await binding?.dispose().catch(() => undefined)
    throw error
  }
}
