/** Optional provider-owned reads confined to an opened directory and its descendants. */
import type { FileSystem } from './index.ts'
import type { FsTarget } from './types.ts'

/** Whether descendant symbolic aliases may resolve within the pinned root. */
export type FsReadRootAliasPolicy = 'follow-contained' | 'deny'

/** Immutable native-open policy for one root acquisition. */
export interface FsReadRootOpenOptions {
  /** Defaults to following contained aliases; deny traverses original components without following. */
  aliasPolicy?: FsReadRootAliasPolicy
}

/** Metadata without a provider path or native handle. */
export interface FsReadRootInfo {
  /** Object kind observed through the opened object. */
  type: 'file' | 'directory' | 'other'
  /** Byte size when available. */
  size?: number
}

/** One direct child of an opened directory. */
export interface FsReadRootEntry extends FsReadRootInfo {
  /** Single logical path component, never an absolute path. */
  name: string
}

/**
 * Reads use provider-held directory handles, not pathname checks followed by pathname reads.
 * Segments reject empty names, dot segments, separators, NUL and platform namespace escapes.
 * An empty segment array selects the root. Escaping aliases and namespace races fail closed.
 * In follow-contained mode aliases resolve to canonical components before secure opening;
 * deny mode opens original components without following symbolic aliases. Cancellation joins
 * outstanding native I/O; it does not promise to interrupt a syscall already in progress.
 */
export interface FsReadRoot {
  /** Policy actually enforced by every descendant open in this scope. */
  readonly aliasPolicy: FsReadRootAliasPolicy
  /**
   * Inspect a contained object without exposing its native identity.
   * @param segments - root-relative logical components.
   * @param signal - caller cancellation.
   * @returns metadata, or undefined only when the object is absent.
   */
  stat(segments: readonly string[], signal?: AbortSignal): Promise<FsReadRootInfo | undefined>
  /**
   * Read a regular UTF-8 text file through its verified open handle.
   * @param segments - root-relative logical components.
   * @param maxBytes - nonnegative safe-integer byte ceiling, enforced during reading.
   * @param signal - caller cancellation.
   * @returns text; binary, oversized and non-regular objects reject with FsError.
   */
  readText(segments: readonly string[], maxBytes: number, signal?: AbortSignal): Promise<string>
  /**
   * Enumerate the opened directory without reopening its pathname.
   * @param segments - root-relative logical components.
   * @param signal - caller cancellation.
   * @returns direct children without native paths or handles.
   */
  listDir(segments: readonly string[], signal?: AbortSignal): Promise<FsReadRootEntry[]>
  /**
   * Reject new operations, cancel and join pending operations, then release the root.
   * @returns when scope-owned resources are closed; repeated calls share completion.
   */
  close(): Promise<void>
}

/** Optional capability; ordinary filesystem reads do not imply root isolation. */
export interface FsRootReadable {
  /**
   * Pin a directory in this provider's execution namespace.
   * @param root - directory resolved by this filesystem provider.
   * @param signal - opening cancellation; cancellation before publication releases resources.
   * @param options - immutable descendant alias policy; callers verify the returned acknowledgement.
   * @returns a caller-owned scope, or rejection when secure root reads are unavailable.
   */
  openReadRoot(root: FsTarget, signal?: AbortSignal, options?: FsReadRootOpenOptions): Promise<FsReadRoot>
}

/**
 * Detect the explicit capability without substituting ordinary pathname reads.
 * @param fs - mounted execution filesystem.
 * @returns whether the provider offers root-scoped reads.
 */
export function supportsRootRead(fs: FileSystem): fs is FileSystem & FsRootReadable {
  return 'openReadRoot' in fs && typeof fs.openReadRoot === 'function'
}
