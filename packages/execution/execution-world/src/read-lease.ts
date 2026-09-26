/** File-only access to a captured execution workspace, without subprocess capabilities. */
import type { Context } from '@deepseek-ai/cordis'
import { bindReadOnlyExecutionWorld } from './read-only.ts'
import type { ReadOnlyExecutionFs } from './read-only-types.ts'
import type { ExecutionWorkspaceId } from './types.ts'

/** Ephemeral root-scoped reads owned by the caller's plugin generation. */
export interface ExecutionReadLease {
  /** Durable workspace identity, not an access token. */
  readonly workspaceId: ExecutionWorkspaceId
  /** Provider-held metadata, bounded text and directory reads only. */
  readonly fs: ReadOnlyExecutionFs
  /**
   * Cancel reads and join root cleanup; repeated calls share the same result.
   * @returns when owned work is quiescent; rejects if remote cleanup is unconfirmed.
   */
  dispose(): Promise<void>
}

/**
 * Capture file-only access from explicitly injected execution providers.
 * Missing secure root readers reject without an ordinary-path or Host fallback.
 * Every descendant open rejects symbolic aliases, preserving logical-name authorization.
 * @param ctx - owner with executionWorldIdentity, fs, subprocess and sandbox injections.
 * @param root - directory interpreted by the captured execution filesystem.
 * @param signal - optional acquisition and lease-lifetime cancellation.
 * @returns a new file-only facade; cancellation joins any acquired root cleanup.
 */
export async function bindExecutionReadLease(ctx: Context, root: string, signal?: AbortSignal): Promise<ExecutionReadLease> {
  const binding = await bindReadOnlyExecutionWorld(ctx, root, signal, 'deny')
  let closing: Promise<void> | undefined
  return {
    workspaceId: binding.workspaceId,
    fs: binding.fs,
    dispose: () => closing ??= binding.dispose(),
  }
}
