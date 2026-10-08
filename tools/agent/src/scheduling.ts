/** Deterministic task classification and crash-safe capability reservations. */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { load as loadYaml } from 'js-yaml'
import { BudgetExhaustedError } from './lifecycle.ts'

/** Engineering effort selected from auditable task facts. */
export type TaskClass = 'simple' | 'standard' | 'complex'
/** Opaque identity of one persisted capability escalation reservation. */
export type SchedulingEscalationId = Branded<'SchedulingEscalationId'>
/** Deployment thresholds used by the pure task classifier. */
export interface SchedulingLimits { simpleMaxFiles: number; standardMaxFiles: number }
/** Task-local policy facts supplied by the deployment. */
export interface SchedulingPolicy {
  class?: 'auto' | TaskClass | undefined
  scopePaths?: string[] | undefined
  acceptanceCriteria?: string[] | undefined
  risks?: string[] | undefined
  needsInvestigation?: boolean | undefined
  needsChallenge?: boolean | undefined
}
/** Inputs that determine one reproducible classification. */
export interface TaskClassificationInput {
  request: string
  profile: string
  policy?: SchedulingPolicy | undefined
  baselineDirty: boolean
  previous?: TaskClassification | undefined
}
/** Persistable result of the deterministic classifier. */
export interface TaskClassification {
  taskClass: TaskClass
  reasons: string[]
  risks: string[]
  inputDigest: string
  scopePaths: string[]
  needsInvestigation: boolean
  needsChallenge: boolean
}

export interface EscalationReservationInput {
  failureKey: string
  recoveryEpoch: number
  role: string
  reason: 'EVIDENCE_INSUFFICIENT' | 'TASK_COMPLEXITY' | 'REPAIR_FAILED' | 'DESIGN_ERROR'
  sourceFingerprint: string
  dispatchInput?: EscalationDispatchInput
}
/** Bounded failed-route context needed to replay a reserved escalation. */
export interface EscalationDispatchInput {
  failedRouteId: string
  partial: { observations: string[]; unresolvedQuestions: string[] }
  inputDigest: string
}
export interface SchedulingEscalation extends EscalationReservationInput {
  id: SchedulingEscalationId
  reservedAt: string
  status: 'RESERVED' | 'DISPATCHING' | 'COMPLETE' | 'FAILED' | 'UNCERTAIN'
  attemptId?: string
  output?: Record<string, unknown>
  completedAt?: string
  failure?: string
}
export interface DiagnosisObligationInput {
  failureKey: string
  writerRevision: number
  planDigest: string
  sourceFingerprint: string
}
export interface DiagnosisOutput {
  summary: string
  observations: string[]
  recommendation: 'REPAIR_WITHIN_PLAN' | 'REPLAN'
  repairConstraints: string[]
  unresolvedQuestions: string[]
}
export interface DiagnosisObligation extends DiagnosisObligationInput {
  createdAt: string
  status: 'PENDING' | 'COMPLETE' | 'APPLIED'
  output?: DiagnosisOutput
  outputSourceFingerprint?: string
  completedAt?: string
  appliedStateRevision?: number
  appliedAt?: string
}
export interface DiagnosisApplication {
  schemaVersion: 1
  taskId: string
  workflow: 'development' | 'review-only'
  failureKey: string
  stateRevision: number
  planDigest: string
  recommendation: 'REPAIR_WITHIN_PLAN' | 'REPLAN'
  repairConstraints: string[]
  appliedAt: string
}
/** Validated durable task-scheduling state. */
export interface SchedulingRecord {
  schemaVersion: 1
  taskId: string
  workflow: 'development' | 'review-only'
  history: 'KNOWN' | 'UNKNOWN'
  recoveryEpoch: number
  taskClassFloor: TaskClass
  classifications: TaskClassification[]
  escalations: SchedulingEscalation[]
  diagnoses: DiagnosisObligation[]
}
/** Options shared by scheduling-store facades for one deployment. */
export interface TaskSchedulingOptions { maxEscalations: number; now?: () => string }

/** Durable evidence that a known-new scheduling ledger was initialized. */
export const SCHEDULING_MARKER_FILE = 'SCHEDULING.MARKER.json'

const CLASS_RANK: Readonly<Record<TaskClass, number>> = { simple: 0, standard: 1, complex: 2 }
const KNOWN_RISKS = new Set(['concurrency', 'lifecycle', 'security', 'runtime', 'compiler-ir', 'cross-module'])
const ESCALATION_REASONS = new Set(['EVIDENCE_INSUFFICIENT', 'TASK_COMPLEXITY', 'REPAIR_FAILED', 'DESIGN_ERROR'])
const APPLICATION_PREFIX = 'DIAGNOSIS-APPLICATION.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isClass(value: unknown): value is TaskClass {
  return value === 'simple' || value === 'standard' || value === 'complex'
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 fingerprint`)
  return value
}

function sortedUnique(values: readonly string[]): string[] { return [...new Set(values)].sort() }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function digest(value: unknown): string { return createHash('sha256').update(stableJson(value)).digest('hex') }

function validateLimits(limits: SchedulingLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`scheduling limit ${name} must be a non-negative integer`)
  }
  if (limits.standardMaxFiles < limits.simpleMaxFiles) throw new Error('standardMaxFiles must be at least simpleMaxFiles')
}

function validatePolicy(policy: SchedulingPolicy | undefined): void {
  if (policy === undefined) return
  if (policy.class !== undefined && !['auto', 'simple', 'standard', 'complex'].includes(policy.class)) throw new Error('invalid scheduling class policy')
  if (policy.scopePaths !== undefined && !isStrings(policy.scopePaths)) throw new Error('scheduling scopePaths must be strings')
  if (policy.acceptanceCriteria !== undefined && !isStrings(policy.acceptanceCriteria)) throw new Error('acceptanceCriteria must be strings')
  if (policy.risks !== undefined) {
    if (!isStrings(policy.risks) || policy.risks.some(risk => !KNOWN_RISKS.has(risk))) throw new Error('scheduling risks contain an unknown value')
  }
  if (policy.needsInvestigation !== undefined && typeof policy.needsInvestigation !== 'boolean') throw new Error('needsInvestigation must be boolean')
  if (policy.needsChallenge !== undefined && typeof policy.needsChallenge !== 'boolean') throw new Error('needsChallenge must be boolean')
}

function validLeaf(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.endsWith('/')
    || path.split('/').some(part => part === '' || part === '.' || part === '..' || part === '.git' || part === '.agent')
    || /[*?{}\[\]]/.test(path)) return false
  const leaf = path.split('/').at(-1) ?? ''
  return leaf.includes('.') && leaf !== '.' && leaf !== '..'
}

/** Classify from explicit request, risk and scope facts without reading repository files. */
export function classifyEngineeringTask(input: TaskClassificationInput, limits: SchedulingLimits): TaskClassification {
  validateLimits(limits)
  validatePolicy(input.policy)
  if (!nonempty(input.request) || !nonempty(input.profile) || typeof input.baselineDirty !== 'boolean') throw new Error('classification requires request, profile and baseline facts')
  const policy = input.policy
  const rawScope = policy?.scopePaths ?? []
  const scopePaths = sortedUnique(rawScope.map(path => path.trim()))
  const scopeResolved = scopePaths.length > 0 && scopePaths.every(validLeaf)
  const criteriaPresent = (policy?.acceptanceCriteria ?? []).some(value => value.trim().length > 0)
  const text = `${input.request}\n${input.profile}\n${scopePaths.join('\n')}`.toLowerCase()
  const risks = new Set((policy?.risks ?? []))
  const markers: Array<[string, RegExp]> = [
    ['concurrency', /\b(concurren\w*|parallel\w*|race\w*|deadlock\w*|cancel\w*|writer lease)\b|并发|并行|竞态|死锁|取消/u],
    ['lifecycle', /\b(lifecycle|recovery|recover|resume|state machine|teardown|checkpoint)\b|生命周期|恢复|重启|状态机|清理/u],
    ['security', /\b(security|permission|sandbox|credential|authorization|isolation)\b|安全|权限|沙箱|凭证|授权|隔离/u],
    ['runtime', /\b(runtime|dispatch|provider|process|subprocess|tool execution)\b|运行时|调度|进程|工具执行/u],
    ['compiler-ir', /\b(compiler|mlir|llvm|dialect|lowering|compiler ir)\b|\bir\b|编译器|中间表示|方言|降低/u],
    ['cross-module', /\b(cross[- ]module|multi[- ]package|package boundary|multiple modules)\b|跨模块|跨包|多个模块/u],
  ]
  for (const [risk, pattern] of markers) if (pattern.test(text)) risks.add(risk)
  if (/compiler|ascend|tilelang|bisheng|mlir/i.test(input.profile) || scopePaths.some(path => /\.(mlir|ll|bc|ir)$/i.test(path))) risks.add('compiler-ir')
  const riskList = sortedUnique([...risks])
  const unsafeScope = !scopeResolved || input.baselineDirty
  const highRisk = riskList.length > 0
  const previous = input.previous
  if (previous !== undefined && (!isClass(previous.taskClass) || !/^[a-f0-9]{64}$/.test(previous.inputDigest))) throw new Error('previous task classification is invalid')
  let taskClass: TaskClass
  const reasons: string[] = []
  if (unsafeScope) {
    taskClass = 'complex'
    reasons.push(input.baselineDirty ? 'dirty-baseline' : 'scope-not-explicit-file-leaves')
  } else if (highRisk || policy?.class === 'complex') {
    taskClass = 'complex'
    if (highRisk) reasons.push(...riskList.map(risk => `high-risk:${risk}`))
    if (policy?.class === 'complex') reasons.push('policy-class:complex')
  } else if (scopePaths.length > limits.standardMaxFiles) {
    taskClass = 'complex'
    reasons.push('scope-exceeds-standard-file-limit')
  } else if (policy?.needsInvestigation === true || policy?.needsChallenge === true) {
    taskClass = 'standard'
    reasons.push('explicit-additional-stage')
  } else if (policy?.class === 'standard') {
    taskClass = 'standard'
    reasons.push('policy-class:standard')
  } else if (!criteriaPresent) {
    taskClass = 'standard'
    reasons.push('acceptance-criteria-incomplete')
  } else if ((policy?.class === 'simple' || policy?.class === 'auto' || policy?.class === undefined) && scopePaths.length <= limits.simpleMaxFiles) {
    taskClass = 'simple'
    reasons.push(policy?.class === 'simple' ? 'policy-class:simple' : 'bounded-low-risk-scope')
  } else {
    taskClass = 'standard'
    reasons.push('scope-exceeds-simple-file-limit')
  }
  let effectiveScope = scopePaths
  let needsInvestigation = policy?.needsInvestigation ?? (taskClass === 'complex')
  let needsChallenge = policy?.needsChallenge ?? (taskClass === 'complex')
  if (previous !== undefined) {
    if (CLASS_RANK[previous.taskClass] > CLASS_RANK[taskClass]) {
      taskClass = previous.taskClass
      reasons.push(`prior-class-floor:${previous.taskClass}`)
    }
    for (const risk of previous.risks) risks.add(risk)
    effectiveScope = sortedUnique([...scopePaths, ...previous.scopePaths])
    needsInvestigation ||= previous.needsInvestigation
    needsChallenge ||= previous.needsChallenge
    if (previous.risks.some(risk => !riskList.includes(risk))) reasons.push('prior-risk-floor')
  }
  if (effectiveScope.length > limits.standardMaxFiles) {
    taskClass = 'complex'
    reasons.push('cumulative-scope-exceeds-standard-file-limit')
  } else if (effectiveScope.length > limits.simpleMaxFiles && taskClass === 'simple') {
    taskClass = 'standard'
    reasons.push('cumulative-scope-exceeds-simple-file-limit')
  }
  const effectiveRisks = sortedUnique([...risks])
  if (effectiveRisks.length > 0) taskClass = 'complex'
  if (taskClass === 'complex') {
    needsInvestigation = true
    const explicitLowRisk = policy?.class === 'complex' && scopeResolved && criteriaPresent && !input.baselineDirty && effectiveRisks.length === 0
    needsChallenge ||= !explicitLowRisk || policy?.needsChallenge !== false
  }
  const facts = {
    request: input.request, profile: input.profile, policy: policy ?? null, baselineDirty: input.baselineDirty,
    previous: previous ?? null, limits,
  }
  return {
    taskClass, reasons: sortedUnique(reasons), risks: effectiveRisks, inputDigest: digest(facts), scopePaths: effectiveScope,
    needsInvestigation, needsChallenge,
  }
}

function validClassification(value: unknown): value is TaskClassification {
  return isRecord(value) && isClass(value.taskClass) && isStrings(value.reasons) && isStrings(value.risks)
    && value.risks.every(risk => KNOWN_RISKS.has(risk)) && /^[a-f0-9]{64}$/.test(String(value.inputDigest))
    && isStrings(value.scopePaths) && (value.taskClass !== 'simple' || value.scopePaths.length > 0 && value.scopePaths.every(validLeaf))
    && typeof value.needsInvestigation === 'boolean' && typeof value.needsChallenge === 'boolean'
}

function validDiagnosisOutput(value: unknown): value is DiagnosisOutput {
  return isRecord(value) && nonempty(value.summary) && isStrings(value.observations)
    && (value.recommendation === 'REPAIR_WITHIN_PLAN' || value.recommendation === 'REPLAN')
    && isStrings(value.repairConstraints) && isStrings(value.unresolvedQuestions)
}

function validateOptions(options: TaskSchedulingOptions): void {
  if (!Number.isSafeInteger(options.maxEscalations) || options.maxEscalations < 0) throw new Error('maxEscalations must be a non-negative integer')
}

function validId(value: unknown): value is string { return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(value) }

function validateRecord(value: unknown, taskId: string, workflow: 'development' | 'review-only'): SchedulingRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.taskId !== taskId || value.workflow !== workflow
    || (value.history !== 'KNOWN' && value.history !== 'UNKNOWN') || !Number.isSafeInteger(value.recoveryEpoch) || (value.recoveryEpoch as number) < 0
    || !isClass(value.taskClassFloor) || !Array.isArray(value.classifications) || !value.classifications.every(validClassification)
    || !Array.isArray(value.escalations) || !Array.isArray(value.diagnoses)) throw new Error(`scheduling ledger identity or fields are invalid for task ${taskId}`)
  const escalations: SchedulingEscalation[] = value.escalations.map(raw => {
    if (!isRecord(raw) || !nonempty(raw.id) || !nonempty(raw.failureKey) || !Number.isSafeInteger(raw.recoveryEpoch) || (raw.recoveryEpoch as number) < 0
      || !nonempty(raw.role) || !ESCALATION_REASONS.has(String(raw.reason)) || !/^[a-f0-9]{64}$/.test(String(raw.sourceFingerprint))
      || raw.dispatchInput !== undefined && !validDispatchInput(raw.dispatchInput)
      || typeof raw.reservedAt !== 'string' || !Number.isFinite(Date.parse(raw.reservedAt))
      || !['RESERVED', 'DISPATCHING', 'COMPLETE', 'FAILED', 'UNCERTAIN'].includes(String(raw.status))
      || (raw.attemptId !== undefined && !nonempty(raw.attemptId)) || (raw.output !== undefined && !isRecord(raw.output))
      || (raw.completedAt !== undefined && (typeof raw.completedAt !== 'string' || !Number.isFinite(Date.parse(raw.completedAt))))
      || (raw.failure !== undefined && typeof raw.failure !== 'string')) throw new Error('scheduling escalation entry is invalid')
    return {
      id: brandString<SchedulingEscalationId>(raw.id), failureKey: raw.failureKey, recoveryEpoch: raw.recoveryEpoch as number,
      role: raw.role, reason: raw.reason as EscalationReservationInput['reason'], sourceFingerprint: raw.sourceFingerprint as string,
      ...(raw.dispatchInput === undefined ? {} : { dispatchInput: raw.dispatchInput }),
      reservedAt: raw.reservedAt, status: raw.status as SchedulingEscalation['status'],
      ...(raw.attemptId === undefined ? {} : { attemptId: raw.attemptId as string }),
      ...(raw.output === undefined ? {} : { output: raw.output }),
      ...(raw.completedAt === undefined ? {} : { completedAt: raw.completedAt as string }),
      ...(raw.failure === undefined ? {} : { failure: raw.failure as string }),
    }
  })
  const diagnoses: DiagnosisObligation[] = value.diagnoses.map(raw => {
    if (!isRecord(raw) || !nonempty(raw.failureKey) || !Number.isSafeInteger(raw.writerRevision) || (raw.writerRevision as number) < 0
      || !/^[a-f0-9]{64}$/.test(String(raw.planDigest)) || !/^[a-f0-9]{64}$/.test(String(raw.sourceFingerprint))
      || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))
      || !['PENDING', 'COMPLETE', 'APPLIED'].includes(String(raw.status))
      || (raw.output !== undefined && !validDiagnosisOutput(raw.output))
      || (raw.outputSourceFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(String(raw.outputSourceFingerprint)))
      || (raw.completedAt !== undefined && (typeof raw.completedAt !== 'string' || !Number.isFinite(Date.parse(raw.completedAt))))
      || (raw.appliedStateRevision !== undefined && (!Number.isSafeInteger(raw.appliedStateRevision) || (raw.appliedStateRevision as number) < 0))
      || (raw.appliedAt !== undefined && (typeof raw.appliedAt !== 'string' || !Number.isFinite(Date.parse(raw.appliedAt))))) throw new Error('scheduling diagnosis entry is invalid')
    return {
      failureKey: raw.failureKey, writerRevision: raw.writerRevision as number, planDigest: raw.planDigest as string,
      sourceFingerprint: raw.sourceFingerprint as string, createdAt: raw.createdAt, status: raw.status as DiagnosisObligation['status'],
      ...(raw.output === undefined ? {} : { output: raw.output }),
      ...(raw.outputSourceFingerprint === undefined ? {} : { outputSourceFingerprint: raw.outputSourceFingerprint as string }),
      ...(raw.completedAt === undefined ? {} : { completedAt: raw.completedAt as string }),
      ...(raw.appliedStateRevision === undefined ? {} : { appliedStateRevision: raw.appliedStateRevision as number }),
      ...(raw.appliedAt === undefined ? {} : { appliedAt: raw.appliedAt as string }),
    }
  })
  const escalationIds = new Set(escalations.map(entry => entry.id))
  if (escalationIds.size !== escalations.length) throw new Error('scheduling escalation IDs are duplicated')
  const diagnosisKeys = new Set(diagnoses.map(entry => entry.failureKey))
  if (diagnosisKeys.size !== diagnoses.length) throw new Error('scheduling diagnosis keys are duplicated')
  return {
    schemaVersion: 1, taskId, workflow, history: value.history, recoveryEpoch: value.recoveryEpoch as number,
    taskClassFloor: value.taskClassFloor, classifications: value.classifications,
    escalations, diagnoses,
  }
}

function newRecord(taskId: string, workflow: 'development' | 'review-only', history: SchedulingRecord['history']): SchedulingRecord {
  return {
    schemaVersion: 1, taskId, workflow, history, recoveryEpoch: 0,
    taskClassFloor: history === 'KNOWN' ? 'simple' : 'complex', classifications: [], escalations: [], diagnoses: [],
  }
}

function sameEscalation(left: EscalationReservationInput, right: SchedulingEscalation): boolean {
  return left.failureKey === right.failureKey && left.recoveryEpoch === right.recoveryEpoch && left.role === right.role
    && left.reason === right.reason && left.sourceFingerprint === right.sourceFingerprint
    && stableJson(left.dispatchInput ?? null) === stableJson(right.dispatchInput ?? null)
}

function validDispatchInput(value: unknown): value is EscalationDispatchInput {
  if (!isRecord(value) || !nonempty(value.failedRouteId) || value.failedRouteId.length > 256
    || !/^[a-f0-9]{64}$/.test(String(value.inputDigest)) || !isRecord(value.partial)
    || !isStrings(value.partial.observations) || !isStrings(value.partial.unresolvedQuestions)) return false
  const strings = [...value.partial.observations, ...value.partial.unresolvedQuestions]
  return strings.length <= 32 && strings.every(item => item.length <= 4000)
    && Buffer.byteLength(stableJson(value), 'utf8') <= 32_768
}

function validateEscalationInput(input: EscalationReservationInput): void {
  if (!nonempty(input.failureKey) || !Number.isSafeInteger(input.recoveryEpoch) || input.recoveryEpoch < 0 || !nonempty(input.role)
    || !ESCALATION_REASONS.has(input.reason)) throw new Error('invalid scheduling escalation reservation')
  fingerprint(input.sourceFingerprint, 'sourceFingerprint')
  if (input.dispatchInput !== undefined && !validDispatchInput(input.dispatchInput)) throw new Error('invalid bounded escalation dispatch input')
}

function validateDiagnosisInput(input: DiagnosisObligationInput): void {
  if (!nonempty(input.failureKey) || !Number.isSafeInteger(input.writerRevision) || input.writerRevision < 0) throw new Error('invalid diagnosis obligation')
  fingerprint(input.planDigest, 'planDigest')
  fingerprint(input.sourceFingerprint, 'sourceFingerprint')
}

function diagnosisApplicationPath(root: string, taskId: string, workflow: 'development' | 'review-only', failureKey: string): string {
  const suffix = createHash('sha256').update(failureKey).digest('hex')
  return join(root, '.agent', workflow === 'development' ? 'tasks' : 'reviews', taskId, `${APPLICATION_PREFIX}${suffix}.json`)
}

/** Serialized, atomic scheduling state for one task and workflow. */
export class TaskSchedulingRepository {
  private readonly path: string
  private readonly markerPath: string
  private readonly now: () => string

  /** Create a scheduling repository facade.
   * @param root - repository root containing `.agent`.
   * @param taskId - task identity.
   * @param workflow - independent development or review namespace.
   * @param options - cumulative escalation limit and optional deterministic clock.
   */
  constructor(private readonly root: string, private readonly taskId: string, private readonly workflow: 'development' | 'review-only', private readonly options: TaskSchedulingOptions) {
    if (!validId(taskId)) throw new Error('invalid scheduling task ID')
    validateOptions(options)
    this.path = join(root, '.agent', workflow === 'development' ? 'tasks' : 'reviews', taskId, 'SCHEDULING.json')
    this.markerPath = join(dirname(this.path), SCHEDULING_MARKER_FILE)
    this.now = options.now ?? (() => new Date().toISOString())
  }

  /** Initialize known-empty scheduling state only for a newly created task. */
  async initializeNew(): Promise<SchedulingRecord> {
    return withFileLock(this.path, async () => {
      if (await this.readOptional(this.path) !== undefined) throw new Error('scheduling ledger already exists')
      if (await this.readOptional(this.markerPath) !== undefined) throw new Error('scheduling initialization marker already exists without its ledger')
      await this.assertNewTask()
      const record = newRecord(this.taskId, this.workflow, 'KNOWN')
      const marker = { schemaVersion: 1, taskId: this.taskId, workflow: this.workflow, initializedAt: this.timestamp() }
      await writeFileAtomic(this.markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
      await this.write(record)
      return record
    })
  }

  /** Read the ledger, retaining explicit uncertainty when a legacy task has no ledger. */
  async read(): Promise<SchedulingRecord> {
    return withFileLock(this.path, async () => {
      await this.assertTaskIdentity()
      return this.load()
    })
  }

  /** Persist a classification while retaining the task's highest class, risk and scope facts. */
  async recordClassification(classification: TaskClassification): Promise<TaskClassification> {
    if (!validClassification(classification)) throw new Error('invalid scheduling classification')
    return this.mutate(record => {
      const prior = record.classifications.at(-1)
      const previousClass = CLASS_RANK[record.taskClassFloor] >= (prior === undefined ? 0 : CLASS_RANK[prior.taskClass]) ? record.taskClassFloor : prior!.taskClass
      const risks = sortedUnique([...(prior?.risks ?? []), ...classification.risks])
      const taskClass = record.history === 'UNKNOWN' || CLASS_RANK[previousClass] > CLASS_RANK[classification.taskClass] || risks.length > 0
        ? 'complex' === previousClass || risks.length > 0 || record.history === 'UNKNOWN' ? 'complex' : previousClass
        : classification.taskClass
      const effective: TaskClassification = {
        ...classification, taskClass, risks,
        reasons: sortedUnique([...classification.reasons, ...record.history === 'UNKNOWN' ? ['legacy-history-unknown'] : [], ...CLASS_RANK[taskClass] > CLASS_RANK[classification.taskClass] ? [`task-class-floor:${taskClass}`] : []]),
        scopePaths: sortedUnique([...(prior?.scopePaths ?? []), ...classification.scopePaths]),
        needsInvestigation: classification.needsInvestigation || prior?.needsInvestigation === true || record.history === 'UNKNOWN',
        needsChallenge: classification.needsChallenge || prior?.needsChallenge === true || risks.length > 0 || record.history === 'UNKNOWN',
      }
      const existingIndex = record.classifications.findIndex(item => item.inputDigest === classification.inputDigest)
      if (existingIndex !== -1) {
        const existing = record.classifications[existingIndex]!
        const mergedClass = CLASS_RANK[existing.taskClass] > CLASS_RANK[effective.taskClass] ? existing.taskClass : effective.taskClass
        const merged: TaskClassification = {
          ...effective,
          taskClass: mergedClass,
          risks: sortedUnique([...existing.risks, ...effective.risks]),
          reasons: sortedUnique([...existing.reasons, ...effective.reasons,
            ...(CLASS_RANK[mergedClass] > CLASS_RANK[classification.taskClass] ? [`task-class-floor:${mergedClass}`] : [])]),
          scopePaths: sortedUnique([...existing.scopePaths, ...effective.scopePaths]),
          needsInvestigation: existing.needsInvestigation || effective.needsInvestigation,
          needsChallenge: existing.needsChallenge || effective.needsChallenge || risks.length > 0 || record.history === 'UNKNOWN',
        }
        record.classifications[existingIndex] = merged
        if (CLASS_RANK[mergedClass] > CLASS_RANK[record.taskClassFloor]) record.taskClassFloor = mergedClass
        return merged
      }
      record.taskClassFloor = CLASS_RANK[taskClass] > CLASS_RANK[record.taskClassFloor] ? taskClass : record.taskClassFloor
      record.classifications.push(effective)
      return effective
    }, true)
  }

  /** Reserve one bounded escalation; replaying the same key in one epoch returns its charge. */
  async reserveEscalation(input: EscalationReservationInput): Promise<SchedulingEscalation> {
    validateEscalationInput(input)
    return this.mutate(record => {
      if (record.history !== 'KNOWN') throw new Error('scheduling history is unknown; escalation admission is fail-closed')
      if (input.recoveryEpoch !== record.recoveryEpoch) throw new Error(`stale escalation recovery epoch ${String(input.recoveryEpoch)}`)
      const existing = record.escalations.find(entry => entry.failureKey === input.failureKey && entry.recoveryEpoch === input.recoveryEpoch)
      if (existing !== undefined) {
        if (!sameEscalation(input, existing)) throw new Error('escalation failure identity conflicts with its durable reservation')
        if (existing.status === 'FAILED' || existing.status === 'UNCERTAIN') throw new Error(`escalation reservation is ${existing.status.toLowerCase()}; recover before retry`)
        return existing
      }
      if (record.escalations.length >= this.options.maxEscalations) throw new BudgetExhaustedError('task capability escalation budget exhausted')
      const entry: SchedulingEscalation = { ...input, id: brandString<SchedulingEscalationId>(randomUUID()), reservedAt: this.timestamp(), status: 'RESERVED' }
      record.escalations.push(entry)
      return entry
    })
  }

  /** Atomically bind a reserved escalation to one physical model attempt. */
  async beginDispatch(id: SchedulingEscalationId, attemptId: string): Promise<SchedulingEscalation> {
    if (!nonempty(attemptId)) throw new Error('escalation attempt ID must be non-empty')
    return this.mutate(record => {
      if (record.history !== 'KNOWN') throw new Error('scheduling history is unknown; dispatch admission is fail-closed')
      const entry = this.escalation(record, id)
      if (entry.status !== 'RESERVED') throw new Error(`cannot dispatch escalation in ${entry.status} state`)
      entry.status = 'DISPATCHING'
      entry.attemptId = attemptId
      return entry
    })
  }

  /** Persist a completed escalation only when its source fingerprint is unchanged. */
  async completeEscalation(id: SchedulingEscalationId, output: Record<string, unknown>, sourceFingerprint: string): Promise<SchedulingEscalation> {
    fingerprint(sourceFingerprint, 'sourceFingerprint')
    if (!isRecord(output)) throw new Error('escalation output must be an object')
    return this.mutate(record => {
      const entry = this.escalation(record, id)
      if (entry.sourceFingerprint !== sourceFingerprint) throw new Error('escalation source fingerprint mismatch')
      if (entry.status === 'COMPLETE') {
        if (stableJson(entry.output) !== stableJson(output)) throw new Error('completed escalation output conflicts with durable result')
        return entry
      }
      if (entry.status !== 'DISPATCHING') throw new Error(`cannot complete escalation in ${entry.status} state`)
      entry.status = 'COMPLETE'
      entry.output = output
      entry.completedAt = this.timestamp()
      return entry
    })
  }

  /** End one escalation as failed or uncertain without releasing its cumulative charge. */
  async failEscalation(id: SchedulingEscalationId, uncertain: boolean): Promise<SchedulingEscalation> {
    return this.mutate(record => {
      const entry = this.escalation(record, id)
      if (entry.status === 'FAILED' && !uncertain || entry.status === 'UNCERTAIN' && uncertain) return entry
      if (entry.status !== 'DISPATCHING' && entry.status !== 'RESERVED') throw new Error(`cannot fail escalation in ${entry.status} state`)
      entry.status = uncertain ? 'UNCERTAIN' : 'FAILED'
      entry.failure = uncertain ? 'dispatch stop is unconfirmed' : 'escalation attempt failed'
      return entry
    })
  }

  /** Advance the durable retry epoch; uncertain attempts require explicit stop confirmation. */
  async recover(options: { confirmedStopped: boolean }): Promise<SchedulingRecord> {
    return this.mutate(record => {
      const inFlight = record.escalations.filter(entry => entry.status === 'DISPATCHING' || entry.status === 'UNCERTAIN')
      if (inFlight.length > 0 && options.confirmedStopped !== true) throw new Error('scheduling recovery requires confirmation that uncertain dispatches stopped')
      for (const entry of inFlight) {
        entry.status = 'FAILED'
        entry.failure = 'stopped by explicit recovery'
      }
      record.recoveryEpoch += 1
      return record
    })
  }

  /** Persist a diagnosis obligation before the failed writer lease is released. */
  async recordDiagnosisObligation(input: DiagnosisObligationInput): Promise<DiagnosisObligation> {
    validateDiagnosisInput(input)
    return this.mutate(record => {
      const existing = record.diagnoses.find(entry => entry.failureKey === input.failureKey)
      if (existing !== undefined) {
        if (existing.writerRevision !== input.writerRevision || existing.planDigest !== input.planDigest || existing.sourceFingerprint !== input.sourceFingerprint) throw new Error('diagnosis failure identity conflicts with its durable obligation')
        return existing
      }
      const active = record.diagnoses.find(entry => entry.status !== 'APPLIED')
      if (active !== undefined) throw new Error(`diagnosis ${active.failureKey} remains unapplied`)
      const entry: DiagnosisObligation = { ...input, createdAt: this.timestamp(), status: 'PENDING' }
      record.diagnoses.push(entry)
      return entry
    }, true)
  }

  /** Persist a diagnosis result only for the unchanged worktree captured by its obligation. */
  async completeDiagnosis(failureKey: string, output: DiagnosisOutput, sourceFingerprint: string): Promise<DiagnosisObligation> {
    fingerprint(sourceFingerprint, 'sourceFingerprint')
    if (!validDiagnosisOutput(output)) throw new Error('diagnosis output is invalid')
    return this.mutate(record => {
      const entry = this.diagnosis(record, failureKey)
      if (entry.sourceFingerprint !== sourceFingerprint) throw new Error('diagnosis source fingerprint changed')
      if (entry.status === 'COMPLETE' || entry.status === 'APPLIED') {
        if (stableJson(entry.output) !== stableJson(output)) throw new Error('diagnosis output conflicts with its durable result')
        return entry
      }
      if (entry.status !== 'PENDING') throw new Error(`cannot complete diagnosis in ${entry.status} state`)
      entry.output = output
      entry.outputSourceFingerprint = sourceFingerprint
      entry.completedAt = this.timestamp()
      entry.status = 'COMPLETE'
      return entry
    }, true)
  }

  /** Bind a completed diagnosis recommendation to current repository-owned state and plan intent. */
  async recordDiagnosisApplication(
    failureKey: string,
    application: Pick<DiagnosisApplication, 'stateRevision' | 'planDigest' | 'recommendation' | 'repairConstraints'>,
  ): Promise<DiagnosisApplication> {
    if (!nonempty(failureKey) || !Number.isSafeInteger(application.stateRevision) || application.stateRevision < 0
      || !isStrings(application.repairConstraints) || application.recommendation !== 'REPLAN' && application.recommendation !== 'REPAIR_WITHIN_PLAN') throw new Error('diagnosis application fields are invalid')
    fingerprint(application.planDigest, 'planDigest')
    if (this.workflow !== 'development') throw new Error('diagnosis application is only supported for development tasks')
    const path = diagnosisApplicationPath(this.root, this.taskId, this.workflow, failureKey)
    return withFileLock(join(this.taskDirectory(), 'STATE.json'), async () => withFileLock(this.path, async () => {
      const record = await this.load()
      const diagnosis = this.diagnosis(record, failureKey)
      if (diagnosis.status !== 'COMPLETE' && diagnosis.status !== 'APPLIED') throw new Error('diagnosis must be complete before application')
      if (application.recommendation !== 'REPLAN') throw new Error('repair application requires an authoritative typed repair intent')
      if (application.planDigest !== diagnosis.planDigest) throw new Error('diagnosis application plan digest mismatch')
      const state = await this.readJson(join(this.taskDirectory(), 'STATE.json'))
      if (state.taskId !== this.taskId || state.state !== 'REPLAN' || state.revision !== application.stateRevision) throw new Error('diagnosis application does not match current REPLAN state revision')
      const plan = await this.readJson(join(this.taskDirectory(), 'PLAN.json'))
      if (plan.schemaVersion !== 2 || plan.taskId !== this.taskId || plan.intentDigest !== application.planDigest) throw new Error('diagnosis application plan intent digest mismatch')
      const journal: DiagnosisApplication = {
        schemaVersion: 1, taskId: this.taskId, workflow: this.workflow, failureKey,
        ...application, appliedAt: this.timestamp(),
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const existing = await this.readOptional(path)
      if (existing !== undefined) {
        const parsed = this.parseApplication(JSON.parse(existing))
        const { appliedAt: _existingAppliedAt, ...existingApplication } = parsed
        const { appliedAt: _newAppliedAt, ...newApplication } = journal
        if (stableJson(existingApplication) !== stableJson(newApplication)) throw new Error('diagnosis application journal conflicts with the durable application')
        return parsed
      }
      await writeFileAtomic(path, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 })
      return journal
    }))
  }

  /** Mark a diagnosis applied only after its durable application journal and actual state agree. */
  async applyDiagnosis(failureKey: string, appliedStateRevision: number): Promise<DiagnosisObligation> {
    if (!Number.isSafeInteger(appliedStateRevision) || appliedStateRevision < 0) throw new Error('applied state revision must be a non-negative integer')
    return withFileLock(join(this.taskDirectory(), 'STATE.json'), () => this.mutate(async record => {
      const diagnosis = this.diagnosis(record, failureKey)
      const journal = this.parseApplication(JSON.parse(await this.readRequired(diagnosisApplicationPath(this.root, this.taskId, this.workflow, failureKey))))
      const state = await this.readJson(join(this.taskDirectory(), 'STATE.json'))
      const plan = await this.readJson(join(this.taskDirectory(), 'PLAN.json'))
      if (journal.failureKey !== failureKey || journal.recommendation !== 'REPLAN' || journal.stateRevision !== appliedStateRevision
        || state.state !== 'REPLAN' || state.revision !== appliedStateRevision || plan.schemaVersion !== 2 || plan.intentDigest !== journal.planDigest
        || diagnosis.status !== 'COMPLETE' && diagnosis.status !== 'APPLIED') throw new Error('diagnosis application journal does not match actual state and plan intent')
      if (diagnosis.status === 'APPLIED') {
        if (diagnosis.appliedStateRevision !== appliedStateRevision) throw new Error('diagnosis was applied at another state revision')
        return diagnosis
      }
      diagnosis.status = 'APPLIED'
      diagnosis.appliedStateRevision = appliedStateRevision
      diagnosis.appliedAt = journal.appliedAt
      return diagnosis
    }, true))
  }

  private async assertNewTask(): Promise<void> {
    const directory = this.taskDirectory()
    const statePath = join(directory, 'STATE.json')
    const state = await this.readJson(statePath)
    const expected = this.workflow === 'development' ? 'NEW' : 'REQUEST'
    if (state.taskId !== this.taskId || state.state !== expected) throw new Error(`known-new scheduling initialization requires ${expected} task state`)
    const allowed = this.workflow === 'development'
      ? new Set(['TASK.yaml', 'TASK_PRESET.json', 'STATE.json', 'LIFECYCLE.json', 'AUTO.json', 'SCHEDULING.json.lock'])
      : new Set(['TASK.json', 'STATE.json', 'LIFECYCLE.json', 'SCHEDULING.json.lock'])
    const entries = await readdir(directory)
    if (entries.some(entry => !allowed.has(entry))) throw new Error('known-new scheduling initialization found prior task artifacts')
    if (entries.includes('LIFECYCLE.json')) {
      const lifecycle = await this.readJson(join(directory, 'LIFECYCLE.json'))
      const counts = lifecycle.counts
      if (lifecycle.taskId !== this.taskId || lifecycle.history !== 'KNOWN' || !isRecord(counts)
        || Object.values(counts).some(value => value !== 0) || lifecycle.unknownUsage !== false || lifecycle.unknownCost !== false
        || lifecycle.legacyLogicalInvocations !== 0 || lifecycle.legacyModelAttempts !== 0
        || !Array.isArray(lifecycle.invocations) || lifecycle.invocations.length !== 0
        || !Array.isArray(lifecycle.attempts) || lifecycle.attempts.length !== 0
        || !Array.isArray(lifecycle.requests) || lifecycle.requests.length !== 0
        || !Array.isArray(lifecycle.toolExecutions) || lifecycle.toolExecutions.length !== 0) throw new Error('known-new scheduling initialization found lifecycle history')
    }
    if (entries.includes('AUTO.json')) {
      const journal = await this.readJson(join(directory, 'AUTO.json'))
      if (this.workflow !== 'development' || journal.schemaVersion !== 1 || !isStrings(journal.requests)
        || journal.steps !== 0 || journal.roleCalls !== 0 || journal.completedWriterRevision !== null
        || journal.verifiedTreeHash !== null || !isRecord(journal.pendingTask) || journal.pendingTask.id !== this.taskId) {
        throw new Error('known-new scheduling initialization found automatic workflow history')
      }
    }
    const taskPath = join(directory, this.workflow === 'development' ? 'TASK.yaml' : 'TASK.json')
    const task = this.workflow === 'development' ? undefined : await this.readJson(taskPath)
    if (task !== undefined && task.id !== this.taskId) throw new Error('scheduling task metadata identity mismatch')
    if (this.workflow === 'development' && await this.readRequired(taskPath) === '') throw new Error('scheduling task metadata is empty')
  }

  private async assertTaskIdentity(): Promise<void> {
    const directory = this.taskDirectory()
    const state = await this.readJson(join(directory, 'STATE.json'))
    if (state.taskId !== this.taskId) throw new Error('scheduling state task identity mismatch')
    if (this.workflow === 'development') {
      let task: unknown
      try { task = loadYaml(await readFile(join(directory, 'TASK.yaml'), 'utf8')) }
      catch (error) { throw new Error(`cannot read scheduling task metadata: ${String(error)}`) }
      if (!isRecord(task) || task.id !== this.taskId) throw new Error('scheduling task metadata identity mismatch')
    } else {
      const task = await this.readJson(join(directory, 'TASK.json'))
      if (task.id !== this.taskId) throw new Error('scheduling review metadata identity mismatch')
    }
  }

  private async load(): Promise<SchedulingRecord> {
    const source = await this.readOptional(this.path)
    const markerSource = await this.readOptional(this.markerPath)
    if (source === undefined) {
      if (markerSource !== undefined) throw new Error('scheduling ledger is missing after known initialization')
      return newRecord(this.taskId, this.workflow, 'UNKNOWN')
    }
    if (markerSource === undefined) throw new Error('scheduling ledger has no durable initialization marker')
    let marker: unknown
    try { marker = JSON.parse(markerSource) } catch (error) { throw new Error(`scheduling marker is torn: ${String(error)}`) }
    if (!isRecord(marker) || marker.schemaVersion !== 1 || marker.taskId !== this.taskId || marker.workflow !== this.workflow
      || typeof marker.initializedAt !== 'string' || !Number.isFinite(Date.parse(marker.initializedAt))) throw new Error('scheduling marker identity or fields are invalid')
    let parsed: unknown
    try { parsed = JSON.parse(source) } catch (error) { throw new Error(`scheduling ledger is torn: ${String(error)}`) }
    return validateRecord(parsed, this.taskId, this.workflow)
  }

  private async mutate<T>(operation: (record: SchedulingRecord) => T | Promise<T>, allowUnknownHistory = false): Promise<T> {
    return withFileLock(this.path, async () => {
      await this.assertTaskIdentity()
      const record = await this.load()
      if (record.history === 'UNKNOWN' && !allowUnknownHistory) throw new Error('scheduling history is unknown; operation is fail-closed')
      const result = await operation(record)
      await this.write(record)
      return result
    })
  }

  private async write(record: SchedulingRecord): Promise<void> {
    validateRecord(record, this.taskId, this.workflow)
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await writeFileAtomic(this.path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  }

  private async readJson(path: string): Promise<Record<string, unknown>> {
    let parsed: unknown
    try { parsed = JSON.parse(await readFile(path, 'utf8')) } catch (error) { throw new Error(`cannot read repository scheduling authority ${path}: ${String(error)}`) }
    if (!isRecord(parsed)) throw new Error(`repository scheduling authority ${path} must be an object`)
    return parsed
  }

  private async readRequired(path: string): Promise<string> { return readFile(path, 'utf8') }

  private async readOptional(path: string): Promise<string | undefined> {
    try { return await readFile(path, 'utf8') }
    catch (error) { if (isRecord(error) && error.code === 'ENOENT') return undefined; throw error }
  }

  private taskDirectory(): string { return join(this.root, '.agent', this.workflow === 'development' ? 'tasks' : 'reviews', this.taskId) }

  private timestamp(): string { return this.now() }

  private escalation(record: SchedulingRecord, id: SchedulingEscalationId): SchedulingEscalation {
    const entry = record.escalations.find(item => item.id === id)
    if (entry === undefined) throw new Error('unknown scheduling escalation ID')
    return entry
  }

  private diagnosis(record: SchedulingRecord, failureKey: string): DiagnosisObligation {
    const entry = record.diagnoses.find(item => item.failureKey === failureKey)
    if (entry === undefined) throw new Error(`unknown diagnosis failure key ${failureKey}`)
    return entry
  }

  private parseApplication(value: unknown): DiagnosisApplication {
    if (!isRecord(value) || value.schemaVersion !== 1 || value.taskId !== this.taskId || value.workflow !== this.workflow
      || !nonempty(value.failureKey) || !Number.isSafeInteger(value.stateRevision) || (value.stateRevision as number) < 0
      || !/^[a-f0-9]{64}$/.test(String(value.planDigest)) || value.recommendation !== 'REPLAN'
      || !isStrings(value.repairConstraints) || typeof value.appliedAt !== 'string' || !Number.isFinite(Date.parse(value.appliedAt))) throw new Error('diagnosis application journal is invalid')
    return {
      schemaVersion: 1, taskId: this.taskId, workflow: this.workflow, failureKey: value.failureKey,
      stateRevision: value.stateRevision as number, planDigest: value.planDigest as string, recommendation: 'REPLAN',
      repairConstraints: value.repairConstraints, appliedAt: value.appliedAt,
    }
  }
}
