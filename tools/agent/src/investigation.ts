/** Source-bound investigation checkpoints; model claims cannot manufacture inspection receipts. */

import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { RoleBounds } from './config.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { GitEvidenceId, GitSnapshotId, GitEvidenceReceipt } from './git-evidence.ts'

/** One explicit, bounded question assigned to a read-only Scout. */
export interface InvestigationUnit extends RoleBounds {
  id: string
  role: 'scout-primary' | 'scout-secondary'
  question: string
  allowedPaths: string[]
  evidenceFormat: 'inspection-receipts'
}

/** Trusted observation of a successful source-inspection tool result. */
export interface InspectionReceipt {
  executionId: string
  path: string
  contentHash: string
  toolName: string
  /** Pinned Git query identity when this inspection used a review tool. */
  evidenceId?: string
}

/** Source bytes and scope membership that authorize reuse of one unit. */
export interface InvestigationDependencies {
  repositorySnapshot: string
  scopeMembershipDigest: string
  dependencies: Array<{ path: string; hash: string }>
}

/** A durable partial or completed investigation, independent of other Scout units. */
export interface InvestigationCheckpoint extends InvestigationDependencies {
  schemaVersion: 1
  taskId: string
  workflow: 'development' | 'review-only'
  unitId: string
  taskRevision: number
  validatedForRevision: number
  scopeDigest: string
  allowedPaths: string[]
  evidence: InspectionReceipt[]
  output: Record<string, unknown> | null
  status: 'COMPLETE' | 'PARTIAL'
  startedAt: string
  updatedAt: string
  attemptIds: string[]
  /** Immutable Git pages retained by Review-only work units. */
  gitEvidence?: GitEvidenceReceipt[]
  /** Actual tool execution that produced each retained Git page. */
  gitExecutions?: Array<{ evidenceId: string; executionId: string }>
}

function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }

/**
 * Reject outside-root or metadata paths before assigning code scope.
 * @param path - repository-relative file or directory.
 * @returns the unchanged validated path.
 */
export function investigationPath(path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0') || posix.normalize(path) !== path
    || path.split('/').some(part => part === '..' || part === '.git' || part === '.agent')) {
    throw new Error(`invalid investigation path: ${path}`)
  }
  return path
}

/**
 * Fingerprint bounded source scope, including added/deleted members and symlink refusal.
 * @param root - canonical repository directory.
 * @param allowedPaths - explicitly assigned source files or directories.
 * @param maxFiles - configured maximum files in this work unit.
 * @returns source dependency hashes and immutable source/scope identities.
 */
export async function captureInvestigationDependencies(root: string, allowedPaths: readonly string[], maxFiles: number): Promise<InvestigationDependencies> {
  const paths = new Set<string>()
  const visit = async (path: string): Promise<void> => {
    investigationPath(path)
    const absolute = resolve(root, path)
    let info
    try { info = await lstat(absolute) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (info.isSymbolicLink()) throw new Error(`investigation scope cannot follow a symlink: ${path}`)
    const canonical = await realpath(absolute)
    const local = relative(root, canonical)
    if (isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) throw new Error(`investigation scope escapes repository: ${path}`)
    if (info.isDirectory()) {
      for (const entry of (await readdir(absolute)).sort()) {
        if (entry === '.git' || entry === '.agent') continue
        await visit(`${path}/${entry}`)
      }
    } else if (info.isFile()) {
      paths.add(path)
      if (paths.size > maxFiles) throw new Error(`investigation scope exceeds ${maxFiles} files; partition the assigned paths`)
    } else throw new Error(`investigation scope requires regular source files: ${path}`)
  }
  for (const path of allowedPaths) await visit(path)
  const dependencies = []
  for (const path of [...paths].sort()) dependencies.push({ path, hash: hash(await readFile(resolve(root, path))) })
  return { dependencies, scopeMembershipDigest: hash(JSON.stringify(dependencies.map(item => item.path))), repositorySnapshot: hash(JSON.stringify([root, dependencies])) }
}

/**
 * Bind a checkpoint to its complete question and declared scope.
 * @param request - current task request, including explicit scope additions.
 * @param unit - assigned investigation question and source roots.
 * @returns deterministic identity for reuse validation.
 */
export function investigationScopeDigest(request: string, unit: InvestigationUnit): string {
  return hash(JSON.stringify([request, unit.id, unit.question, unit.allowedPaths]))
}

function checkpointPath(root: string, taskId: string, workflow: InvestigationCheckpoint['workflow'], unitId: string): string {
  for (const id of [taskId, unitId]) if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error('invalid investigation checkpoint ID')
  return join(root, '.agent', workflow === 'development' ? 'tasks' : 'reviews', taskId, 'checkpoints', `${unitId}.json`)
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid investigation checkpoint record')
  return Object.fromEntries(Object.entries(value))
}

function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
function revision(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }

function parseCheckpoint(value: unknown, taskId: string, workflow: InvestigationCheckpoint['workflow'], unitId: string): InvestigationCheckpoint {
  const item = record(value)
  const sourcePath = (path: string): string => {
    if (workflow === 'development') return investigationPath(path)
    if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0') || posix.normalize(path) !== path || path.split('/').some(part => part === '..' || part === '.git')) throw new Error('invalid pinned review source path')
    return path
  }
  if (item.schemaVersion !== 1 || item.taskId !== taskId || item.workflow !== workflow || item.unitId !== unitId
    || !revision(item.taskRevision) || !revision(item.validatedForRevision) || !strings(item.allowedPaths) || !strings(item.attemptIds)
    || !Array.isArray(item.dependencies) || !Array.isArray(item.evidence) || !['COMPLETE', 'PARTIAL'].includes(String(item.status))) {
    throw new Error('investigation checkpoint identity or fields mismatch')
  }
  for (const name of ['repositorySnapshot', 'scopeMembershipDigest', 'scopeDigest']) if (typeof item[name] !== 'string' || !/^[a-f0-9]{64}$/.test(item[name])) throw new Error(`invalid checkpoint ${name}`)
  for (const name of ['startedAt', 'updatedAt']) if (typeof item[name] !== 'string' || !Number.isFinite(Date.parse(item[name]))) throw new Error(`invalid checkpoint ${name}`)
  const dependencies = item.dependencies.map(value => {
    const dependency = record(value)
    if (typeof dependency.path !== 'string' || typeof dependency.hash !== 'string' || !/^[a-f0-9]{64}$/.test(dependency.hash)) throw new Error('invalid checkpoint dependency')
    return { path: sourcePath(dependency.path), hash: dependency.hash }
  })
  const evidence = item.evidence.map(value => {
    const receipt = record(value)
    if (typeof receipt.executionId !== 'string' || !receipt.executionId || typeof receipt.path !== 'string'
      || typeof receipt.toolName !== 'string' || !receipt.toolName || typeof receipt.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.contentHash)) throw new Error('invalid checkpoint inspection receipt')
    if (receipt.evidenceId !== undefined && typeof receipt.evidenceId !== 'string') throw new Error('invalid inspection Git evidence ID')
    return { executionId: receipt.executionId, path: sourcePath(receipt.path), toolName: receipt.toolName, contentHash: receipt.contentHash,
      ...(receipt.evidenceId === undefined ? {} : { evidenceId: receipt.evidenceId }) }
  })
  const output = item.output === null ? null : record(item.output)
  const allowedPaths = item.allowedPaths.map(sourcePath)
  if (item.status === 'COMPLETE' && (output === null || evidence.length === 0)) throw new Error('completed checkpoint requires actual inspection evidence and output')
  if (item.status === 'COMPLETE' && /\bplaceholder\b/i.test(JSON.stringify(output))) throw new Error('completed checkpoint contains placeholder output')
  if (workflow === 'development' && evidence.some(receipt => {
    const dependency = dependencies.find(item => item.path === receipt.path)
    return dependency?.hash !== receipt.contentHash || !allowedPaths.some(scope => receipt.path === scope || receipt.path.startsWith(`${scope}/`))
  })) throw new Error('checkpoint receipt does not match its source dependencies and scope')
  let gitEvidence: GitEvidenceReceipt[] | undefined
  let gitExecutions: InvestigationCheckpoint['gitExecutions']
  if (item.gitEvidence !== undefined) {
    if (!Array.isArray(item.gitEvidence) || !Array.isArray(item.gitExecutions)) throw new Error('invalid checkpoint Git evidence records')
    gitEvidence = item.gitEvidence.map(value => {
      const receipt = record(value)
      if (typeof receipt.id !== 'string' || !receipt.id || typeof receipt.snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.snapshotId)
        || typeof receipt.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.contentHash) || typeof receipt.complete !== 'boolean' || typeof receipt.binary !== 'boolean'
        || receipt.operation !== 'show' && receipt.operation !== 'diff' && receipt.operation !== 'history' && receipt.operation !== 'changed-files') throw new Error('invalid checkpoint Git receipt identity')
      const fields: { path?: string; commit?: string; startLine?: number; endLine?: number; totalLines?: number; offset?: number; endOffset?: number; totalLength?: number } = {}
      if (receipt.path !== undefined) { if (typeof receipt.path !== 'string') throw new Error('invalid Git receipt path'); fields.path = sourcePath(receipt.path) }
      if (receipt.commit !== undefined) { if (typeof receipt.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(receipt.commit)) throw new Error('invalid Git receipt commit'); fields.commit = receipt.commit }
      for (const key of ['startLine', 'endLine', 'totalLines', 'offset', 'endOffset', 'totalLength'] as const) {
        if (receipt[key] !== undefined) { if (!revision(receipt[key])) throw new Error(`invalid Git receipt ${key}`); fields[key] = receipt[key] }
      }
      return { id: brandString<GitEvidenceId>(receipt.id), snapshotId: brandString<GitSnapshotId>(receipt.snapshotId), operation: receipt.operation,
        contentHash: receipt.contentHash, complete: receipt.complete, binary: receipt.binary, ...fields }
    })
    gitExecutions = item.gitExecutions.map(value => {
      const binding = record(value)
      if (typeof binding.evidenceId !== 'string' || !binding.evidenceId || typeof binding.executionId !== 'string' || !binding.executionId) throw new Error('invalid Git inspection execution binding')
      return { evidenceId: binding.evidenceId, executionId: binding.executionId }
    })
  }
  return { schemaVersion: 1, taskId, workflow, unitId, taskRevision: item.taskRevision, validatedForRevision: item.validatedForRevision,
    allowedPaths, attemptIds: item.attemptIds, dependencies, evidence, output, status: item.status as 'COMPLETE' | 'PARTIAL',
    repositorySnapshot: String(item.repositorySnapshot), scopeMembershipDigest: String(item.scopeMembershipDigest), scopeDigest: String(item.scopeDigest), startedAt: String(item.startedAt), updatedAt: String(item.updatedAt),
    ...(gitEvidence === undefined ? {} : { gitEvidence, gitExecutions: gitExecutions! }) }
}

/**
 * Read one persisted checkpoint, validating its task, workflow and source fields.
 * @param root - repository directory.
 * @param taskId - owning task identity.
 * @param workflow - independent artifact namespace.
 * @param unitId - assigned work unit identity.
 * @returns the checkpoint, or undefined when no evidence was persisted.
 */
export async function readInvestigationCheckpoint(root: string, taskId: string, workflow: InvestigationCheckpoint['workflow'], unitId: string): Promise<InvestigationCheckpoint | undefined> {
  let source
  try { source = await readFile(checkpointPath(root, taskId, workflow, unitId), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  return parseCheckpoint(JSON.parse(source), taskId, workflow, unitId)
}

/**
 * Atomically persist only trusted acquired evidence and schema-validated role output.
 * @param root - repository directory.
 * @param checkpoint - current partial or completed work unit.
 */
export async function saveInvestigationCheckpoint(root: string, checkpoint: InvestigationCheckpoint): Promise<void> {
  const path = checkpointPath(root, checkpoint.taskId, checkpoint.workflow, checkpoint.unitId)
  const validated = parseCheckpoint(checkpoint, checkpoint.taskId, checkpoint.workflow, checkpoint.unitId)
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
  await withFileLock(path, () => writeFileAtomic(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 }))
}
