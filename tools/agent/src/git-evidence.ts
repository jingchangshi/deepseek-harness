/** Immutable, bounded Git evidence for review-only workflows. */

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { assertNever } from '@deepseek-ai/dsh-util-values'

const execute = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_PAGE_SIZE = 16 * 1024
const SHA1_EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const FULL_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u

/** Identity of one repository-bound immutable Git snapshot. */
export type GitSnapshotId = Branded<'GitSnapshotId'>

/** Identity of one observed Git evidence query. */
export type GitEvidenceId = Branded<'GitEvidenceId'>

/** User-selected immutable source for one review snapshot. */
export type GitReviewTarget =
  | { kind: 'commit'; target: string; base?: string }
  | { kind: 'branch'; target: string; base?: string }
  | { kind: 'range'; target: string }
  | { kind: 'pr'; target: string; base?: string }

/** A resolved source identity pinned independently of later ref or worktree changes. */
export interface GitSnapshot {
  readonly schemaVersion: 1
  readonly id: GitSnapshotId
  readonly repositoryRoot: string
  readonly targetCommit: string
  readonly baseCommit: string
  readonly objectFormat: 'sha1' | 'sha256'
}

/** Evidence receipt for one successful query against the pinned snapshot. */
export interface GitEvidenceReceipt {
  readonly id: GitEvidenceId
  readonly snapshotId: GitSnapshotId
  readonly operation: 'show' | 'diff' | 'changed-files' | 'history'
  readonly path?: string
  readonly commit?: string
  readonly startLine?: number
  readonly endLine?: number
  readonly totalLines?: number
  readonly offset?: number
  readonly endOffset?: number
  readonly totalLength?: number
  readonly contentHash: string
  readonly complete: boolean
  readonly binary: boolean
}

/** Explicit statement that a returned page contains all requested content or names its continuation. */
export interface GitCompleteness {
  readonly complete: boolean
  readonly nextOffset?: number
  readonly nextLine?: number
}

/** Text, binary, and completeness metadata for one pinned Git query. */
export interface GitContentPage {
  readonly snapshotId: GitSnapshotId
  readonly evidenceId: GitEvidenceId
  readonly text: string
  readonly contentHash: string
  readonly binary: boolean
  readonly completeness: GitCompleteness
}

/** Git evidence query limits. */
export interface GitEvidenceOptions {
  commandTimeoutMs?: number
  maxOutputBytes?: number
  defaultPageSize?: number
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > 2_147_483_647) throw new Error(`${name} must be a positive safe integer`)
  return result
}

function safeRelativePath(path: string): string {
  if (path.length === 0 || path.includes('\0') || path.includes('\\') || isAbsolute(path) || /^[a-z]:/iu.test(path)
    || path.split('/').some(component => component === '' || component === '.' || component === '..')
    || path.startsWith('-') || path.startsWith(':')) throw new Error('Git evidence path must be a safe repository-relative path')
  return path
}

function safeBranchName(name: string): string {
  const branch = name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : name
  if (branch.length === 0 || branch.startsWith('-') || branch.includes('\0') || branch.includes('..') || branch.includes('@{')
    || branch.split('/').some(component => component === '' || component.startsWith('.') || component.endsWith('.lock'))
    || !/^[A-Za-z0-9._/-]+$/u.test(branch)) throw new Error('Git branch must be a simple local branch name')
  return branch
}

function safeObjectId(value: string): string {
  if (!FULL_OBJECT_ID.test(value)) throw new Error('Git commit must be a full hexadecimal object ID')
  return value
}

function commandEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('GIT_') || name === 'HOME' || name === 'XDG_CONFIG_HOME' || value === undefined) continue
    env[name] = value
  }
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_NO_REPLACE_OBJECTS = '1'
  env.GIT_NO_LAZY_FETCH = '1'
  env.GIT_ALLOW_PROTOCOL = ''
  env.GIT_PAGER = 'cat'
  env.PAGER = 'cat'
  env.HOME = root
  return env
}

class GitCommandError extends Error {
  constructor(args: readonly string[], detail: string) {
    super(`read-only Git command failed (${args[0] ?? 'git'}): ${detail}`)
    this.name = 'GitCommandError'
  }
}

async function git(root: string, args: string[], options: { timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'commandTimeoutMs')
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_OUTPUT_BYTES, 'maxOutputBytes')
  options.signal?.throwIfAborted()
  const safeArgs = ['--no-pager', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'protocol.allow=never', '-c', 'diff.external=', '-c', 'diff.trustExitCode=false', ...args]
  try {
    const result = await execute('git', safeArgs, {
      cwd: root,
      env: commandEnvironment(root),
      encoding: 'buffer',
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      windowsHide: true,
      signal: options.signal,
    })
    return Buffer.from(result.stdout)
  } catch (error) {
    options.signal?.throwIfAborted()
    const detail = error instanceof Error ? error.message : String(error)
    throw new GitCommandError(args, detail)
  }
}

async function gitText(root: string, args: string[], options?: { timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal }): Promise<string> {
  const bytes = await git(root, args, options)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

async function resolveCommit(root: string, objectId: string, options: Required<Pick<GitEvidenceOptions, 'commandTimeoutMs' | 'maxOutputBytes'>> & { signal?: AbortSignal }): Promise<string> {
  if (objectId === 'HEAD') {
    const head = (await gitText(root, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], gitOptions(options))).trim().toLowerCase()
    if (!FULL_OBJECT_ID.test(head)) throw new Error('HEAD did not resolve to a full commit ID')
    return head
  }
  const expected = safeObjectId(objectId)
  const actual = (await gitText(root, ['rev-parse', '--verify', '--end-of-options', `${expected}^{commit}`], gitOptions(options))).trim().toLowerCase()
  if (!FULL_OBJECT_ID.test(actual) || actual !== expected) throw new Error('Git target did not resolve to the requested full commit ID')
  return actual
}

async function resolveBranch(root: string, branch: string, options: Required<Pick<GitEvidenceOptions, 'commandTimeoutMs' | 'maxOutputBytes'>> & { signal?: AbortSignal }): Promise<string> {
  const name = safeBranchName(branch)
  const actual = (await gitText(root, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${name}^{commit}`], gitOptions(options))).trim().toLowerCase()
  if (!FULL_OBJECT_ID.test(actual)) throw new Error('local branch did not resolve to a commit')
  return actual
}

async function parentCommit(root: string, commit: string, options: Required<Pick<GitEvidenceOptions, 'commandTimeoutMs' | 'maxOutputBytes'>> & { signal?: AbortSignal }): Promise<string | undefined> {
  const output = await gitText(root, ['rev-list', '--parents', '-n', '1', commit], gitOptions(options))
  const parent = output.trim().split(/\s+/u)[1]
  return parent === undefined ? undefined : safeObjectId(parent)
}

function gitOptions(options: Required<Pick<GitEvidenceOptions, 'commandTimeoutMs' | 'maxOutputBytes'>> & { signal?: AbortSignal }): { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal } {
  return { timeoutMs: options.commandTimeoutMs, maxOutputBytes: options.maxOutputBytes, ...options.signal === undefined ? {} : { signal: options.signal } }
}

function objectFormatOf(commit: string): 'sha1' | 'sha256' {
  if (commit.length === 40) return 'sha1'
  if (commit.length === 64) return 'sha256'
  throw new Error('unsupported Git object format')
}

function emptyTree(objectFormat: 'sha1' | 'sha256'): string {
  return objectFormat === 'sha1' ? SHA1_EMPTY_TREE : createHash('sha256').update('tree 0\0').digest('hex')
}

function snapshotId(repositoryRoot: string, baseCommit: string, targetCommit: string, objectFormat: 'sha1' | 'sha256'): GitSnapshotId {
  return brandString<GitSnapshotId>(createHash('sha256').update(JSON.stringify([repositoryRoot, baseCommit, targetCommit, objectFormat])).digest('hex'))
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value)
}

/**
 * Resolve a repository-bound local target without fetching or writing Git objects.
 * @param root - repository top level, resolved to its canonical path.
 * @param target - full commit, literal HEAD, local branch, full-SHA range or local PR selector.
 * @param signal - cancellation for every Git query.
 * @param limits - validated subprocess timeout, output cap and default page size.
 * @returns the fixed base and target identities; rejects invalid selectors or unavailable local objects.
 */
export async function createGitSnapshot(root: string, target: GitReviewTarget, signal?: AbortSignal, limits: GitEvidenceOptions = {}): Promise<GitSnapshot> {
  const repositoryRoot = await realpath(root)
  const commandOptions = {
    commandTimeoutMs: positiveInteger(limits.commandTimeoutMs, DEFAULT_TIMEOUT_MS, 'commandTimeoutMs'),
    maxOutputBytes: positiveInteger(limits.maxOutputBytes, DEFAULT_OUTPUT_BYTES, 'maxOutputBytes'),
    ...(signal === undefined ? {} : { signal }),
  }
  const top = (await gitText(repositoryRoot, ['rev-parse', '--show-toplevel'], gitOptions(commandOptions))).trim()
  if (await realpath(top) !== repositoryRoot) throw new Error('Git review root must be the repository top level')
  const objectFormatText = (await gitText(repositoryRoot, ['rev-parse', '--show-object-format'], gitOptions(commandOptions))).trim()
  if (objectFormatText !== 'sha1' && objectFormatText !== 'sha256') throw new Error('unsupported Git object format')
  let targetCommit: string
  let baseCommit: string | undefined
  switch (target.kind) {
    case 'commit':
      targetCommit = await resolveCommit(repositoryRoot, target.target, commandOptions)
      baseCommit = target.base === undefined ? await parentCommit(repositoryRoot, targetCommit, commandOptions) : await resolveCommit(repositoryRoot, target.base, commandOptions)
      break
    case 'branch':
      targetCommit = await resolveBranch(repositoryRoot, target.target, commandOptions)
      baseCommit = target.base === undefined ? await parentCommit(repositoryRoot, targetCommit, commandOptions) : await resolveCommit(repositoryRoot, target.base, commandOptions)
      break
    case 'range': {
      const match = /^([a-f0-9]{40}|[a-f0-9]{64})\.\.([a-f0-9]{40}|[a-f0-9]{64})$/u.exec(target.target)
      if (match?.[1] === undefined || match[2] === undefined) throw new Error('Git range must contain two full commit IDs separated by ..')
      baseCommit = await resolveCommit(repositoryRoot, match[1], commandOptions)
      targetCommit = await resolveCommit(repositoryRoot, match[2], commandOptions)
      break
    }
    case 'pr': {
      if (!/^[1-9][0-9]{0,8}$/u.test(target.target)) throw new Error('local pull request number is invalid')
      if (target.base === undefined) throw new Error('local pull request review requires an explicit base commit')
      const ref = (await gitText(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `refs/pull/${target.target}/head^{commit}`], gitOptions(commandOptions))).trim().toLowerCase()
      if (!FULL_OBJECT_ID.test(ref)) throw new Error('local pull request ref did not resolve to a commit')
      targetCommit = ref
      baseCommit = await resolveCommit(repositoryRoot, target.base, commandOptions)
      break
    }
    default: {
      const exhaustive: never = target
      throw new Error(`unsupported Git review target ${String(exhaustive)}`)
    }
  }
  const objectFormat = objectFormatOf(targetCommit)
  if (objectFormat !== objectFormatText || baseCommit !== undefined && objectFormatOf(baseCommit) !== objectFormat) throw new Error('Git target object format changed')
  baseCommit ??= emptyTree(objectFormat)
  const id = snapshotId(repositoryRoot, baseCommit, targetCommit, objectFormat)
  return frozen({ schemaVersion: 1, id, repositoryRoot, targetCommit, baseCommit, objectFormat })
}

interface PageInput { offset?: number; limit?: number }
interface ShowInput { path: string; startLine?: number; lineCount?: number }

/** Query one immutable Git snapshot and retain receipts for all returned evidence. */
export class GitEvidenceRepository {
  readonly snapshot: GitSnapshot
  private readonly receipts: GitEvidenceReceipt[] = []
  private readonly commandTimeoutMs: number
  private readonly maxOutputBytes: number
  private readonly defaultPageSize: number

  /**
   * Create a bounded evidence reader for a validated snapshot.
   * @param snapshot - canonical immutable commit identity.
   * @param options - command deadline, maximum captured bytes, and default page size.
   */
  constructor(snapshot: GitSnapshot, options: GitEvidenceOptions = {}) {
    if (snapshot.schemaVersion !== 1 || !isAbsolute(snapshot.repositoryRoot)
      || !FULL_OBJECT_ID.test(snapshot.targetCommit) || !FULL_OBJECT_ID.test(snapshot.baseCommit)
      || snapshot.objectFormat !== objectFormatOf(snapshot.targetCommit)
      || snapshot.objectFormat !== objectFormatOf(snapshot.baseCommit)
      || snapshot.id !== snapshotId(snapshot.repositoryRoot, snapshot.baseCommit, snapshot.targetCommit, snapshot.objectFormat)) {
      throw new Error('Git snapshot identity is invalid')
    }
    this.snapshot = frozen({ ...snapshot })
    this.commandTimeoutMs = positiveInteger(options.commandTimeoutMs, DEFAULT_TIMEOUT_MS, 'commandTimeoutMs')
    this.maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_OUTPUT_BYTES, 'maxOutputBytes')
    this.defaultPageSize = positiveInteger(options.defaultPageSize, DEFAULT_PAGE_SIZE, 'defaultPageSize')
  }

  /**
   * Return receipts only for completed queries against this snapshot.
   * @returns a frozen copy of the immutable receipt list.
   */
  observedEvidence(): readonly GitEvidenceReceipt[] {
    return Object.freeze(this.receipts.slice())
  }

  /**
   * Revalidate persisted query receipts against the pinned Git objects before reuse.
   * @param receipts - trusted checkpoint receipts with their original inspection identities.
   * @param signal - cancellation while validating the immutable source pages.
   */
  async restoreEvidence(receipts: readonly GitEvidenceReceipt[], signal?: AbortSignal): Promise<void> {
    const verifier = new GitEvidenceRepository(this.snapshot, { commandTimeoutMs: this.commandTimeoutMs, maxOutputBytes: this.maxOutputBytes, defaultPageSize: this.defaultPageSize })
    for (const receipt of receipts) {
      if (receipt.snapshotId !== this.snapshot.id) throw new Error('checkpoint Git receipt belongs to a different snapshot')
      switch (receipt.operation) {
        case 'show':
          if (receipt.path === undefined || receipt.startLine === undefined || receipt.endLine === undefined) throw new Error('checkpoint source receipt has no line range')
          await verifier.show({ path: receipt.path, startLine: receipt.startLine, lineCount: Math.max(1, receipt.endLine - receipt.startLine + 1) }, signal)
          break
        case 'diff':
          if (receipt.path === undefined || receipt.offset === undefined || receipt.endOffset === undefined) throw new Error('checkpoint diff receipt has no page range')
          await verifier.diff({ path: receipt.path, offset: receipt.offset, limit: Math.max(1, receipt.endOffset - receipt.offset) }, signal)
          break
        case 'changed-files':
          if (receipt.offset === undefined || receipt.endOffset === undefined) throw new Error('checkpoint changed-file receipt has no page range')
          await verifier.changedFiles({ offset: receipt.offset, limit: Math.max(1, receipt.endOffset - receipt.offset) }, signal)
          break
        case 'history':
          if (receipt.offset === undefined || receipt.endOffset === undefined) throw new Error('checkpoint history receipt has no page range')
          await verifier.history({ offset: receipt.offset, limit: Math.max(1, receipt.endOffset - receipt.offset) }, signal)
          break
        default: assertNever(receipt.operation)
      }
      const actual = verifier.observedEvidence().at(-1)!
      const keys = new Set([...Object.keys(actual), ...Object.keys(receipt)])
      for (const key of keys) {
        if (key !== 'id' && Reflect.get(actual, key) !== Reflect.get(receipt, key)) throw new Error(`checkpoint Git receipt ${receipt.id} fails pinned-content verification`)
      }
      if (!this.receipts.some(existing => existing.id === receipt.id)) this.receipts.push(frozen({ ...receipt }))
    }
  }

  /**
   * Read target source lines without text conversion.
   * @param input - validated path and page selection.
   * @param signal - cancellation before and during the subprocess.
   * @returns source text or explicit binary metadata, its receipt and continuation; oversized subprocess output rejects without truncation.
   */
  async show(input: ShowInput, signal?: AbortSignal): Promise<GitContentPage & { readonly path: string; readonly commit: string; readonly startLine: number }> {
    const path = safeRelativePath(input.path)
    const startLine = positiveInteger(input.startLine, 1, 'startLine')
    const lineCount = positiveInteger(input.lineCount, this.defaultPageSize, 'lineCount')
    const bytes = await git(this.snapshot.repositoryRoot, ['cat-file', 'blob', `${this.snapshot.targetCommit}:${path}`], this.options(signal))
    const binary = isBinary(bytes)
    const content = binary ? '' : decode(bytes)
    const lines = splitLines(content)
    const start = startLine - 1
    const selected = lines.slice(start, start + lineCount)
    if (lines.length > 0 && startLine > lines.length) throw new Error('Git source line start is beyond the pinned file')
    const text = selected.join('')
    const nextLine = start + selected.length + 1
    const completeness = frozen(nextLine <= lines.length ? { complete: false, nextLine } : { complete: true })
    const endLine = selected.length === 0 ? startLine - 1 : nextLine - 1
    const receipt = this.record('show', binary ? bytes : text, {
      path, commit: this.snapshot.targetCommit, startLine, endLine, totalLines: lines.length,
      complete: !binary && startLine === 1 && endLine === lines.length, binary,
    })
    return frozen({ snapshotId: this.snapshot.id, evidenceId: receipt.id, path, commit: this.snapshot.targetCommit, startLine, text, contentHash: receipt.contentHash, binary, completeness })
  }

  /**
   * Read one literal path diff without external diff programs.
   * @param input - validated path and page selection.
   * @param signal - cancellation before and during the subprocess.
   * @returns diff text or explicit binary metadata, its receipt and continuation; oversized subprocess output rejects without truncation.
   */
  async diff(input: PageInput & { path: string }, signal?: AbortSignal): Promise<GitContentPage & { readonly path: string; readonly baseCommit: string; readonly targetCommit: string }> {
    const path = safeRelativePath(input.path)
    const offset = nonNegativeInteger(input.offset, 0, 'offset')
    const limit = positiveInteger(input.limit, this.defaultPageSize, 'limit')
    const bytes = await git(this.snapshot.repositoryRoot, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--no-prefix', '--unified=3', this.snapshot.baseCommit, this.snapshot.targetCommit, '--', path], this.options(signal))
    const binary = isBinary(bytes) || bytes.toString('utf8').includes('Binary files ')
    const content = binary && isBinary(bytes) ? '' : bytes.toString('utf8')
    const text = content.slice(offset, offset + limit)
    const nextOffset = offset + text.length
    const completeness = frozen(nextOffset < content.length ? { complete: false, nextOffset } : { complete: true })
    const receipt = this.record('diff', text, {
      path, commit: this.snapshot.targetCommit, offset, endOffset: nextOffset, totalLength: content.length,
      complete: !binary && offset === 0 && nextOffset === content.length, binary,
    })
    return frozen({ snapshotId: this.snapshot.id, evidenceId: receipt.id, path, baseCommit: this.snapshot.baseCommit, targetCommit: this.snapshot.targetCommit, text, contentHash: receipt.contentHash, binary, completeness })
  }

  /**
   * Read changed paths for the fixed commit pair.
   * @param input - page offset and maximum entries.
   * @param signal - cancellation before and during the subprocess.
   * @returns path statuses, a trusted receipt and explicit continuation.
   */
  async changedFiles(input: PageInput, signal?: AbortSignal): Promise<{ readonly snapshotId: GitSnapshotId; readonly evidenceId: GitEvidenceId; readonly files: readonly { readonly path: string; readonly status: string }[]; readonly completeness: GitCompleteness }> {
    const offset = nonNegativeInteger(input.offset, 0, 'offset')
    const limit = positiveInteger(input.limit, this.defaultPageSize, 'limit')
    const bytes = await git(this.snapshot.repositoryRoot, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--no-renames', this.snapshot.baseCommit, this.snapshot.targetCommit, '--'], this.options(signal))
    const fields = bytes.toString('utf8').split('\0').filter(Boolean)
    const files: Array<{ path: string; status: string }> = []
    for (let index = 0; index < fields.length; index += 2) {
      const status = fields[index]
      const path = fields[index + 1]
      if (status === undefined || path === undefined) throw new Error('Git returned incomplete changed-file status records')
      files.push(frozen({ path, status }))
    }
    const page = files.slice(offset, offset + limit)
    const nextOffset = offset + page.length
    const completeness = frozen(nextOffset < files.length ? { complete: false, nextOffset } : { complete: true })
    const serialized = JSON.stringify(page)
    const receipt = this.record('changed-files', serialized, { offset, endOffset: nextOffset, totalLength: files.length, complete: offset === 0 && nextOffset === files.length, binary: false })
    return frozen({ snapshotId: this.snapshot.id, evidenceId: receipt.id, files: Object.freeze(page), completeness })
  }

  /**
   * Read pinned target ancestry after the base commit.
   * @param input - page offset and maximum entries.
   * @param signal - cancellation before and during the subprocess.
   * @returns commit identifiers, subjects, a trusted receipt and explicit continuation.
   */
  async history(input: PageInput, signal?: AbortSignal): Promise<{ readonly snapshotId: GitSnapshotId; readonly evidenceId: GitEvidenceId; readonly commits: readonly { readonly commit: string; readonly subject: string }[]; readonly completeness: GitCompleteness }> {
    const offset = nonNegativeInteger(input.offset, 0, 'offset')
    const limit = positiveInteger(input.limit, this.defaultPageSize, 'limit')
    const bytes = await git(this.snapshot.repositoryRoot, ['log', '--format=%H%x00%s', '-z', this.snapshot.targetCommit, `^${this.snapshot.baseCommit}`], this.options(signal))
    const fields = bytes.toString('utf8').split('\0').filter(Boolean)
    const commits: Array<{ commit: string; subject: string }> = []
    for (let index = 0; index < fields.length; index += 2) {
      const commit = fields[index]
      const subject = fields[index + 1]
      if (commit === undefined || subject === undefined || !FULL_OBJECT_ID.test(commit)) throw new Error('Git returned incomplete history records')
      commits.push(frozen({ commit, subject }))
    }
    const page = commits.slice(offset, offset + limit)
    const nextOffset = offset + page.length
    const completeness = frozen(nextOffset < commits.length ? { complete: false, nextOffset } : { complete: true })
    const receipt = this.record('history', JSON.stringify(page), { offset, endOffset: nextOffset, totalLength: commits.length, complete: offset === 0 && nextOffset === commits.length, binary: false })
    return frozen({ snapshotId: this.snapshot.id, evidenceId: receipt.id, commits: Object.freeze(page), completeness })
  }

  private options(signal?: AbortSignal): { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal } {
    return { timeoutMs: this.commandTimeoutMs, maxOutputBytes: this.maxOutputBytes, ...signal === undefined ? {} : { signal } }
  }

  private record(operation: GitEvidenceReceipt['operation'], content: string | Buffer, fields: Omit<GitEvidenceReceipt, 'id' | 'snapshotId' | 'operation' | 'contentHash'>): GitEvidenceReceipt {
    const receipt = frozen({ id: brandString<GitEvidenceId>(randomUUID()), snapshotId: this.snapshot.id, operation, contentHash: createHash('sha256').update(content).digest('hex'), ...fields })
    this.receipts.push(receipt)
    return receipt
  }
}

function isBinary(value: Buffer): boolean {
  if (value.includes(0)) return true
  try { decode(value); return false } catch { return true }
}

function decode(value: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value)
}

function splitLines(value: string): string[] {
  if (value.length === 0) return []
  const lines = value.match(/[^\n]*\n|[^\n]+$/gu)
  return lines ?? []
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${name} must be a nonnegative safe integer`)
  return result
}
