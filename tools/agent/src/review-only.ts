/** Read-only review workflow over immutable Git snapshots and cited evidence. */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { assertObjectJsonSchema, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import Ajv from 'ajv'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { assertRouteDispatchAllowed, resolveRoleAttempts, resolveRoleEscalations } from './config.ts'
import type { HarnessConfig } from './config.ts'
import { createGitSnapshot, GitEvidenceRepository } from './git-evidence.ts'
import type { GitEvidenceReceipt, GitReviewTarget, GitSnapshot } from './git-evidence.ts'
import { boundedContext, boundedRequest, loadEngineeringProject, type RoleExecutor, type RoleInvocation, type EngineeringRole } from './automatic.ts'
import type { InspectionReceipt, InvestigationCheckpoint } from './investigation.ts'
import { TaskRepository } from './repository.ts'
import { RoleInvocationError, RoleQuiescenceError, runRoleAttempts } from './role-execution.ts'
import { roleResponseSchema, unwrapRoleResponse } from './role-response.ts'
import { TaskSchedulingRepository } from './scheduling.ts'
import { BudgetExhaustedError } from './lifecycle.ts'
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
  status: 'REVIEW_COMPLETE' | 'PARTIAL' | 'BLOCKED' | 'BUDGET_EXHAUSTED'
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
      await new TaskSchedulingRepository(root, id, 'review-only', { maxEscalations: deployment.workflow.maxCapabilityEscalations }).initializeNew()
      await repository.initializeLifecycle(id, 'review-only', {
        ...deployment.workflow.lifecycleBudget,
        maxLogicalInvocations: Math.min(deployment.workflow.lifecycleBudget.maxLogicalInvocations ?? project.maxRoleCalls, project.maxRoleCalls),
      })
    }
    if (!deepEqualJson(task.target, options.target)) throw new Error(`review task ${id} is already pinned to a different Git target`)
    if (task.dataClass !== project.dataClass) throw new Error(`project dataClass changed since review task ${id} was created`)
    if (task.snapshot.repositoryRoot !== root) throw new Error(`review task ${id} is pinned to a different repository root`)
    if (state === undefined) state = await repository.readReviewState(id)
    await options.onTaskSelected?.(id)
    signal.throwIfAborted()
    if (state.state === 'REVIEW_COMPLETE' || state.state === 'PARTIAL' || state.state === 'BLOCKED' || state.state === 'BUDGET_EXHAUSTED') {
      const result = await repository.readReviewResult(id)
      if (result.taskId !== id || result.revision !== state.revision || result.status !== state.state
        || !deepEqualJson(result.snapshot, task.snapshot) || !deepEqualJson(result.state, state)) {
        throw new Error(`review task ${id} has inconsistent persisted result identity`)
      }
      return result
    }
    options.onProgress?.(state)
    signal.throwIfAborted()
    const scheduling = new TaskSchedulingRepository(root, id, 'review-only', { maxEscalations: deployment.workflow.maxCapabilityEscalations })
    const snapshot = task.snapshot
    const lifecycle = await repository.lifecycle(id, 'review-only', {
      ...deployment.workflow.lifecycleBudget,
      maxLogicalInvocations: Math.min(deployment.workflow.lifecycleBudget.maxLogicalInvocations ?? project.maxRoleCalls, project.maxRoleCalls),
    })
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
      const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
      const receiptHash = (receipts: readonly GitEvidenceReceipt[]): string => hash(receipts.map(receipt => [
        receipt.id, receipt.snapshotId, receipt.operation, receipt.path, receipt.commit, receipt.startLine, receipt.endLine,
        receipt.totalLines, receipt.offset, receipt.endOffset, receipt.totalLength, receipt.contentHash, receipt.complete, receipt.binary,
      ]))
      const scout = role === 'scout-primary' || role === 'scout-secondary'
      const scopeDigest = hash([snapshot.id, role, scope])
      const membership = hash(scope)
      const previous = scout ? await repository.readInvestigationCheckpoint(id, 'review-only', role) : undefined
      const validPrevious = previous !== undefined && previous.repositorySnapshot === snapshot.id && previous.scopeDigest === scopeDigest
        && previous.scopeMembershipDigest === membership
      if (validPrevious) {
        for (const receipt of previous.gitEvidence ?? []) {
          const binding = previous.gitExecutions?.find(item => item.evidenceId === receipt.id)
          if (binding === undefined || !await lifecycle.validateInspection(previous.attemptIds, binding.executionId)) throw new Error('review checkpoint inspection has no durable task attempt')
        }
        await evidence.restoreEvidence(previous.gitEvidence ?? [], signal)
      }
      if (validPrevious && previous.status === 'COMPLETE' && previous.output !== null) {
        if (previous.gitEvidence === undefined || previous.gitExecutions === undefined) throw new Error('completed review checkpoint has no pinned Git receipt bindings')
        if (!deepEqualJson(previous.allowedPaths, scope.map(item => item.path)) || previous.evidence.length !== scope.length || previous.dependencies.length !== scope.length) throw new Error('review checkpoint scope or dependency count mismatch')
        for (const { path } of scope) {
          const expected = receiptHash(previous.gitEvidence.filter(receipt => receipt.path === path))
          if (previous.evidence.find(receipt => receipt.path === path)?.contentHash !== expected || previous.dependencies.find(dependency => dependency.path === path)?.hash !== expected) throw new Error('review checkpoint content references do not match its Git pages')
        }
        const output = parseOutput(previous.output)
        const problems = validateSemantics(output, snapshot, scope, evidence, inspection.changedLines, inspection.unsupported.filter(path => scope.some(item => item.path === path)))
        if (problems.length !== 0) throw new Error(`completed review checkpoint has invalid evidence: ${problems.join('; ')}`)
        await repository.saveInvestigationCheckpoint({ ...previous, validatedForRevision: currentState.revision, updatedAt: new Date().toISOString() })
        return output
      }
      const invocationId = await lifecycle.reserveInvocation(role)
      const startedAt = new Date().toISOString()
      const bounds = deployment.workflow.roleBounds[role]!
      const observations: InspectionReceipt[] = validPrevious ? (previous.gitEvidence ?? []).map(receipt => ({
        executionId: previous.gitExecutions!.find(item => item.evidenceId === receipt.id)!.executionId,
        evidenceId: receipt.id, path: receipt.path!, contentHash: receipt.contentHash, toolName: `git_${receipt.operation}`,
      })) : []
      const checkpoint: InvestigationCheckpoint | undefined = !scout ? undefined : {
        schemaVersion: 1, taskId: id, workflow: 'review-only', unitId: role, taskRevision: currentState.revision, validatedForRevision: currentState.revision,
        repositorySnapshot: snapshot.id, scopeMembershipDigest: membership, scopeDigest, allowedPaths: scope.map(item => item.path),
        dependencies: [], evidence: [], gitEvidence: validPrevious ? [...previous.gitEvidence ?? []] : [],
        gitExecutions: validPrevious ? [...previous.gitExecutions ?? []] : [], output: null, status: 'PARTIAL', startedAt, updatedAt: startedAt,
        attemptIds: validPrevious ? [...previous.attemptIds] : [],
      }
      let checkpointTail = Promise.resolve()
      const persistCheckpoint = (): Promise<void> => {
        const pending = checkpointTail.then(async () => {
          if (checkpoint === undefined) return
          checkpoint.updatedAt = new Date().toISOString()
          await repository.saveInvestigationCheckpoint(checkpoint)
        })
        checkpointTail = pending.catch(() => {})
        return pending
      }
      const requestText = await boundedRequest(join(root, '.agent/reviews', id), `${request}\nPinned target: ${snapshot.targetCommit}\nBase: ${snapshot.baseCommit}\nChanged paths: ${JSON.stringify(scope)}`, deployment.workflow.maxRoleContextBytes)
      let tools = 0
      let bodies = 0
      const seenTools = new Set<string>()
      let reservations = Promise.resolve()
      const inputDigest = createHash('sha256').update(requestText).update(membership).digest('hex')
      const reserved = (await scheduling.read()).escalations.find(item => item.status === 'RESERVED' && item.role === role && item.dispatchInput?.inputDigest === inputDigest)
      if (reserved !== undefined && reserved.sourceFingerprint !== snapshot.id) throw new Error('Reserved review escalation snapshot mismatch')
      const restored = reserved === undefined ? undefined : resolveRoleEscalations(deployment, role, reserved.dispatchInput!.failedRouteId)
      if (restored !== undefined && restored.candidates.length === 0) throw new Error('Reserved review escalation has no qualified route')
      const routes = restored === undefined ? resolveRoleAttempts(deployment, role) : [...restored.candidates, ...restored.fallbackCandidates]
      const escalation = resolveRoleEscalations(deployment, role, routes[0]!.routeId)
      const attempts = new Map<number, string>()
      let capabilityPartial: unknown = reserved?.dispatchInput?.partial
      const output = await runRoleAttempts<ReviewOutput>({
        role, attempts: routes, signal, ...(reserved === undefined ? {} : { initialEscalationId: reserved.id }),
        escalationCandidates: reserved === undefined ? escalation.candidates : [], escalationFallbackCandidates: reserved === undefined ? escalation.fallbackCandidates : [],
        onEscalate: async (failure, failedRoute, index) => {
          resolveRoleEscalations(deployment, role, failedRoute.routeId)
          capabilityPartial = failure.partial
          const record = await scheduling.reserveEscalation({ failureKey: `attempt:${attempts.get(index)}:capability`, recoveryEpoch: (await scheduling.read()).recoveryEpoch, role, reason: failure.reason, sourceFingerprint: snapshot.id, dispatchInput: { failedRouteId: failedRoute.routeId, partial: failure.partial, inputDigest } })
          return { escalationId: record.id }
        },
        beforeEscalationDispatch: (escalationId, attemptId) => scheduling.beginDispatch(escalationId, attemptId).then(() => {}),
        onEscalationSettled: async (escalationId, outcome) => {
          if (outcome.error !== undefined) await scheduling.failEscalation(escalationId, outcome.error instanceof RoleQuiescenceError)
          else await scheduling.completeEscalation(escalationId, { ...parseOutput(outcome.output) }, snapshot.id)
        },
        executeAttempt: async (route, attemptIndex, markMutationStarted, dispatch) => {
          signal.throwIfAborted()
          assertRouteDispatchAllowed(deployment, route.routeId, task.dataClass)
          const attemptId = await lifecycle.reserveAttempt(invocationId, route)
          attempts.set(attemptIndex, attemptId)
          if (reserved !== undefined && attemptIndex === 1) await scheduling.beginDispatch(reserved.id, attemptId)
          await dispatch?.onReservedAttempt?.(attemptId)
          if (checkpoint !== undefined) { checkpoint.attemptIds.push(attemptId); await persistCheckpoint() }
          const before = new Set(evidence.observedEvidence().map(receipt => receipt.id))
          const reserveToolCall = (executionId: string): Promise<void> => {
            const reservation = reservations.then(async () => {
              if (seenTools.has(executionId)) return
              if (tools >= bounds.maxToolCalls) throw new BudgetExhaustedError(`Review role ${role} exhausted its tool budget`)
              await lifecycle.reserveToolCall(attemptId, executionId)
              seenTools.add(executionId); tools += 1
            })
            reservations = reservation.catch(() => {})
            return reservation
          }
          const observe = async (receipt: InspectionReceipt): Promise<void> => {
            const actual = evidence.observedEvidence().find(item => (receipt.evidenceId ?? receipt.executionId) === item.id && item.path === receipt.path && item.contentHash === receipt.contentHash)
            if (actual === undefined || !scope.some(item => item.path === receipt.path)) throw new Error('review inspection receipt does not match an acquired pinned Git page')
            await reserveToolCall(receipt.executionId)
            if (!observations.some(item => item.executionId === receipt.executionId && item.evidenceId === actual.id)) observations.push({ ...receipt, evidenceId: actual.id })
            if (checkpoint !== undefined && !checkpoint.gitEvidence!.some(item => item.id === actual.id)) {
              checkpoint.gitEvidence!.push(actual)
              checkpoint.gitExecutions!.push({ evidenceId: actual.id, executionId: receipt.executionId })
              await persistCheckpoint()
            }
          }
          const preparedContext = await boundedContext(join(root, '.agent/reviews', id), role, {
            ...context, ...(capabilityPartial === undefined ? {} : { capabilityPartialAssertions: capabilityPartial }), reviewScope: scope, ...(checkpoint === undefined ? {} : { partialInvestigationEvidence: checkpoint.gitEvidence }),
          }, deployment.workflow.maxRoleContextBytes)
          const invocation: RoleInvocation = {
            role, route, attemptIndex, root, taskId: id,
            request: requestText,
            state: { state: phaseState, revision: currentState.revision, workRevision: 0, fixAttempts: 0 },
            context: preparedContext, outputSchema: roleResponseSchema(REVIEW_OUTPUT_SCHEMA), signal,
            reviewEvidence: evidence,
            executionControl: {
              taskId: id, routeId: route.routeId, lifecycle, invocationId, attemptId, bounds, startedAt,
              checkpoint: persistCheckpoint, recordInspection: observe,
              markBodyStart: () => {
                if (bodies >= bounds.maxToolCalls) throw new BudgetExhaustedError(`Review role ${role} exhausted its tool body budget`)
                bodies += 1
              },
              reserveToolCall,
            },
            ...(scout ? { workUnit: { id: role, role: role as 'scout-primary' | 'scout-secondary', question: 'Inspect the assigned pinned Git changes and report unresolved questions.', allowedPaths: scope.map(item => item.path), ...bounds, evidenceFormat: 'inspection-receipts' as const } } : {}),
            markMutationStarted: () => { potentiallyMutatingDispatch = true; markMutationStarted() },
          }
          let result: unknown
          let executionError: unknown
          try { result = await options.executeRole(invocation) }
          catch (error) { executionError = error; throw error }
          finally {
            try {
              for (const receipt of evidence.observedEvidence()) {
                if (before.has(receipt.id) || receipt.path === undefined || !scope.some(item => item.path === receipt.path) || observations.some(item => item.evidenceId === receipt.id)) continue
                await observe({ executionId: receipt.id, evidenceId: receipt.id, path: receipt.path, contentHash: receipt.contentHash, toolName: `git_${receipt.operation}` })
              }
            } catch (error) {
              if (executionError instanceof RoleQuiescenceError) throw new RoleQuiescenceError(executionError.message, { cause: new AggregateError([executionError, error], 'Uncertain review shutdown and checkpoint audit failed') })
              throw error
            }
          }
          if (potentiallyMutatingDispatch) throw new RoleInvocationError('review role dispatched a potentially mutating tool', 'NON_FALLBACKABLE', false)
          return result
        },
        validateOutput: value => parseOutput(unwrapRoleResponse(value, REVIEW_OUTPUT_VALIDATION_SCHEMA)),
        persistAttempts: records => persistAttempts(root, id, role, records),
      }).catch(async error => {
        if (reserved !== undefined) {
          try { await scheduling.failEscalation(reserved.id, error instanceof RoleQuiescenceError) }
          catch (auditError) {
            if (error instanceof RoleQuiescenceError) throw new RoleQuiescenceError(error.message, { cause: new AggregateError([error, auditError], 'Uncertain resumed review and audit failed') })
            throw auditError
          }
        }
        throw error
      })
      if (reserved !== undefined) await scheduling.completeEscalation(reserved.id, { ...output }, snapshot.id)
      if (checkpoint !== undefined) {
        const problems = validateSemantics(output, snapshot, scope, evidence, inspection.changedLines, inspection.unsupported.filter(path => scope.some(item => item.path === path)))
        if (problems.length === 0) {
          checkpoint.output = { ...output }
          checkpoint.status = 'COMPLETE'
          checkpoint.evidence = scope.map(({ path }) => {
            const receipts = checkpoint.gitEvidence!.filter(receipt => receipt.path === path)
            const first = observations.find(item => item.path === path)!
            return { executionId: first.executionId, path, toolName: 'git_scope', contentHash: receiptHash(receipts), evidenceId: first.evidenceId! }
          })
          checkpoint.dependencies = checkpoint.evidence.map(receipt => ({ path: receipt.path, hash: receipt.contentHash }))
        }
        await persistCheckpoint()
      }
      await lifecycle.remainingElapsedMs()
      return output
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
      await lifecycle.remainingElapsedMs()
      state = await repository.completeReviewOnly(id, state.revision, result, status)
      options.onProgress?.(state)
      return { schemaVersion: 1, revision: state.revision, status, taskId: id, snapshot, state, summary: output.summary, findings, evidence: evidenceRecords, inspectedEvidenceIds: output.inspectedEvidenceIds, unresolvedQuestions }
    } catch (error) {
      const quiescent = error instanceof RoleQuiescenceError
      const unsafe = potentiallyMutatingDispatch
      const blocker = error instanceof Error ? error.message.slice(0, 1000) : String(error)
      if (state.state === 'REVIEW_INVESTIGATION') state = await repository.advanceReview(id, state.revision, 'INDEPENDENT_REVIEW')
      if (state.state === 'INDEPENDENT_REVIEW') state = await repository.advanceReview(id, state.revision, 'EVIDENCE_VALIDATION')
      const status = quiescent || unsafe ? 'BLOCKED' : error instanceof BudgetExhaustedError ? 'BUDGET_EXHAUSTED' : 'PARTIAL'
      const unresolvedQuestions = [blocker]
      const stopConfirmation = quiescent || unsafe
      const evidenceRecords = [...evidence.observedEvidence()]
      state = await repository.completeReviewOnly(id, state.revision, { snapshot, summary: 'Review did not produce a complete evidence-backed result.', findings: [], evidence: evidenceRecords, inspectedEvidenceIds: evidenceRecords.map(item => item.id), unresolvedQuestions }, status, stopConfirmation ? 'Review work may still be active or may have changed the worktree; confirm stopped before resuming.' : undefined, stopConfirmation)
      options.onProgress?.(state)
      return { schemaVersion: 1, revision: state.revision, status, taskId: id, snapshot, state, summary: 'Review did not produce a complete evidence-backed result.', findings: [], evidence: evidenceRecords, inspectedEvidenceIds: evidenceRecords.map(item => item.id), unresolvedQuestions }
    }
  })
}
