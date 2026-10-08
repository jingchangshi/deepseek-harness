/** Repository task artifacts owned by the deterministic engineering protocol. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { PlanBinding, PlanIntentDigest, VerificationIdentity } from './identity.ts'
import type { VerificationReference } from './policy.ts'

/** Repository task states owned by the deterministic engineering protocol. */
export const TASK_STATES = [
  'NEW',
  'BASELINED',
  'INVESTIGATED',
  'PLAN_FROZEN',
  'IMPLEMENTING',
  'VERIFYING',
  'VERIFIED',
  'REVIEWING',
  'REVIEWED',
  'ACCEPTED',
  'REPLAN',
  'BLOCKED',
  'BUDGET_EXHAUSTED',
] as const

/** One state in the repository task protocol. */
export type TaskState = typeof TASK_STATES[number]

/** Result status retained without collapsing incomplete work into success. */
export type CheckStatus = 'PASS' | 'FAIL' | 'NOT_RUN' | 'INCOMPLETE'

/** Reviewer outcomes accepted by the deterministic transition engine. */
export type ReviewDecision = 'ACCEPT' | 'FIX_BOUNDED' | 'REPLAN' | 'BLOCKED'

/** Exclusive repository writer admitted for one task revision. */
export interface WriterLease {
  role: 'implementer'
  token: string
  baseRevision: number
}

/** Authoritative task state stored in `STATE.json`. */
export interface TaskStateRecord {
  schemaVersion: 1
  taskId: string
  state: TaskState
  revision: number
  workRevision: number
  fixAttempts: number
  writer: WriterLease | null
  updatedAt: string
  blocker?: string
}

/** Immutable task metadata stored in `TASK.yaml`. */
export interface TaskDocument {
  schemaVersion: 1
  id: string
  title: string
  profile: string
  dataClass: 'public' | 'internal' | 'sensitive'
  createdAt: string
}

/** Frozen plan fields required before implementation may start. */
export interface PlanDocument {
  schemaVersion: 1
  taskId: string
  taskRevision: number
  workRevision: number
  problemStatement: string
  hypotheses: string[]
  selectedApproach: string
  rejectedAlternatives: string[]
  invariants: string[]
  expectedComponents: string[]
  implementationScope: string[]
  falsificationTests: string[]
  acceptanceGates: string[]
  unresolvedAssumptions: Array<{ statement: string; acceptanceBlocking: boolean }>
}

/** Identity-bearing plan generation with immutable intent and repository-owned source binding. */
export interface BoundPlanDocument extends Omit<PlanDocument, 'schemaVersion'> {
  schemaVersion: 2
  intentDigest: PlanIntentDigest
  binding: PlanBinding
  verificationExtras?: VerificationReference[]
}

/** Explicit readable plan generations; only the bound generation can authorize new work. */
export type PlanRecord = PlanDocument | BoundPlanDocument

/** One verification check and its evidence references. */
export interface VerificationCheck {
  name: string
  category: string
  scope: Record<string, JsonValue>
  required: boolean
  status: CheckStatus
  evidenceIds: string[]
}

/** One immutable evidence record appended to `EVIDENCE.jsonl`. */
export interface EvidenceDocument {
  schemaVersion: 1
  id: string
  taskId: string
  workRevision: number
  kind: 'command' | 'model-route' | 'inspection' | 'review'
  status: CheckStatus
  timestamp: string
  summary: string
  scope: Record<string, object | string | number | boolean | null>
  command?: {
    executable: string
    args: string[]
    cwd: string
    exitCode?: number | null
    timedOut?: boolean
  }
}

/** Structured verification result for one frozen work revision. */
export interface VerificationDocument {
  schemaVersion: 2
  taskId: string
  taskRevision: number
  workRevision: number
  status: CheckStatus
  checks: VerificationCheck[]
  scope: Record<string, object | string | number | boolean | null>
}

/** Readable predecessor verification generation; acceptance requires re-verification. */
export interface LegacyVerificationDocument extends Omit<VerificationDocument, 'schemaVersion' | 'checks'> {
  schemaVersion: 1
  checks: Array<Omit<VerificationCheck, 'category' | 'scope'>>
}

/** Explicitly supported durable verification generations. */
export type VerificationRecord = LegacyVerificationDocument | VerificationDocument | BoundVerificationDocument

/** Source- and policy-bound verification generation. */
export interface BoundVerificationDocument extends Omit<VerificationDocument, 'schemaVersion'> {
  schemaVersion: 3
  identity: VerificationIdentity
}

/** Structured independent review for one frozen work revision. */
export interface ReviewDocument {
  schemaVersion: 1
  taskId: string
  taskRevision: number
  workRevision: number
  decision: ReviewDecision
  summary: string
  findings: string[]
  blocker?: string
}

/** Source- and policy-bound independent review generation. */
export interface BoundReviewDocument extends Omit<ReviewDocument, 'schemaVersion'> {
  schemaVersion: 2
  identity: VerificationIdentity
}

/** Explicit readable review generations. */
export type ReviewRecord = ReviewDocument | BoundReviewDocument

/** Machine-created acceptance decision. */
export interface DecisionDocument {
  schemaVersion: 1
  taskId: string
  taskRevision: number
  workRevision: number
  decision: 'ACCEPTED'
  acceptedAt: string
  verificationStatus: 'PASS'
  reviewDecision: 'ACCEPT'
}

/** Machine-created decision bound to the final verification attempt. */
export interface BoundDecisionDocument extends Omit<DecisionDocument, 'schemaVersion'> {
  schemaVersion: 2
  identity: VerificationIdentity
}
