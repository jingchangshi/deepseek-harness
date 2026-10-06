/**
 * Cordis-free storage mechanics for the local spill backend: private
 * session-scoped directory selection, safe-name derivation, path-traversal
 * protection, and the exclusive owner-only write.
 *
 * @module @deepseek-ai/dsh-spill-local/store
 */

import { createHash, randomBytes } from 'node:crypto'
import { constants, mkdtempSync } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { SpillReadLine } from '@deepseek-ai/dsh-spill'

/** Prefix shared by default-root creation and startup discovery. */
export const DEFAULT_ROOT_PREFIX = 'dsh-spill-'

/** A backend-generated session directory name, kept aligned with {@link sessionDir}. */
export const SESSION_DIR_RE = /^session-[0-9a-f]{12}$/

/** A backend-generated leaf: twelve random lowercase hex characters, a dash, and a non-empty safe name. */
const SPILL_FILE_RE = /^[0-9a-f]{12}-.+$/

/**
 * Test a caught value for a Node system error code.
 *
 * @param error The caught value.
 * @param code The expected system error code.
 * @returns Whether the code matches.
 */
export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

let defaultRoot: string | undefined

/**
 * Return the lazily-created private per-process spill root.
 *
 * @returns The private root path.
 */
export function privateRoot(): string {
  defaultRoot ??= mkdtempSync(join(tmpdir(), DEFAULT_ROOT_PREFIX))
  return defaultRoot
}

// Spill keeps its empty-name policy local so storage backends stay decoupled.
/* jscpd:ignore-start */
/**
 * Encode an arbitrary string as one safe path segment, injectively over ALL JS
 * (UTF-16) strings. A session id / suggested name is untrusted input, so this
 * neutralizes `../`, absolute paths, NUL, and separators before any filesystem
 * use. Each code unit is kept literal (`[A-Za-z0-9._-]`, minus `~`) or escaped
 * as `~XXXX`; `~` is itself escaped, so the mapping is reversible and distinct
 * inputs never collide. The whole-segment tokens `.`/`..` are escaped so they
 * can never traverse. An empty string encodes to `~` (never an empty segment).
 *
 * @param raw Untrusted text.
 * @returns One injective filesystem-safe path segment.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) return '~'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
      ? ch
      : '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}
/* jscpd:ignore-end */

/**
 * Derive the stable session-scoped directory under a spill root.
 *
 * @param root The spill root.
 * @param sessionId The owning session id.
 * @returns The stable session-scoped directory.
 */
export function sessionDir(root: string, sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  return join(root, `session-${hash}`)
}

/** Inputs needed to save a local spill file. */
export interface SaveTextOptions {
  /** Spill root. */
  root: string
  /** Owning session id. */
  sessionId: string
  /** Caller-suggested filename. */
  suggestedName: string
  /** Full text to persist. */
  content: string
}

/** A written spill file. */
export interface SavedText {
  /** Absolute saved path. */
  path: string
  /** UTF-8 content length. */
  bytes: number
}

/** Inputs needed to read one local spill file. */
export interface ReadTextOptions {
  /** Spill root the locator must belong to. */
  root: string
  /** Absolute locator returned by {@link saveTextFile}. */
  locator: string
  /** First line when no byte cursor is supplied. */
  offset: number
  /** Maximum returned lines. */
  limit: number
  /** Maximum returned UTF-8 content bytes. */
  maxBytes: number
  /** Absolute UTF-8 byte cursor, overriding offset. */
  byteOffset?: number
  /** Cancellation signal forwarded to the read. */
  signal?: AbortSignal
}

/** A validated local spill file read. */
export interface ReadTextFile {
  /** Absolute path that was read. */
  path: string
  /** First returned line number. */
  offset: number
  /** Bounded text window. */
  lines: SpillReadLine[]
  /** Exact total line count. */
  totalLines: number
  /** Cursor for continuation, or size at EOF. */
  nextByteOffset: number
  /** UTF-8 content length. */
  bytes: number
}

/** Whether `candidate` is a strict descendant of `root`. */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Resolve and validate a spill root before it is trusted for storage or retrieval.
 * Configured symlink aliases remain supported because ownership and permissions
 * apply to the canonical directory rather than the alias entry.
 *
 * @param root Configured spill root.
 * @returns The canonical root path.
 */
async function validateSpillRoot(root: string): Promise<string> {
  const canonical = await realpath(root)
  const stats = await lstat(canonical)
  if (!stats.isDirectory()) throw new Error('spill root is not a directory')
  /* v8 ignore start -- Windows uses filesystem ACLs rather than POSIX uid and
     mode bits; POSIX tests cover both save-time and retrieval-time rejection. */
  if (process.platform !== 'win32' && process.geteuid !== undefined
    && (stats.uid !== process.geteuid() || (stats.mode & 0o022) !== 0)) {
    throw new Error('spill root must be private to the current user')
  }
  /* v8 ignore stop */
  return canonical
}

/**
 * Write text to a fresh 0600 file below its private session directory. The
 * canonical root is validated before opening the leaf, so a save never returns
 * a locator that retrieval would reject only because the configured root is
 * owned by another user or permits group/world writes.
 * @param options The save request.
 * @returns The saved path and UTF-8 byte length.
 */
export async function saveTextFile(options: SaveTextOptions): Promise<SavedText> {
  const dir = sessionDir(options.root, options.sessionId)
  const path = join(dir, `${randomBytes(6).toString('hex')}-${encodeSegment(options.suggestedName)}`)
  let handle
  for (;;) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await validateSpillRoot(options.root)
    const parent = await lstat(dir)
    if (!parent.isDirectory()) throw new Error('spill session path is not a directory')
    if (process.platform !== 'win32' && (parent.uid !== process.geteuid?.() || (parent.mode & 0o077) !== 0)) {
      throw new Error('spill session directory must be private to the current user')
    }
    try {
      handle = await open(path, 'wx', 0o600)
      break
    } catch (error: unknown) {
      /* v8 ignore start -- requires another process to remove the directory
         between mkdir and open, or an external permission/IO race. */
      if (isErrno(error, 'ENOENT')) continue
      throw error
      /* v8 ignore stop */
    }
  }
  try {
    await handle.writeFile(options.content)
  } finally {
    await handle.close()
  }
  return { path, bytes: Buffer.byteLength(options.content, 'utf8') }
}

/**
 * Read a locator only when it is an absolute backend-generated spill leaf under
 * `root`. Lexical containment, backend naming, non-symlink parent/leaf, and
 * realpath containment and private-storage permissions are enforced before opening, so a
 * model-supplied path can never escape to an arbitrary local file.
 *
 * @param options The root, locator, byte/line budgets, and cancellation signal.
 * @returns A UTF-8-safe bounded page with exact totals and a continuation cursor; scans without retaining the full file.
 */
export async function readOwnedSpillFile(options: ReadTextOptions): Promise<ReadTextFile> {
  options.signal?.throwIfAborted()
  const root = resolve(options.root)
  const candidate = resolve(options.locator)
  if (!isAbsolute(options.locator)) throw new Error('spill locator must be an absolute path')
  const rel = relative(root, candidate)
  if (!isInside(root, candidate)) throw new Error('spill locator is outside the configured spill root')
  const segments = rel.split(sep)
  const sessionSegment = String(segments[0])
  const fileSegment = String(segments[1])
  if (segments.length !== 2 || !SESSION_DIR_RE.test(sessionSegment) || !SPILL_FILE_RE.test(fileSegment)) {
    throw new Error('spill locator does not name an owned spill artifact')
  }

  const leaf = await lstat(candidate)
  if (!leaf.isFile()) throw new Error('spill locator does not name a regular spill file')
  const parent = await lstat(dirname(candidate))
  if (!parent.isDirectory()) throw new Error('spill locator session path is not a directory')

  const canonicalRoot = await validateSpillRoot(root)
  /* v8 ignore start -- Windows has no POSIX uid or mode semantics; the POSIX
     suite exercises the private-storage rejection while Windows relies on ACLs. */
  if (process.platform !== 'win32' && process.geteuid !== undefined) {
    const uid = process.geteuid()
    if (parent.uid !== uid || (parent.mode & 0o022) !== 0
      || leaf.uid !== uid || (leaf.mode & 0o077) !== 0) throw new Error('spill locator storage must be private to the current user')
  }
  /* v8 ignore stop */
  const canonicalLeaf = await realpath(candidate)
  /* v8 ignore start -- these two realpath mismatches require replacing a
     already-lstat'd path during retrieval; deterministic symlink and hardlink
     fixtures cover the non-racy containment and identity failures. */
  if (!isInside(canonicalRoot, canonicalLeaf)) throw new Error('spill locator resolves outside the configured spill root')
  if (canonicalLeaf !== join(canonicalRoot, sessionSegment, fileSegment)) throw new Error('spill locator resolves outside its owning session')
  /* v8 ignore stop */

  /* v8 ignore next -- Windows selects the ACL-backed open without O_NOFOLLOW;
     POSIX uses O_NOFOLLOW and its symlink rejection is covered directly. */
  const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW
  const handle = await open(candidate, flags)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== leaf.dev || stat.ino !== leaf.ino) throw new Error('spill file changed during retrieval')
    if (options.byteOffset !== undefined && options.byteOffset > stat.size) throw new Error('byteOffset is out of range')
    const parts: Buffer[] = []
    let retainedBytes = 0
    let position = 0
    let line = 1
    let firstLine = options.offset
    let startByte: number | undefined
    let stopped = false
    let lastByte: number | undefined
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      options.signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      let start = 0
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start)
        const end = newline < 0 ? chunk.length : newline + 1
        const eligible = options.byteOffset === undefined ? line >= options.offset : position + end > options.byteOffset
        if (!stopped && eligible) {
          const from = Math.max(start, (options.byteOffset ?? 0) - position)
          if (startByte === undefined) {
            if ((chunk.readUInt8(from) & 0xc0) === 0x80) throw new Error('byteOffset must be a UTF-8 character boundary')
            startByte = position + from
            firstLine = line
          }
          const available = Math.min(end - from, options.maxBytes - retainedBytes)
          /* v8 ignore next -- eligibility proves from < end and `stopped` keeps
             the byte budget positive, so this guard's empty-slice path cannot
             execute without an earlier invariant failure. */
          if (available > 0) {
            parts.push(Buffer.from(chunk.subarray(from, from + available)))
            retainedBytes += available
          }
          stopped = retainedBytes === options.maxBytes || (newline >= 0 && line - firstLine + 1 >= options.limit)
        }
        if (newline >= 0) line += 1
        start = end
      }
      position += bytesRead
      lastByte = chunk.at(-1)
    }
    const totalLines = position === 0 ? 0 : line - (lastByte === 10 ? 1 : 0)
    if (options.byteOffset === undefined && options.offset > totalLines && !(totalLines === 0 && options.offset === 1)) {
      throw new Error(`offset ${options.offset} is out of range (${totalLines} lines)`)
    }
    const captured = Buffer.concat(parts)
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    let end = captured.length
    let content = ''
    while (end > 0) {
      try {
        content = decoder.decode(captured.subarray(0, end))
        break
      } catch (error: unknown) {
        /* v8 ignore next -- fatal UTF-8 decoding throws TypeError; no other
           decoder exception is reachable for a Buffer input. */
        if (!(error instanceof TypeError)) throw error
        end -= 1
      }
    }
    if (end === 0 && captured.length > 0) throw new Error('invalid UTF-8 data or maxBytes must be at least 4 to return one UTF-8 character')
    const rawLines = content === '' ? [] : content.split('\n')
    if (content.endsWith('\n')) rawLines.pop()
    const endsAtLineBoundary = content.endsWith('\n') || (startByte ?? position) + end === position
    const lines = rawLines.map((text, index) => ({
      number: firstLine + index,
      text: text.endsWith('\r') && (index < rawLines.length - 1 || endsAtLineBoundary) ? text.slice(0, -1) : text,
    }))
    return { path: candidate, offset: firstLine, lines, totalLines, bytes: position, nextByteOffset: (startByte ?? position) + end }
  } finally {
    await handle.close()
  }
}
