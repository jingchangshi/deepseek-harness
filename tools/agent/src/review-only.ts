/** Read-only review workflow over immutable Git snapshots and cited evidence. */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { assertObjectJsonSchema, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import Ajv from 'ajv'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { assertRouteDispatchAllowed, resolveRoleAttempts } from './config.ts'
import type { HarnessConfig } from './config.ts'
import { createGitSnapshot, GitEvidenceRepository } from './git-evidence.ts'
import type { GitEvidenceReceipt, GitReviewTarget, GitSnapshot } from './git-evidence.ts'
import { loadEngineeringProject, type RoleExecutor, type RoleInvocation, type EngineeringRole } from './automatic.ts'
import { TaskRepository } from './repository.ts'
import { RoleInvocationError, RoleQuiescenceError, runRoleAttempts } from './role-execution.ts'
import type { ReviewFinding, ReviewOutput, ReviewStateRecord, ReviewTaskDocument } from './review-types.ts'
import type { RoleAttemptRecord } from './role-execution.ts'

/** JSON Schema passed to a Reviewer for its structured result. */
export const REVIEW_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'findings', 'inspectedEvidenceIds', 'unresolvedQuestions'],
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['severity', 'description', 'path', 'commit', 'startLine', 'endLine', 'failureCondition', 'changeRelation', 'evidenceIds'],
      properties: {
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        description: { type: 'string' }, path: { type: 'string' }, commit: { type: 'string' },
        startLine: { type: 'integer' }, endLine: { type: 'integer' },
        failureCondition: { type: 'string' }, changeRelation: { type: 'string' },
        evidenceIds: { type: 'array', items: { type: 'string' } },
      },
    } },
    inspectedEvidenceIds: { type: 'array', items: { type: 'string' } },
    unresolvedQuestions: { type: 'array', items: { type: 'string' } },
  },
}
assertObjectJsonSchema(REVIEW_OUTPUT_SCHEMA)

const REVIEW_OUTPUT_VALIDATION_SCHEMA = {
  ...REVIEW_OUTPUT_SCHEMA,
  properties: {
    ...REVIEW_OUTPUT_SCHEMA.properties,
    summary: { type: 'string', minLength: 1 },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'description', 'path', 'commit', 'startLine', 'endLine', 'failureCondition', 'changeRelation', 'evidenceIds'], properties: {
      severity: { enum: ['critical', 'high', 'medium', 'low'] }, description: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 },
      commit: { type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 },
      failureCondition: { type: 'string', minLength: 1 }, changeRelation: { type: 'string', minLength: 1 }, evidenceIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    } } },
    inspectedEvidenceIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    unresolvedQuestions: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
}

/** Inputs for one immutable Review-only run. */
export interface EngineeringReviewOptions {
  root: string
  deployment: HarnessConfig
  target: GitReviewTarget
  executeRole: RoleExecutor
  signal?: AbortSignal
  taskId?: string
  onTaskSelected?: (taskId: string) => Promise<void>
  onProgress?: (state: ReviewStateRecord) => void
}

/** Persisted review outcome and the snapshot used for every citation. */
export interface ReviewRunResult {
  schemaVersion: 1
  revision: number
  status: 'REVIEW_COMPLETE' | 'PARTIAL' | 'BLOCKED'
  taskId: string
  snapshot: GitSnapshot
  state: ReviewStateRecord
  summary: string
  findings: ReviewFinding[]
  inspectedEvidenceIds: string[]
  evidence: GitEvidenceReceipt[]
  unresolvedQuestions: string[]
}

const validOutput = new Ajv({ allErrors: true, strict: true }).compile<ReviewOutput>(REVIEW_OUTPUT_VALIDATION_SCHEMA)

function parseOutput(value: unknown): ReviewOutput {
  if (!validOutput(value)) throw new RoleInvocationError(`reviewer returned invalid output: ${JSON.stringify(validOutput.errors)}`, 'SCHEMA_INVALID', true)
  return value
}

function placeholder(value: string): boolean {
  return value.trim().length === 0 || /^(?:placeholder|todo|tbd|n\/a|none)$/iu.test(value.trim())
}

function addedLines(text: string): Set<number> {
  const result = new Set<number>()
  let line = 0
  let inHunk = false
  for (const raw of text.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(raw)
    if (hunk?.[1] !== undefined) { line = Number(hunk[1]); inHunk = true; continue }
    if (!inHunk || raw.startsWith('\\')) continue
    if (raw.startsWith('+')) { result.add(line); line++; continue }
    if (raw.startsWith(' ')) line++
  }
  return result
}

async function completePages<T extends { completeness: { complete: boolean; nextLine?: number; nextOffset?: number } }>(read: (cursor: number) => Promise<T>, start = 0): Promise<T[]> {
  const pages: T[] = []
  let cursor = start
  while (true) {
    const page = await read(cursor)
    pages.push(page)
    if (page.completeness.complete) return pages
    const next = page.completeness.nextLine ?? page.completeness.nextOffset
    if (next === undefined || next <= cursor) throw new Error('Git evidence page did not advance')
    cursor = next
  }
}

async function changedPaths(evidence: GitEvidenceRepository, signal: AbortSignal): Promise<Array<{ path: string; status: string }>> {
  const result: Array<{ path: string; status: string }> = []
  let offset = 0
  while (true) {
    const page = await evidence.changedFiles({ offset }, signal)
    result.push(...page.files)
    if (page.completeness.complete) return result
    const next = page.completeness.nextOffset
    if (next === undefined || next <= offset) throw new Error('changed-file evidence page did not advance')
    offset = next
  }
}

async function inspectScope(evidence: GitEvidenceRepository, paths: readonly { path: string; status: string }[], signal: AbortSignal): Promise<{ unsupported: string[]; changedLines: Map<string, { lines: Set<number>; totalLines: number }> }> {
  const unsupported: string[] = []
  const changedLines = new Map<string, { lines: Set<number>; totalLines: number }>()
  for (const { path, status } of paths) {
    if (status.startsWith('D')) { unsupported.push(`${path}: deleted files have no target source lines`); continue }
    try {
      const diffPages = await completePages(cursor => evidence.diff({ path, offset: cursor }, signal))
      const showPages = await completePages(cursor => evidence.show({ path, startLine: cursor === 0 ? 1 : cursor }, signal), 1)
      if (diffPages.some(page => page.binary) || showPages.some(page => page.binary)) {
        unsupported.push(`${path}: binary content cannot be reviewed as source text`)
        continue
      }
      const receipts = new Map<string, GitEvidenceReceipt>(evidence.observedEvidence().map(receipt => [receipt.id, receipt]))
      const totalLines = showPages.map(page => receipts.get(page.evidenceId)?.totalLines).find(value => value !== undefined)
      if (totalLines === undefined) throw new Error('source evidence has no total line count')
      changedLines.set(path, { lines: addedLines(diffPages.map(page => page.text).join('')), totalLines })
    } catch (error) {
      unsupported.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { unsupported, changedLines }
}

function spans(receipts: readonly GitEvidenceReceipt[], start: number, end: number, lower: (receipt: GitEvidenceReceipt) => number | undefined,
  upper: (receipt: GitEvidenceReceipt) => number | undefined): boolean {
  if (end < start) return false
  let cursor = start
  const intervals = receipts.map(receipt => ({ start: lower(receipt), end: upper(receipt) })).filter((span): span is { start: number; end: number } =>
    span.start !== undefined && span.end !== undefined && span.end >= span.start).sort((a, b) => a.start - b.start)
  for (const interval of intervals) {
    if (interval.start > cursor) return false
    if (interval.end >= cursor) cursor = interval.end + 1
    if (cursor > end) return true
  }
  return false
}

function completePathEvidence(receipts: readonly GitEvidenceReceipt[], path: string, operation: 'show' | 'diff', targetCommit: string): boolean {
  const selected = receipts.filter(receipt => receipt.operation === operation && receipt.path === path && !receipt.binary
    && (operation !== 'show' || receipt.commit === targetCommit))
  if (selected.length === 0) return false
  if (operation === 'show') {
    const total = selected[0]?.totalLines
    return total !== undefined && selected.every(receipt => receipt.totalLines === total)
      && (total === 0 || spans(selected, 1, total, receipt => receipt.startLine, receipt => receipt.endLine))
  }
  const total = selected[0]?.totalLength
  return total !== undefined && selected.every(receipt => receipt.totalLength === total)
    && (total === 0 || spans(selected, 0, total - 1, receipt => receipt.offset, receipt => receipt.endOffset === undefined ? undefined : receipt.endOffset - 1))
}

function validateSemantics(output: ReviewOutput, snapshot: GitSnapshot, paths: readonly { path: string; status: string }[], evidence: GitEvidenceRepository,
  changedLines: ReadonlyMap<string, { lines: ReadonlySet<number>; totalLines: number }>, unsupported: readonly string[]): string[] {
  const problems = [...unsupported]
  if (placeholder(output.summary)) problems.push('review summary is empty or placeholder text')
  const receipts = new Map<string, GitEvidenceReceipt>(evidence.observedEvidence().map(receipt => [receipt.id, receipt]))
  const citedReceipts: GitEvidenceReceipt[] = []
  const citedIds = new Set(output.inspectedEvidenceIds)
  for (const id of output.inspectedEvidenceIds) {
    const receipt = receipts.get(id)
    if (receipt === undefined || receipt.snapshotId !== snapshot.id) { problems.push(`unobserved evidence ID ${id}`); continue }
    if (receipt.binary) problems.push(`binary evidence ${id}`)
    citedReceipts.push(receipt)
  }
  for (const { path } of paths) {
    if (!completePathEvidence(citedReceipts, path, 'show', snapshot.targetCommit)
      || !completePathEvidence(citedReceipts, path, 'diff', snapshot.targetCommit)) problems.push(`review did not cite complete source and diff evidence for ${path}`)
  }
  for (const finding of output.findings) {
    if ([finding.description, finding.failureCondition, finding.changeRelation].some(placeholder)) problems.push(`finding in ${finding.path} contains placeholder prose`)
    if (finding.commit !== snapshot.targetCommit) problems.push(`finding in ${finding.path} names a commit outside the pinned snapshot`)
    if (!paths.some(entry => entry.path === finding.path)) problems.push(`finding path ${finding.path} is outside the changed scope`)
    if (finding.endLine < finding.startLine) problems.push(`finding in ${finding.path} has a reversed line range`)
    const lines = changedLines.get(finding.path)
    if (lines === undefined || finding.endLine > lines.totalLines || ![...lines.lines].some(line => line >= finding.startLine && line <= finding.endLine)) {
      problems.push(`finding in ${finding.path} does not identify a changed target line`)
    }
    if (finding.evidenceIds.length === 0) problems.push(`finding in ${finding.path} has no evidence citations`)
    const findingReceipts: GitEvidenceReceipt[] = []
    for (const id of finding.evidenceIds) {
      if (!citedIds.has(id)) problems.push(`finding in ${finding.path} cites evidence omitted from inspectedEvidenceIds: ${id}`)
      const receipt = receipts.get(id)
      if (receipt === undefined || receipt.snapshotId !== snapshot.id || receipt.path !== finding.path) problems.push(`finding in ${finding.path} cites invalid evidence ${id}`)
      else if (receipt.binary) problems.push(`finding in ${finding.path} cites binary evidence ${id}`)
      else findingReceipts.push(receipt)
    }
    const sourceReceipts = findingReceipts.filter(receipt => receipt.operation === 'show' && receipt.commit === snapshot.targetCommit)
    if (!spans(sourceReceipts, finding.startLine, finding.endLine, receipt => receipt.startLine, receipt => receipt.endLine)) problems.push('finding line range is not fully covered by cited target source evidence')
    if (!findingReceipts.some(receipt => receipt.operation === 'diff')) problems.push(`finding in ${finding.path} has no cited diff evidence`)
  }
  if (output.unresolvedQuestions.length > 0) problems.push(...output.unresolvedQuestions.map(question => `unresolved: ${question}`))
  return [...new Set(problems)]
}

async function persistAttempts(root: string, taskId: string, role: EngineeringRole, records: RoleAttemptRecord[]): Promise<void> {
  if (records.length === 0) return
  const directory = join(root, '.agent', 'reviews', taskId)
  const filename = join(directory, `ROUTE_ATTEMPTS.${role}.jsonl`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await withFileLock(filename, async () => {
    let previous = ''
    try { previous = await readFile(filename, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const lines = records.map(item => JSON.stringify({ schemaVersion: 1, ...item }))
    await writeFileAtomic(filename, `${previous}${lines.join('\n')}\n`, { mode: 0o600 })
  })
}

/**
 * Review fixed local commits with read-only roles and repository-owned evidence validation.
 * @param options - repository, immutable target selector, deployment routes and child executor.
 * @returns the persisted complete, partial or blocked result; rejects conflicting resume identity or cancelled admission.
 */
export async function runEngineeringReview(options: EngineeringReviewOptions): Promise<ReviewRunResult> {
  const root = await realpath(options.root)
  const signal = options.signal ?? new AbortController().signal
  const repository = new TaskRepository(root)
  await repository.init()
  const deployment = options.deployment
  const reviewer = deployment.roles.reviewer
  if (reviewer === undefined || !reviewer.enabled || reviewer.writable || reviewer.toolPolicy !== 'read-only') {
    throw new Error('Review-only requires an enabled read-only Reviewer role; only writable role may be implementer')
  }
  const project = await loadEngineeringProject(root)
  const id = options.taskId ?? `review-${randomUUID()}`

  return withFileLock(join(root, '.agent/AUTO_RUN'), async () => {
    signal.throwIfAborted()
    await repository.assertDispatchAdmission(id)
    let task: ReviewTaskDocument
    let state: ReviewStateRecord | undefined
    try {
      task = await repository.readReview(id)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const snapshot = await createGitSnapshot(root, options.target, signal, {
        commandTimeoutMs: deployment.workflow.reviewGitCommandTimeoutMs,
        maxOutputBytes: deployment.workflow.reviewGitMaxOutputBytes,
        defaultPageSize: deployment.workflow.reviewGitPageSize,
      })
      task = { schemaVersion: 1 as const, id, target: options.target, snapshot, scope: [], dataClass: project.dataClass, createdAt: new Date().toISOString() }
      state = await repository.createReview(task)
    }
    if (!deepEqualJson(task.target, options.target)) throw new Error(`review task ${id} is already pinned to a different Git target`)
    if (task.dataClass !== project.dataClass) throw new Error(`project dataClass changed since review task ${id} was created`)
    if (task.snapshot.repositoryRoot !== root) throw new Error(`review task ${id} is pinned to a different repository root`)
    if (state === undefined) state = await repository.readReviewState(id)
    await options.onTaskSelected?.(id)
    signal.throwIfAborted()
    if (state.state === 'REVIEW_COMPLETE' || state.state === 'PARTIAL' || state.state === 'BLOCKED') {
      const result = await repository.readReviewResult(id)
      if (result.taskId !== id || result.revision !== state.revision || result.status !== state.state
        || !deepEqualJson(result.snapshot, task.snapshot) || !deepEqualJson(result.state, state)) {
        throw new Error(`review task ${id} has inconsistent persisted result identity`)
      }
      return result
    }
    options.onProgress?.(state)
    signal.throwIfAborted()
    const snapshot = task.snapshot
    if (state.state === 'REQUEST') state = await repository.advanceReview(id, state.revision, 'SNAPSHOT')
    const evidenceOptions = {
      commandTimeoutMs: deployment.workflow.reviewGitCommandTimeoutMs,
      maxOutputBytes: deployment.workflow.reviewGitMaxOutputBytes,
      defaultPageSize: deployment.workflow.reviewGitPageSize,
    }
    const scopeEvidence = new GitEvidenceRepository(snapshot, evidenceOptions)
    let paths = task.scope
    if (state.state === 'SNAPSHOT') {
      paths = await changedPaths(scopeEvidence, signal)
      state = await repository.classifyReviewScope(id, state.revision, paths)
      task = { ...task, scope: paths }
    } else {
      const actualScope = await changedPaths(scopeEvidence, signal)
      if (!deepEqualJson(actualScope, task.scope)) throw new Error(`review task ${id} has inconsistent persisted changed scope`)
      paths = actualScope
    }
    if (state.state === 'SCOPE_CLASSIFIED') state = await repository.advanceReview(id, state.revision, 'REVIEW_INVESTIGATION')
    const validationEvidence = new GitEvidenceRepository(snapshot, evidenceOptions)
    const evidence = new GitEvidenceRepository(snapshot, evidenceOptions)
    const context = { reviewSnapshot: snapshot, reviewScope: paths, dataClass: task.dataClass }
    let potentiallyMutatingDispatch = false
    let inspection: { unsupported: string[]; changedLines: Map<string, { lines: Set<number>; totalLines: number }> } = { unsupported: [], changedLines: new Map() }
    const invoke = async (role: EngineeringRole, scope: readonly { path: string; status: string }[], phaseState: ReviewStateRecord['state'], request: string): Promise<ReviewOutput> => {
      const currentState = state
      if (currentState === undefined) throw new Error('review has no current state')
      return runRoleAttempts<ReviewOutput>({
        role, attempts: resolveRoleAttempts(deployment, role), signal,
        executeAttempt: async (route, attemptIndex, markMutationStarted) => {
          signal.throwIfAborted()
          assertRouteDispatchAllowed(deployment, route.routeId, task.dataClass)
          const invocation: RoleInvocation = {
            role, route, attemptIndex, root, taskId: id,
            request: `${request}\nPinned target: ${snapshot.targetCommit}\nBase: ${snapshot.baseCommit}\nChanged paths: ${JSON.stringify(scope)}`,
            state: { state: phaseState, revision: currentState.revision, workRevision: 0, fixAttempts: 0 },
            context: { ...context, reviewScope: scope }, outputSchema: REVIEW_OUTPUT_SCHEMA, signal,
            reviewEvidence: evidence,
            markMutationStarted: () => { potentiallyMutatingDispatch = true; markMutationStarted() },
          }
          const result = await options.executeRole(invocation)
          if (potentiallyMutatingDispatch) throw new RoleInvocationError('review role dispatched a potentially mutating tool', 'NON_FALLBACKABLE', false)
          return result
        },
        validateOutput: parseOutput,
        persistAttempts: records => persistAttempts(root, id, role, records),
      })
    }
    try {
      inspection = await inspectScope(validationEvidence, paths, signal)
      const scoutNotes: Array<{ role: string; scope: string[]; summary: string; findings: ReviewFinding[] }> = []
      const maxFiles = deployment.workflow.reviewMaxDirectFiles
      if (paths.length > maxFiles) {
        const scoutCount = Math.min(deployment.workflow.reviewMaxScouts, paths.length, 2)
        const configuredScoutRoles: EngineeringRole[] = ['scout-primary', 'scout-secondary']
        const scoutRoles = configuredScoutRoles.slice(0, scoutCount)
        for (const [index, role] of scoutRoles.entries()) {
          const scoutScope = paths.filter((_path, pathIndex) => pathIndex % scoutCount === index)
          const scout = await invoke(role, scoutScope, 'REVIEW_INVESTIGATION', 'Inspect only your assigned disjoint scope. Report concrete risks with Git evidence receipt IDs.')
          scoutNotes.push({ role, scope: scoutScope.map(entry => entry.path), summary: scout.summary, findings: scout.findings })
        }
      }
      if (state.state === 'REVIEW_INVESTIGATION') state = await repository.advanceReview(id, state.revision, 'INDEPENDENT_REVIEW')
      const output = await invoke('reviewer', paths, 'INDEPENDENT_REVIEW', `Independently review every changed path. Check these scout notes where present, then validate the complete change set yourself. Do not accept unsupported claims.\nScout notes: ${JSON.stringify(scoutNotes)}`)
      const problems = validateSemantics(output, snapshot, paths, evidence, inspection.changedLines, inspection.unsupported)
      const unresolvedQuestions = [...output.unresolvedQuestions, ...problems]
      if (state.state === 'INDEPENDENT_REVIEW') state = await repository.advanceReview(id, state.revision, 'EVIDENCE_VALIDATION')
      const status = problems.length === 0 ? 'REVIEW_COMPLETE' : 'PARTIAL'
      const findings = problems.length === 0 ? output.findings : []
      const citedIds = new Set([...output.inspectedEvidenceIds, ...findings.flatMap(finding => finding.evidenceIds)])
      const evidenceRecords = evidence.observedEvidence().filter(receipt => citedIds.has(receipt.id))
      const result = { snapshot, summary: output.summary, findings, evidence: evidenceRecords,
        inspectedEvidenceIds: output.inspectedEvidenceIds, unresolvedQuestions }
      state = await repository.completeReviewOnly(id, state.revision, result, status)
      options.onProgress?.(state)
      return { schemaVersion: 1, revision: state.revision, status, taskId: id, snapshot, state, summary: output.summary, findings, evidence: evidenceRecords, inspectedEvidenceIds: output.inspectedEvidenceIds, unresolvedQuestions }
    } catch (error) {
      const quiescent = error instanceof RoleQuiescenceError
      const unsafe = potentiallyMutatingDispatch
      const blocker = error instanceof Error ? error.message.slice(0, 1000) : String(error)
      if (state.state === 'REVIEW_INVESTIGATION') state = await repository.advanceReview(id, state.revision, 'INDEPENDENT_REVIEW')
      if (state.state === 'INDEPENDENT_REVIEW') state = await repository.advanceReview(id, state.revision, 'EVIDENCE_VALIDATION')
      const status = quiescent || unsafe ? 'BLOCKED' : 'PARTIAL'
      const unresolvedQuestions = [blocker]
      const stopConfirmation = quiescent || unsafe
      const evidenceRecords = [...evidence.observedEvidence()]
      state = await repository.completeReviewOnly(id, state.revision, { snapshot, summary: 'Review did not produce a complete evidence-backed result.', findings: [], evidence: evidenceRecords, inspectedEvidenceIds: evidenceRecords.map(item => item.id), unresolvedQuestions }, status, stopConfirmation ? 'Review work may still be active or may have changed the worktree; confirm stopped before resuming.' : undefined, stopConfirmation)
      options.onProgress?.(state)
      return { schemaVersion: 1, revision: state.revision, status, taskId: id, snapshot, state, summary: 'Review did not produce a complete evidence-backed result.', findings: [], evidence: evidenceRecords, inspectedEvidenceIds: evidenceRecords.map(item => item.id), unresolvedQuestions }
    }
  })
}
