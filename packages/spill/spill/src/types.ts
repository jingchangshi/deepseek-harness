/**
 * Vocabulary for the spill storage Service Definition. Types only — the abstract service
 * lives in `./index.ts`, implementations in sibling packages
 * (`@deepseek-ai/dsh-spill-local` first).
 *
 * @module @deepseek-ai/dsh-spill/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Opaque model-facing handle for one spilled artifact. A local backend may use a
 * filesystem path; a remote or database backend may use a URI or key. Consumers
 * render it with {@link SpillRef.retrievalHint}, but do not parse it.
 */
export type SpillLocator = Branded<'SpillLocator'>

/**
 * Brand a string as a {@link SpillLocator}.
 *
 * @param locator The backend-produced locator string to brand.
 * @returns The branded spill locator.
 */
export function SpillLocator(locator: string): SpillLocator {
  return locator as SpillLocator
}

/**
 * Save-time storage namespace for a spilled artifact. The session id lets a
 * backend group storage under the producing session, but the returned
 * {@link SpillLocator} is the model-facing handle. Forked sessions inherit
 * locators already present in the seeded log; those artifacts are not copied or
 * re-owned, and spills produced after the fork use the child session id.
 */
export interface SpillOwner {
  sessionId: SessionId
}

/**
 * Producer of a spilled artifact. Tool results carry their model-issued call id;
 * session references identify the captured source session instead. Descriptive
 * source description only, never access control.
 */
export type SpillSource = {
  kind: 'tool'
  /** The tool whose result was spilled (e.g. `web_fetch`). */
  toolName: string
  /** The model-issued call id the result belongs to. */
  callId: ToolCallId
  /** A short human label for the artifact (e.g. `result`). */
  label: string
} | {
  kind: 'session-reference'
  /** Session whose projected conversation was captured. */
  sessionId: SessionId
  /** Host-provided label for the referenced session. */
  label: string
}

/** One request to persist text to a spill artifact. */
export interface SaveTextSpill {
  owner: SpillOwner
  source: SpillSource
  /**
   * A caller-suggested base name (e.g. `web_fetch.txt`). The backend sanitizes
   * it to a single safe path segment before use — it is a hint, never a path.
   */
  suggestedName: string
  /** The full text to persist (UTF-8). */
  content: string
}

/** A saved spill artifact: its locator, byte length, and backend-specific retrieval guidance. */
export interface SpillRef {
  locator: SpillLocator
  bytes: number
  retrievalHint: string
}

/** One request to read text back from a spilled artifact. */
export interface ReadTextSpill {
  /** The saved artifact's opaque locator, exactly as returned by {@link SpillStore.saveText}. */
  locator: SpillLocator
  /** 1-based first line to return; defaults to `1`. */
  offset?: number
  /** Maximum number of lines to return; the backend chooses the cap when omitted. */
  limit?: number
  /** Absolute UTF-8 byte cursor returned by a previous read; overrides the line offset. */
  byteOffset?: number
  /** Maximum UTF-8 content bytes for this page; the backend may apply a lower cap. */
  maxBytes?: number
  /** Cancellation signal for the backend's read; the caller owns forwarding and quiescence. */
  signal?: AbortSignal
}

/** One numbered line returned from a spilled artifact. */
export interface SpillReadLine {
  /** 1-based line number within the artifact. */
  number: number
  /** Line text without its trailing newline. */
  text: string
}

/** Structured text read from one spilled artifact. */
export interface SpillRead {
  /** The opaque locator that was read. */
  locator: SpillLocator
  /** Backend-specific path/address resolved from the locator, for diagnostics and non-model consumers. */
  path: string
  /** 1-based first returned line, resolved from the line or byte cursor. */
  offset: number
  /** Returned window of lines, already numbered. */
  lines: SpillReadLine[]
  /** Exact total line count in the artifact. */
  totalLines: number
  /** Exact UTF-8 byte length of the artifact. */
  bytes: number
  /** Whether the returned window ended before the artifact's last line. */
  truncated: boolean
  /** Absolute UTF-8 byte cursor for the next page, or the artifact size at EOF. */
  nextByteOffset: number
}
