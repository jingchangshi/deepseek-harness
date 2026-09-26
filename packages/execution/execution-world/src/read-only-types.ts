/** Root-relative read capabilities and confined process requests for one live provider generation. */
import type { FsReadRootInfo } from '@deepseek-ai/dsh-fs'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { ExecutionWorkspaceId } from './types.ts'

/** A directory child without a raw provider target or executable path. */
export interface ReadOnlyExecutionEntry {
  /** Root-relative logical path using forward slashes. */
  path: string
  /** Single logical path segment. */
  name: string
  /** Resolved entry kind. */
  type: 'file' | 'directory' | 'other'
  /** Byte size when available. */
  size?: number
}

/** Provider-held root reads; empty paths select the root. */
export interface ReadOnlyExecutionFs {
  /**
   * Read metadata for a contained target.
   * @param path - root-relative logical path without dot or backslash segments.
   * @param signal - optional caller cancellation.
   * @returns metadata, or undefined for an absent target.
   */
  stat(path: string, signal?: AbortSignal): Promise<FsReadRootInfo | undefined>
  /**
   * Read a contained regular UTF-8 file.
   * @param path - root-relative logical file path.
   * @param maxBytes - caller-owned byte ceiling, enforced by the provider.
   * @param signal - optional caller cancellation.
   * @returns decoded text under the provider's read limits.
   */
  readText(path: string, maxBytes: number, signal?: AbortSignal): Promise<string>
  /**
   * List contained children without exposing provider target keys.
   * @param path - root-relative logical directory path.
   * @param signal - optional caller cancellation.
   * @returns child names with logical paths; reading an escaping alias rejects.
   */
  listDir(path: string, signal?: AbortSignal): Promise<ReadOnlyExecutionEntry[]>
}

/** Explicit command limits; confinement governs file effects, not visibility or networking. */
export interface ReadOnlyExecutionStart {
  /** Executable and arguments, never a shell command string. */
  argv: readonly [string, ...string[]]
  /** Root-relative working directory; omission selects the bound root. */
  cwd?: string
  /** Explicit environment overlay on the provider's scrubbed base. */
  env?: Readonly<Record<string, string>>
  /** Ignore input or supply text with a caller-selected UTF-8 byte ceiling. */
  stdin: 'ignore' | { data: string; maxBytes: number }
  /** Independent raw stream or bounded in-memory tail, without spill files. */
  stdout: 'pipe' | { maxBytes: number }
  /** Independent raw stream or bounded in-memory tail, without spill files. */
  stderr: 'pipe' | { maxBytes: number }
  /** Positive termination grace in milliseconds, bounded by the subprocess provider. */
  graceMs: number
  /** Cancellation during setup and the published process lifetime. */
  signal?: AbortSignal
}

/** Original process handle plus unchanged confinement facts. */
export interface ReadOnlyExecutionProcess {
  /** Provider-owned streams, output readers, outcome, and process-range lifecycle. */
  handle: SubprocessHandle
  /** Full or partial enforcement, never upgraded by the binding. */
  enforcement: ConfinedArgv['enforcement']
  /** Provider-specific denial evidence. */
  denialSignatures: ConfinedArgv['denialSignatures']
  /** Provider-specific runner failure evidence. */
  runnerFailureRules: ConfinedArgv['runnerFailureRules']
}

/** Ephemeral capabilities over one root; workspace identity survives capability replacement. */
export interface ReadOnlyExecutionWorld {
  /** Durable root identity, not an access token. */
  workspaceId: ExecutionWorkspaceId
  /** Reads through provider-held root handles, without ordinary pathname fallback. */
  fs: ReadOnlyExecutionFs
  /** Confined subprocess operations with a root-contained working directory. */
  subprocess: {
    /**
     * Start one argv command after resolving its executable and read-only confinement.
     * @param spec - explicit input, output, environment and termination limits.
     * @returns the original managed handle and actual enforcement facts.
     */
    start(spec: ReadOnlyExecutionStart): Promise<ReadOnlyExecutionProcess>
  }
  /**
   * Abort work and wait for outstanding reads, root closure and managed process ranges.
   * @returns when binding-owned work is quiescent.
   */
  dispose(): Promise<void>
}
