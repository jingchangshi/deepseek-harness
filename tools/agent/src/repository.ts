/** Durable repository store for task artifacts and revisioned state. */

import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { load, dump } from 'js-yaml'
import { deepEqualJson, isJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ArtifactSchemas } from './schemas.ts'
import type { ArtifactSchemaName, ReviewArtifactSchemaName } from './schemas.ts'
import { taskRequiresStopConfirmation, transition } from './state-machine.ts'
import type { TaskAction } from './state-machine.ts'
import { initializeMissingRepositoryFiles, repositoryTemplateFiles } from './templates.ts'
import { assertVerificationEvidence, loadVerificationProfile, resolveVerificationCommand, verificationInstanceId } from './verification.ts'
import type { ProjectVerificationConfig, VerificationGate } from './verification.ts'
import type { RunnerContext } from './runner.ts'
import { captureSourceInventory, identityDigest, loadRepositoryVerificationContext, resolveVerificationExtras, sourceImpactPaths } from './identity.ts'
import type { PlanBinding, RepositoryVerificationContext, VerificationIdentity } from './identity.ts'
import { requiredVerificationGates, resolveVerificationRequirements } from './policy.ts'
import type {
  CheckStatus,
  BoundDecisionDocument,
  BoundPlanDocument,
  EvidenceDocument,
  PlanRecord,
  ReviewRecord,
  TaskDocument,
  TaskStateRecord,
  VerificationRecord,
} from './types.ts'
import type { ReviewStateRecord, ReviewTaskDocument } from './review-types.ts'
import type { ReviewRunResult } from './review-only.ts'
import { transitionReview } from './state-machine.ts'

const ARTIFACT_FILES = {
  baseline: 'BASELINE.json',
  investigation: 'INVESTIGATION.json',
  plan: 'PLAN.json',
  verification: 'VERIFY.json',
  review: 'REVIEW.json',
  decision: 'DECISION.json',
} as const

type WritableArtifactName = keyof typeof ARTIFACT_FILES

/** Atomic writer injection used to exercise interrupted commits. */
export type AtomicWriter = typeof writeFileAtomic

/** Repository-validated commands, required instances and source arguments for one sealed attempt. */
export interface VerificationExecutionContext {
  config: ProjectVerificationConfig
  gates: VerificationGate[]
  arguments: RunnerContext
  identity: VerificationIdentity
}

/** One review-only task and its current state. */
export interface StoredReviewTask {
  task: ReviewTaskDocument
  state: ReviewStateRecord
}

/** Options for deterministic timestamps and failure injection. */
export interface TaskRepositoryOptions {
  now?: () => string
  writeAtomic?: AtomicWriter
  writerToken?: () => string
  templateRoot?: string
  presetRoot?: string
  presetId?: string
}

/** Error raised when a caller tries to mutate an obsolete revision. */
export class StaleRevisionError extends Error {
  /** Create a stale-write diagnostic with expected and current revisions. */
  constructor(expected: number, current: number) {
    super(`stale task revision: expected ${String(expected)}, current ${String(current)}`)
    this.name = 'StaleRevisionError'
  }
}

/** A verified plan still needs product information before acceptance. */
export class PlanAssumptionBlocker extends Error {
  /** Create an actionable blocker from the frozen plan's unresolved statements. */
  constructor(statements: readonly string[]) {
    const listed = statements.map((statement, index) => `${String(index + 1)}. ${statement}`).join('\n')
    super(`acceptance is blocked by ${String(statements.length)} unresolved plan assumption(s); replan with a request that resolves them:\n${listed}`)
    this.name = 'PlanAssumptionBlocker'
  }
}

function json(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Repository operations that keep task state authoritative over artifacts. */
export class TaskRepository {
  private readonly schemas: ArtifactSchemas
  private readonly now: () => string
  private readonly writeAtomic: AtomicWriter
  private readonly writerToken: () => string
  private readonly templateRoot: string | undefined
  private readonly presetRoot: string | undefined
  private readonly presetId: string | undefined

  /**
   * Create a task repository facade.
   * @param root - target project root containing `.agent`.
   * @param schemaRoot - committed schema directory; defaults to the target project.
    * @param options - template source, deterministic clock, and writer injection.
   */
  constructor(
    private readonly root: string,
    schemaRoot = join(root, '.agent', 'schemas'),
    options: TaskRepositoryOptions = {},
  ) {
    this.schemas = new ArtifactSchemas(schemaRoot)
    this.now = options.now ?? (() => new Date().toISOString())
    this.writeAtomic = options.writeAtomic ?? writeFileAtomic
    this.writerToken = options.writerToken ?? randomUUID
    this.templateRoot = options.templateRoot
    this.presetRoot = options.presetRoot
    this.presetId = options.presetId
  }

  /** Initialize missing generic or explicitly selected preset files without replacing repository edits. */
  async init(): Promise<void> {
    const templateRoot = this.templateRoot
    if (templateRoot !== undefined) {
      await initializeMissingRepositoryFiles(this.root, await repositoryTemplateFiles(templateRoot, this.presetRoot, this.presetId))
    }
    await mkdir(join(this.root, '.agent', 'tasks'), { recursive: true })
    await mkdir(join(this.root, '.agent', 'reviews'), { recursive: true })
  }

  /** Create an immutable review task and its independent initial state. */
  async createReview(task: ReviewTaskDocument): Promise<ReviewStateRecord> {
    await this.schemas.validate('review-task', task)
    const directory = this.reviewDirectory(task.id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const statePath = join(directory, 'STATE.json')
    return withFileLock(statePath, async () => {
      if (await this.readOptional(statePath) !== undefined) throw new Error(`review "${task.id}" already exists`)
      const state: ReviewStateRecord = {
        schemaVersion: 1, taskId: task.id, state: 'REQUEST', revision: 0,
        workRevision: 0, fixAttempts: 0, writer: null, updatedAt: this.now(),
      }
      await this.schemas.validate('review-state', state)
      await this.writeAtomic(join(directory, 'TASK.json'), json(task), { mode: 0o600 })
      await this.writeAtomic(statePath, json(state), { mode: 0o600 })
      return state
    })
  }

  /** Read the immutable review target and pinned Git snapshot. */
  async readReview(taskId: string): Promise<ReviewTaskDocument> {
    return this.readJson('review-task', join(this.reviewDirectory(taskId), 'TASK.json')) as Promise<ReviewTaskDocument>
  }

  /** Read the current state of a review-only workflow. */
  async readReviewState(taskId: string): Promise<ReviewStateRecord> {
    return this.readJson('review-state', join(this.reviewDirectory(taskId), 'STATE.json')) as Promise<ReviewStateRecord>
  }

  /** Read the committed result of a completed review. */
  async readReviewResult(taskId: string): Promise<ReviewRunResult> {
    return this.readJson<ReviewRunResult>('review-result', join(this.reviewDirectory(taskId), 'RESULT.json'))
  }

  /** List review-only tasks without consulting or advancing development task states. */
  async listReviews(taskId?: string): Promise<StoredReviewTask[]> {
    if (taskId !== undefined) return [{ task: await this.readReview(taskId), state: await this.readReviewState(taskId) }]
    let ids: string[]
    try { ids = await readdir(join(this.root, '.agent', 'reviews')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const reviews: StoredReviewTask[] = []
    for (const id of ids) {
      try { reviews.push({ task: await this.readReview(id), state: await this.readReviewState(id) }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return reviews
  }

  /** Resume a quiescence-blocked review only after explicit stopped confirmation. */
  async recoverReview(taskId: string, confirmedStopped: boolean): Promise<ReviewStateRecord> {
    const statePath = join(this.reviewDirectory(taskId), 'STATE.json')
    return withFileLock(statePath, async () => {
      const current = await this.readReviewState(taskId)
      const next = transitionReview(current, { type: 'recover', confirmedStopped }, this.now())
      await this.schemas.validate('review-state', next)
      await this.writeAtomic(statePath, json(next), { mode: 0o600 })
      return next
    })
  }

  /** Advance one review-only stage with revision compare-and-swap. */
  async advanceReview(taskId: string, expectedRevision: number, nextStage: 'SNAPSHOT' | 'SCOPE_CLASSIFIED' | 'REVIEW_INVESTIGATION' | 'INDEPENDENT_REVIEW' | 'EVIDENCE_VALIDATION'): Promise<ReviewStateRecord> {
    return this.mutateReview(taskId, expectedRevision, current => transitionReview(current, { type: 'advance', state: nextStage }, this.now()))
  }

  /** Persist classified changed paths once while advancing SNAPSHOT to SCOPE_CLASSIFIED. */
  async classifyReviewScope(taskId: string, expectedRevision: number, scope: Array<{ path: string; status: string }>): Promise<ReviewStateRecord> {
    const directory = this.reviewDirectory(taskId)
    const statePath = join(directory, 'STATE.json')
    return withFileLock(statePath, async () => {
      const current = await this.readReviewState(taskId)
      if (current.revision !== expectedRevision) throw new StaleRevisionError(expectedRevision, current.revision)
      if (current.state !== 'SNAPSHOT') throw new Error(`cannot classify review scope from ${current.state}`)
      const task = await this.readReview(taskId)
      if (task.scope.length !== 0) throw new Error('review scope was already classified')
      const updatedTask = { ...task, scope }
      const next = transitionReview(current, { type: 'advance', state: 'SCOPE_CLASSIFIED' }, this.now())
      await this.schemas.validate('review-task', updatedTask)
      await this.schemas.validate('review-state', next)
      await this.writeAtomic(join(directory, 'TASK.json'), json(updatedTask), { mode: 0o600 })
      await this.writeAtomic(statePath, json(next), { mode: 0o600 })
      return next
    })
  }

  /** Persist one review result and terminal state with a revision compare-and-swap. */
  async completeReviewOnly(taskId: string, expectedRevision: number, result: object, status: 'REVIEW_COMPLETE' | 'PARTIAL' | 'BLOCKED', blocker?: string, requiresStopConfirmation = false): Promise<ReviewStateRecord> {
    const directory = this.reviewDirectory(taskId)
    const statePath = join(directory, 'STATE.json')
    return withFileLock(statePath, async () => {
      const current = await this.readReviewState(taskId)
      if (current.revision !== expectedRevision) throw new StaleRevisionError(expectedRevision, current.revision)
      const next = transitionReview(current, { type: 'complete', status, ...(blocker === undefined ? {} : { blocker }), ...(requiresStopConfirmation ? { requiresStopConfirmation: true } : {}) }, this.now())
      const document = { ...result, schemaVersion: 1, taskId, revision: next.revision, status, state: next }
      await this.schemas.validate('review-result', document)
      await this.schemas.validate('review-state', next)
      await this.writeAtomic(join(directory, 'RESULT.json'), json(document), { mode: 0o600 })
      await this.writeAtomic(statePath, json(next), { mode: 0o600 })
      return next
    })
  }

  /**
   * Create one task after its repository profile has passed declaration and gate validation.
   * @param task - immutable task metadata.
   * @returns the initial authoritative state.
   */
  async createTask(task: TaskDocument): Promise<TaskStateRecord> {
    await this.schemas.validate('task', task)
    await loadVerificationProfile(this.root, task.profile)
    const context = await loadRepositoryVerificationContext(this.root, task.profile)
    const directory = this.taskDirectory(task.id)
    await mkdir(directory, { recursive: true })
    const statePath = join(directory, 'STATE.json')
    return withFileLock(statePath, async () => {
      if (await this.readOptional(statePath) !== undefined) throw new Error(`task "${task.id}" already exists`)
      const state: TaskStateRecord = {
        schemaVersion: 1,
        taskId: task.id,
        state: 'NEW',
        revision: 0,
        workRevision: 0,
        fixAttempts: 0,
        writer: null,
        updatedAt: this.now(),
      }
      await this.schemas.validate('state', state)
      await this.writeAtomic(join(directory, 'TASK.yaml'), dump(task, { noRefs: true, lineWidth: -1 }), { mode: 0o600 })
      await this.writeAtomic(join(directory, 'TASK_PRESET.json'), json({ schemaVersion: 1, preset: context.preset }), { mode: 0o600 })
      await this.writeAtomic(statePath, json(state), { mode: 0o600 })
      return state
    })
  }

  /** Read and validate immutable task metadata. */
  async readTask(taskId: string): Promise<TaskDocument> {
    const value = load(await readFile(join(this.taskDirectory(taskId), 'TASK.yaml'), 'utf8'))
    return this.schemas.validate('task', value) as Promise<TaskDocument>
  }

  /** Read and validate current task state. */
  async readState(taskId: string): Promise<TaskStateRecord> {
    return this.readJson('state', join(this.taskDirectory(taskId), 'STATE.json')) as Promise<TaskStateRecord>
  }

  /** Record baseline evidence and enter `BASELINED`. */
  async baseline(taskId: string, expectedRevision: number, input: object): Promise<TaskStateRecord> {
    return this.writeArtifactTransition(taskId, expectedRevision, 'baseline', input, { type: 'baseline' })
  }

  /** Record investigation results and enter `INVESTIGATED`. */
  async investigate(taskId: string, expectedRevision: number, input: object): Promise<TaskStateRecord> {
    return this.writeArtifactTransition(taskId, expectedRevision, 'investigation', input, { type: 'investigate' })
  }

  /** Freeze a validated plan and create a new work revision. */
  async freezePlan(taskId: string, expectedRevision: number, input: object): Promise<TaskStateRecord> {
    return this.writeArtifactTransition(taskId, expectedRevision, 'plan', input, { type: 'freeze-plan' })
  }

  /** Acquire the sole writer lease and enter implementation. */
  async startImplementation(taskId: string, expectedRevision: number): Promise<TaskStateRecord> {
    return withFileLock(join(this.root, '.agent', 'WRITER_ADMISSION'), () => withFileLock(join(this.taskDirectory(taskId), 'STATE.json'), async () => {
      await this.assertDispatchAdmission(taskId)
      const current = await this.readState(taskId)
      this.assertRevision(current, expectedRevision)
      const plan = await this.readBoundPlan(taskId)
      await this.boundContext(taskId, plan)
      const next = transition(current, { type: 'start-implementation', writerToken: this.writerToken() }, this.now())
      await this.writeBoundPlan(taskId, { ...plan, binding: { ...plan.binding, seal: null } })
      await this.writeAtomic(join(this.taskDirectory(taskId), 'STATE.json'), json(next), { mode: 0o600 })
      return next
    }))
  }

  /**
   * Reject dispatch while any task owns a writer or records uncertain termination.
   * @param taskId - selected task, whose completed writer may be allowed.
   * @param allowedCompletedWriterRevision - revision of a successfully completed writer for this task.
   * @param confirmedRecovery - whether recovery explicitly confirmed stopped work for the selected task.
   * @returns void when no task blocks dispatch.
   */
  async assertDispatchAdmission(taskId: string, allowedCompletedWriterRevision?: number, confirmedRecovery = false): Promise<void> {
    const tasksRoot = join(this.root, '.agent', 'tasks')
    for (const entry of await readdir(tasksRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const statePath = join(tasksRoot, entry.name, 'STATE.json')
      if (await this.readOptional(statePath) === undefined) continue
      const state = await this.readJson('state', statePath) as TaskStateRecord
      if (confirmedRecovery && entry.name === taskId) continue
      const allowedOwnWriter = entry.name === taskId && allowedCompletedWriterRevision !== undefined
        && state.writer?.baseRevision === allowedCompletedWriterRevision
      if (allowedOwnWriter) continue
      if (state.writer !== null) throw new Error(`task ${state.taskId} has an interrupted writer; stop its agent and explicitly release its lease before dispatch`)
      if (taskRequiresStopConfirmation(state)) throw new Error(`task ${state.taskId} requires confirmation that all agent and command work has stopped before dispatch`)
    }
    const reviewsRoot = join(this.root, '.agent', 'reviews')
    let reviewIds: string[]
    try { reviewIds = await readdir(reviewsRoot) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const reviewId of reviewIds) {
      const statePath = join(reviewsRoot, reviewId, 'STATE.json')
      if (await this.readOptional(statePath) === undefined) continue
      const review = await this.readJson('review-state', statePath) as ReviewStateRecord
      if (confirmedRecovery && reviewId === taskId) continue
      if (review.requiresStopConfirmation === true) throw new Error(`review ${review.taskId} requires confirmation that all review work has stopped before dispatch`)
    }
  }

  /** Release an owned lease after its executor has stopped, retaining partial work for resumption. */
  async releaseImplementation(taskId: string, expectedRevision: number, writerToken: string): Promise<TaskStateRecord> {
    return this.mutate(taskId, expectedRevision, current => transition(current, { type: 'release-implementation', writerToken }, this.now()))
  }

  /** Close an owned writer before running deterministic commands. */
  async beginVerification(taskId: string, expectedRevision: number, writerToken: string): Promise<TaskStateRecord> {
    return withFileLock(join(this.taskDirectory(taskId), 'STATE.json'), async () => {
      const current = await this.readState(taskId)
      this.assertRevision(current, expectedRevision)
      const next = transition(current, { type: 'begin-verification', writerToken }, this.now())
      const plan = await this.readBoundPlan(taskId)
      const context = await this.boundContext(taskId, plan)
      const source = await captureSourceInventory(this.root)
      const requirements = resolveVerificationRequirements(context.gates, context.policy, sourceImpactPaths(plan.binding.baseline, source),
        plan.binding.extras, plan.binding.requirements.tier, plan.binding.requirements)
      const attempt = plan.binding.attempt + 1
      const seal: VerificationIdentity = {
        attempt, sourceTreeDigest: source.sourceTreeDigest, verificationPolicyDigest: context.verificationPolicyDigest,
        repositoryProfileDigest: context.repositoryProfileDigest,
        requiredSetDigest: identityDigest<'RequiredSetDigest'>({ tier: requirements.tier, instances: requirements.instances.map(instance => ({ id: instance.id, sources: instance.sources })) }),
      }
      await this.writeImmutableJson(join(this.taskDirectory(taskId), `ATTEMPT.${String(current.workRevision)}.${String(attempt)}.json`), {
        ...plan, taskRevision: next.revision, binding: { ...plan.binding, attempt, seal, requirements },
      })
      await this.writeBoundPlan(taskId, { ...plan, binding: { ...plan.binding, attempt, seal, requirements } })
      await this.writeAtomic(join(this.taskDirectory(taskId), 'STATE.json'), json(next), { mode: 0o600 })
      return next
    })
  }

  /**
   * Validate the sealed source and policy before dispatching verification or review.
   * @param taskId - task whose current attempt is sealed.
   * @returns all profile instances with the cumulative deterministic required flags.
   */
  async verificationGates(taskId: string): Promise<VerificationGate[]> {
    const plan = await this.readBoundPlan(taskId)
    const context = await this.assertBoundIdentity(taskId, plan)
    return requiredVerificationGates(context.gates, plan.binding.requirements)
  }

  /**
   * Return source-derived argv values for the current sealed attempt.
   * @param taskId - task whose source and policy are sealed.
   * @returns baseline revision, observed paths and repository-selected tests.
   */
  async verificationArguments(taskId: string): Promise<RunnerContext> {
    const plan = await this.readBoundPlan(taskId)
    const context = await this.assertBoundIdentity(taskId, plan)
    return this.commandArguments(plan, context)
  }

  /**
   * Capture the execution identity before dispatching commands.
   * @param taskId - task with a committed source seal.
   * @returns the immutable identity that command results must retain.
   */
  async verificationIdentity(taskId: string): Promise<VerificationIdentity> {
    const plan = await this.readBoundPlan(taskId)
    await this.assertBoundIdentity(taskId, plan)
    if (plan.binding.seal === null) throw new Error('verification source is unsealed')
    return plan.binding.seal
  }

  /**
   * Capture commands and source arguments from one validated frozen-plan binding.
   * @param taskId - task whose verification attempt is sealed.
   * @returns the current validated execution inputs for that attempt.
   */
  async verificationExecutionContext(taskId: string): Promise<VerificationExecutionContext> {
    const plan = await this.readBoundPlan(taskId)
    const context = await this.assertBoundIdentity(taskId, plan)
    if (context.verificationConfig === null) throw new Error('verification commands are not configured')
    if (plan.binding.seal === null) throw new Error('verification source is unsealed')
    return {
      config: context.verificationConfig,
      gates: requiredVerificationGates(context.gates, plan.binding.requirements),
      arguments: await this.commandArguments(plan, context),
      identity: plan.binding.seal,
    }
  }

  /**
   * Reject changed execution inputs before dispatch or authoritative evidence publication.
   * @param taskId - task that owns the snapshot.
   * @param snapshot - inputs captured for the dispatched attempt.
   * @returns nothing when every binding and execution input still matches.
   */
  async assertVerificationExecutionContext(taskId: string, snapshot: VerificationExecutionContext): Promise<void> {
    const current = await this.verificationExecutionContext(taskId)
    if (!deepEqualJson(current, snapshot)) throw new Error('verification execution identity changed; explicitly replan and verify again')
  }

  /** Complete or resume verification after commands have actually run. */
  async finishVerification(taskId: string, expectedRevision: number, input: object): Promise<TaskStateRecord> {
    return this.writeArtifactTransition(taskId, expectedRevision, 'verification', input, { type: 'complete-verification', status: this.statusOf(input) })
  }

  /** Complete a review whose beginning was already committed. */
  async finishReview(taskId: string, expectedRevision: number, input: object): Promise<TaskStateRecord> {
    const blocker = this.optionalString(input, 'blocker')
    return this.writeArtifactTransition(taskId, expectedRevision, 'review', input, {
      type: 'complete-review', decision: this.reviewDecisionOf(input), ...blocker === undefined ? {} : { blocker },
    })
  }

  /**
   * Close the writer lease, record verification, and choose verified, repair, or replan.
   * @param taskId - task receiving verification.
   * @param expectedRevision - revision that owns the active writer lease.
   * @param writerToken - exact active writer token.
   * @param input - verification artifact without repository-owned identity fields.
   */
  async verify(
    taskId: string,
    expectedRevision: number,
    writerToken: string,
    input: object,
  ): Promise<TaskStateRecord> {
    const verifying = await this.beginVerification(taskId, expectedRevision, writerToken)
    return this.writeArtifactTransition(
      taskId,
      verifying.revision,
      'verification',
      input,
      { type: 'complete-verification', status: this.statusOf(input) },
    )
  }

  /** Record an independent review and apply its bounded outcome. */
  async review(taskId: string, expectedRevision: number, input: object): Promise<TaskStateRecord> {
    const reviewing = await this.mutate(taskId, expectedRevision, current =>
      transition(current, { type: 'begin-review' }, this.now()))
    const decision = this.reviewDecisionOf(input)
    const blocker = this.optionalString(input, 'blocker')
    return this.writeArtifactTransition(taskId, reviewing.revision, 'review', input, {
      type: 'complete-review',
      decision,
      ...blocker === undefined ? {} : { blocker },
    })
  }

  /** Evaluate deterministic artifacts and enter terminal acceptance. */
  async accept(taskId: string, expectedRevision: number): Promise<TaskStateRecord> {
    const directory = this.taskDirectory(taskId)
    const statePath = join(directory, 'STATE.json')
    return withFileLock(statePath, async () => {
      const current = await this.readState(taskId)
      this.assertRevision(current, expectedRevision)
      const plan = await this.readJson('plan', join(directory, ARTIFACT_FILES.plan)) as PlanRecord
      const verification = await this.readJson('verification', join(directory, ARTIFACT_FILES.verification)) as VerificationRecord
      const review = await this.readJson('review', join(directory, ARTIFACT_FILES.review)) as ReviewRecord
      this.assertAcceptance(current, plan, verification, review)
      if (plan.schemaVersion !== 2 || verification.schemaVersion !== 3 || review.schemaVersion !== 2) throw new Error('acceptance requires identity-bearing artifacts; replan and verify again')
      const context = await this.assertBoundIdentity(taskId, plan)
      if (!deepEqualJson(plan.binding.seal, verification.identity) || !deepEqualJson(verification.identity, review.identity)) throw new Error('acceptance artifact identity changed; explicitly replan')
      const evidence: EvidenceDocument[] = []
      for (const line of (await readFile(join(directory, 'EVIDENCE.jsonl'), 'utf8')).split('\n').filter(line => line.trim().length > 0)) {
        evidence.push(await this.schemas.validate('evidence', JSON.parse(line)) as EvidenceDocument)
      }
      const argumentsContext = await this.commandArguments(plan, context)
      const commands = new Map(context.gates.flatMap(gate => {
        const adapter = context.verificationConfig?.adapters[gate.adapter]
        return adapter === undefined ? [] : [[verificationInstanceId(gate), resolveVerificationCommand(this.root, adapter, argumentsContext)] as const]
      }))
      assertVerificationEvidence(requiredVerificationGates(context.gates, plan.binding.requirements), verification, evidence, verification.identity, commands)
      this.assertResolvedPlanAssumptions(plan)
      const next = transition(current, { type: 'accept' }, this.now())
      const decision: BoundDecisionDocument = {
        schemaVersion: 2,
        taskId,
        taskRevision: next.revision,
        workRevision: current.workRevision,
        decision: 'ACCEPTED',
        acceptedAt: next.updatedAt,
        verificationStatus: 'PASS',
        reviewDecision: 'ACCEPT',
        identity: verification.identity,
      }
      await this.schemas.validate('decision', decision)
      await this.schemas.validate('state', next)
      await this.writeAtomic(join(directory, ARTIFACT_FILES.decision), json(decision), { mode: 0o600 })
      await this.writeAtomic(statePath, json(next), { mode: 0o600 })
      return next
    })
  }

  /**
   * Whether {@link accept} would succeed for the CURRENT artifacts.
   *
   * Recovery discards the current work revision, so a caller that would destroy
   * a finished result uses this to tell an acceptable revision from one that is
   * still blocked and must be replanned. Schema and identity faults count as
   * unreachable rather than throwing: the only consumer is a safety check whose
   * answer for damaged artifacts is "not acceptable", and acceptance itself
   * still reports the precise failure.
   *
   * @param taskId - task to inspect; no state or artifact is modified.
   * @returns true only when every acceptance precondition already holds.
   */
  async acceptanceReachable(taskId: string): Promise<boolean> {
    try {
      const state = await this.readState(taskId)
      if (state.state !== 'REVIEWED' || state.writer !== null) return false
      const directory = this.taskDirectory(taskId)
      const plan = await this.readJson('plan', join(directory, ARTIFACT_FILES.plan)) as PlanRecord
      const verification = await this.readJson('verification', join(directory, ARTIFACT_FILES.verification)) as VerificationRecord
      const review = await this.readJson('review', join(directory, ARTIFACT_FILES.review)) as ReviewRecord
      this.assertAcceptance(state, plan, verification, review)
      this.assertResolvedPlanAssumptions(plan)
      return true
    } catch {
      return false
    }
  }

  /** Explicitly leave current work and require a new investigation and plan. */
  async replan(taskId: string, expectedRevision: number, confirmedStopped = false): Promise<TaskStateRecord> {
    return this.mutate(taskId, expectedRevision, current => transition(current, { type: 'replan', confirmedStopped }, this.now()))
  }

  /** Record a blocker after all owned model writers have stopped. */
  async block(taskId: string, expectedRevision: number, blocker: string): Promise<TaskStateRecord> {
    return this.mutate(taskId, expectedRevision, current => transition(current, { type: 'block', blocker }, this.now()))
  }

  /**
   * Append validated evidence for the current work revision without advancing state.
   * @param taskId - task receiving evidence.
   * @param expectedWorkRevision - work revision that produced the evidence.
 * @param inputs - evidence records without repository-owned identity fields.
   * @param expectedRevision - dispatch state revision required for command records.
   * @returns complete evidence records in append order.
   */
  async appendEvidence(taskId: string, expectedWorkRevision: number, inputs: object[], expectedRevision?: number): Promise<EvidenceDocument[]> {
    const directory = this.taskDirectory(taskId)
    const evidencePath = join(directory, 'EVIDENCE.jsonl')
    return withFileLock(join(directory, 'STATE.json'), () => withFileLock(evidencePath, async () => {
      const state = await this.readState(taskId)
      if (state.workRevision !== expectedWorkRevision) {
        throw new Error(`stale work revision: expected ${String(expectedWorkRevision)}, current ${String(state.workRevision)}`)
      }
      const records: EvidenceDocument[] = []
      for (const input of inputs) {
        if (Reflect.get(input, 'kind') === 'command') {
          const plan = await this.readBoundPlan(taskId)
          await this.assertBoundIdentity(taskId, plan)
          if (expectedRevision === undefined) throw new Error('command evidence requires its dispatch state revision')
          this.assertRevision(state, expectedRevision)
          if (state.state !== 'VERIFYING') throw new Error('command evidence requires VERIFYING state')
          const scope = Reflect.get(input, 'scope')
          if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) throw new Error('command evidence scope must be an object')
          if (!deepEqualJson(Reflect.get(scope, 'identity'), plan.binding.seal)) throw new Error('command evidence attempt identity changed; rerun commands')
        }
        const record = {
          ...input,
          schemaVersion: 1 as const,
          taskId,
          workRevision: expectedWorkRevision,
        }
        records.push(await this.schemas.validate('evidence', record) as EvidenceDocument)
      }
      const existing = await this.readOptional(evidencePath) ?? ''
      if (records.length === 0) return records
      await this.writeAtomic(evidencePath, `${existing}${records.map(item => JSON.stringify(item)).join('\n')}\n`, { mode: 0o600 })
      return records
    }))
  }

  private taskDirectory(taskId: string): string {
    return join(this.root, '.agent', 'tasks', taskId)
  }

  private async commandArguments(plan: BoundPlanDocument, context: RepositoryVerificationContext): Promise<RunnerContext> {
    return { projectRoot: resolve(this.root), baseRevision: plan.binding.baseline.head ?? '',
      changedFiles: sourceImpactPaths(plan.binding.baseline, await captureSourceInventory(this.root)), selectedTests: context.verificationConfig?.selectedTests ?? [] }
  }

  private planIntent(input: object): JsonValue {
    const owned = new Set(['schemaVersion', 'taskId', 'taskRevision', 'workRevision', 'binding', 'intentDigest'])
    const intent = Object.fromEntries(Object.entries(input).filter(([name]) => !owned.has(name)))
    if (!isJsonValue(intent)) throw new Error('plan intent must be lossless JSON data')
    return intent as JsonValue
  }

  private async readBoundPlan(taskId: string): Promise<BoundPlanDocument> {
    const plan = await this.readJson('plan', join(this.taskDirectory(taskId), 'PLAN.json')) as PlanRecord
    if (plan.schemaVersion !== 2) throw new Error('plan lacks source and policy identity; explicitly replan')
    const state = await this.readState(taskId)
    if (plan.taskId !== taskId || plan.workRevision !== state.workRevision) throw new Error('plan identity does not match current work revision')
    return plan
  }

  private async writeBoundPlan(taskId: string, plan: BoundPlanDocument): Promise<void> {
    await this.schemas.validate('plan', plan)
    await this.writeAtomic(join(this.taskDirectory(taskId), 'PLAN.json'), json(plan), { mode: 0o600 })
  }

  private async writeImmutableJson(filename: string, value: object): Promise<void> {
    if (!isJsonValue(value)) throw new Error('task authority must be lossless JSON')
    const existing = await this.readOptional(filename)
    if (existing !== undefined) {
      if (!deepEqualJson(JSON.parse(existing), value)) throw new Error('immutable task authority changed; explicitly replan')
      return
    }
    await this.writeAtomic(filename, json(value), { mode: 0o600 })
  }

  private async boundContext(taskId: string, plan: BoundPlanDocument): Promise<RepositoryVerificationContext> {
    const directory = this.taskDirectory(taskId)
    const authority = await this.readJson<BoundPlanDocument>('plan', join(directory, `FROZEN_PLAN.${String(plan.workRevision)}.json`))
    if (authority.schemaVersion !== 2 || authority.taskId !== taskId || authority.workRevision !== plan.workRevision
      || authority.intentDigest !== plan.intentDigest || identityDigest<'PlanIntentDigest'>(this.planIntent(plan)) !== authority.intentDigest) throw new Error('frozen plan intent changed; explicitly replan')
    if (!deepEqualJson(authority.binding.baseline, plan.binding.baseline) || authority.binding.verificationPolicyDigest !== plan.binding.verificationPolicyDigest
      || authority.binding.repositoryProfileDigest !== plan.binding.repositoryProfileDigest || !deepEqualJson(authority.binding.extras, plan.binding.extras)
      || !deepEqualJson(authority.binding.preset, plan.binding.preset)) throw new Error('frozen plan binding identity changed; explicitly replan')
    const state = await this.readState(taskId)
    if (plan.binding.attempt > state.revision) throw new Error('verification attempt authority changed; explicitly replan')
    let requirements = authority.binding.requirements
    let lastIdentity: VerificationIdentity | null = null
    let committedAttempt = 0
    const prefix = `ATTEMPT.${String(plan.workRevision)}.`
    const names = (await readdir(directory)).filter(name => name.startsWith(prefix) && /^\d+\.json$/u.test(name.slice(prefix.length)))
      .sort((first, second) => Number(first.slice(prefix.length, -5)) - Number(second.slice(prefix.length, -5)))
    for (const name of names) {
      const record = await this.readJson<BoundPlanDocument>('plan', join(directory, name))
      if (record.taskRevision > state.revision) continue
      const attempt = committedAttempt + 1
      if (record.schemaVersion !== 2 || record.taskId !== taskId || record.workRevision !== plan.workRevision || record.intentDigest !== authority.intentDigest
        || name !== `${prefix}${String(attempt)}.json` || record.binding.seal?.attempt !== attempt || record.binding.requirements.tier !== requirements.tier
        || requirements.instances.some(required => {
          const current = record.binding.requirements.instances.find(instance => instance.id === required.id)
          return current === undefined || !required.sources.every(source => current.sources.includes(source))
        })) throw new Error('committed verification attempt authority changed; explicitly replan')
      requirements = record.binding.requirements
      lastIdentity = record.binding.seal
      committedAttempt = attempt
    }
    if (plan.binding.attempt !== committedAttempt || !deepEqualJson(requirements, plan.binding.requirements)
      || (plan.binding.seal !== null && !deepEqualJson(lastIdentity, plan.binding.seal))) throw new Error('cumulative requirements or attempt identity changed; explicitly replan')
    if (!deepEqualJson(resolveVerificationExtras(plan.verificationExtras), plan.binding.extras)) throw new Error('frozen verification extras changed; explicitly replan')
    const baseline = JSON.parse(await readFile(join(this.taskDirectory(taskId), `SOURCE_BASELINE.${String(plan.workRevision)}.json`), 'utf8'))
    if (!deepEqualJson(baseline, plan.binding.baseline)) throw new Error('source baseline identity changed; explicitly replan')
    const receipt = JSON.parse(await readFile(join(this.taskDirectory(taskId), 'TASK_PRESET.json'), 'utf8'))
    if (receipt.schemaVersion !== 1 || !deepEqualJson(receipt.preset, plan.binding.preset)) throw new Error('task preset identity changed; explicitly replan')
    const task = await this.readTask(taskId)
    const context = await loadRepositoryVerificationContext(this.root, task.profile, plan.binding.extras, plan.binding.requirements.tier)
    if (context.verificationPolicyDigest !== plan.binding.verificationPolicyDigest || context.repositoryProfileDigest !== plan.binding.repositoryProfileDigest) {
      throw new Error('verification policy or repository profile identity changed; explicitly replan')
    }
    return context
  }

  private async assertBoundIdentity(taskId: string, plan: BoundPlanDocument): Promise<RepositoryVerificationContext> {
    const context = await this.boundContext(taskId, plan)
    const source = await captureSourceInventory(this.root)
    const requirements = resolveVerificationRequirements(context.gates, context.policy, sourceImpactPaths(plan.binding.baseline, source),
      plan.binding.extras, plan.binding.requirements.tier, plan.binding.requirements)
    const actual: VerificationIdentity = {
      attempt: plan.binding.attempt, sourceTreeDigest: source.sourceTreeDigest, verificationPolicyDigest: context.verificationPolicyDigest,
      repositoryProfileDigest: context.repositoryProfileDigest,
      requiredSetDigest: identityDigest<'RequiredSetDigest'>({ tier: requirements.tier, instances: requirements.instances.map(instance => ({ id: instance.id, sources: instance.sources })) }),
    }
    if (plan.binding.seal === null || !deepEqualJson(actual, plan.binding.seal)) throw new Error('source or required-set identity changed; seal and verify again')
    return context
  }

  private async writeArtifactTransition(
    taskId: string,
    expectedRevision: number,
    artifact: WritableArtifactName,
    input: object,
    action: TaskAction,
  ): Promise<TaskStateRecord> {
    const directory = this.taskDirectory(taskId)
    const statePath = join(directory, 'STATE.json')
    return withFileLock(statePath, async () => {
      const current = await this.readState(taskId)
      this.assertRevision(current, expectedRevision)
      const next = transition(current, action, this.now())
      const workRevision = artifact === 'plan' ? next.workRevision : current.workRevision
      let fields: object = {}
      if (artifact === 'plan') {
        const task = await this.readTask(taskId)
        const extras = resolveVerificationExtras(Reflect.get(input, 'verificationExtras'))
        const context = await loadRepositoryVerificationContext(this.root, task.profile, extras)
        const baseline = await captureSourceInventory(this.root)
        await this.writeAtomic(join(directory, `SOURCE_BASELINE.${String(workRevision)}.json`), json(baseline), { mode: 0o600 })
        const requirements = resolveVerificationRequirements(context.gates, context.policy, baseline.dirtyPaths, extras, context.tier)
        const receiptPath = join(directory, 'TASK_PRESET.json')
        if (await this.readOptional(receiptPath) === undefined) await this.writeAtomic(receiptPath, json({ schemaVersion: 1, preset: context.preset }), { mode: 0o600 })
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { schemaVersion: number; preset: PlanBinding['preset'] }
        if (receipt.schemaVersion !== 1) throw new Error('invalid task preset identity')
        fields = {
          intentDigest: identityDigest<'PlanIntentDigest'>(this.planIntent(input)),
          binding: { baseline, verificationPolicyDigest: context.verificationPolicyDigest, repositoryProfileDigest: context.repositoryProfileDigest,
            requirements, extras, preset: receipt.preset, attempt: 0, seal: null } satisfies PlanBinding,
        }
      } else if (artifact === 'verification' || artifact === 'review') {
        const plan = await this.readBoundPlan(taskId)
        await this.assertBoundIdentity(taskId, plan)
        if (artifact === 'verification' && !deepEqualJson(Reflect.get(input, 'identity'), plan.binding.seal)) throw new Error('verification result attempt identity changed; rerun commands')
        fields = { identity: plan.binding.seal }
      }
      const document = {
        ...input,
        ...fields,
        schemaVersion: artifact === 'verification' ? 3 : artifact === 'plan' || artifact === 'review' ? 2 : 1,
        taskId,
        taskRevision: next.revision,
        ...artifact === 'plan' || artifact === 'verification' || artifact === 'review' ? { workRevision } : {},
      }
      await this.schemas.validate(artifact, document)
      await this.schemas.validate('state', next)
      if (artifact === 'plan') await this.writeImmutableJson(join(directory, `FROZEN_PLAN.${String(workRevision)}.json`), document)
      await this.writeAtomic(join(directory, ARTIFACT_FILES[artifact]), json(document), { mode: 0o600 })
      await this.writeAtomic(statePath, json(next), { mode: 0o600 })
      return next
    })
  }

  private async mutate(
    taskId: string,
    expectedRevision: number,
    change: (current: TaskStateRecord) => TaskStateRecord,
  ): Promise<TaskStateRecord> {
    const statePath = join(this.taskDirectory(taskId), 'STATE.json')
    return withFileLock(statePath, async () => {
      const current = await this.readState(taskId)
      this.assertRevision(current, expectedRevision)
      const next = change(current)
      await this.schemas.validate('state', next)
      await this.writeAtomic(statePath, json(next), { mode: 0o600 })
      return next
    })
  }

  private assertRevision(current: TaskStateRecord, expected: number): void {
    if (current.revision !== expected) throw new StaleRevisionError(expected, current.revision)
  }

  private assertAcceptance(
    state: TaskStateRecord,
    plan: PlanRecord,
    verification: VerificationRecord,
    review: ReviewRecord,
  ): void {
    if (state.state !== 'REVIEWED') throw new Error(`acceptance requires REVIEWED state, found ${state.state}`)
    if (state.writer !== null) throw new Error('acceptance requires no active writer lease')
    if (plan.taskId !== state.taskId || verification.taskId !== state.taskId || review.taskId !== state.taskId) {
      throw new Error('acceptance artifacts do not match the current task')
    }
    if (plan.workRevision !== state.workRevision
      || verification.workRevision !== state.workRevision
      || review.workRevision !== state.workRevision) {
      throw new Error('acceptance artifacts do not match the current work revision')
    }
    if (verification.status !== 'PASS'
      || verification.checks.some(check => check.required && check.status !== 'PASS')) {
      throw new Error('acceptance requires every required verification check to pass')
    }
    if (review.decision !== 'ACCEPT') throw new Error(`acceptance requires an ACCEPT review, found ${review.decision}`)
  }

  private assertResolvedPlanAssumptions(plan: PlanRecord): void {
    const blocking = plan.unresolvedAssumptions.filter(assumption => assumption.acceptanceBlocking)
    if (blocking.length > 0) throw new PlanAssumptionBlocker(blocking.map(assumption => assumption.statement))
  }

  private statusOf(input: object): CheckStatus {
    const value = Reflect.get(input, 'status')
    if (value === 'PASS' || value === 'FAIL' || value === 'NOT_RUN' || value === 'INCOMPLETE') return value
    throw new Error('verification input needs status PASS, FAIL, NOT_RUN, or INCOMPLETE')
  }

  private reviewDecisionOf(input: object): ReviewRecord['decision'] {
    const value = Reflect.get(input, 'decision')
    if (value === 'ACCEPT' || value === 'FIX_BOUNDED' || value === 'REPLAN' || value === 'BLOCKED') return value
    throw new Error('review input needs decision ACCEPT, FIX_BOUNDED, REPLAN, or BLOCKED')
  }

  private optionalString(input: object, key: string): string | undefined {
    const value = Reflect.get(input, key)
    return typeof value === 'string' ? value : undefined
  }

  private async readJson<T>(schema: ArtifactSchemaName | ReviewArtifactSchemaName, filename: string): Promise<T> {
    const value = JSON.parse(await readFile(filename, 'utf8'))
    return this.schemas.validate(schema, value) as Promise<T>
  }

  private async readOptional(filename: string): Promise<string | undefined> {
    try {
      return await readFile(filename, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private reviewDirectory(taskId: string): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(taskId)) throw new Error('invalid review task ID')
    return join(this.root, '.agent', 'reviews', taskId)
  }

  private async mutateReview(taskId: string, expectedRevision: number, change: (current: ReviewStateRecord) => ReviewStateRecord): Promise<ReviewStateRecord> {
    const statePath = join(this.reviewDirectory(taskId), 'STATE.json')
    return withFileLock(statePath, async () => {
      const current = await this.readReviewState(taskId)
      if (current.revision !== expectedRevision) throw new StaleRevisionError(expectedRevision, current.revision)
      const next = change(current)
      await this.schemas.validate('review-state', next)
      await this.writeAtomic(statePath, json(next), { mode: 0o600 })
      return next
    })
  }
}
