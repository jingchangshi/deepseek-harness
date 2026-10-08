/** Durable records and model output used by the independent review workflow. */

import type { GitReviewTarget, GitSnapshot } from './git-evidence.ts'

/** Review-only state; it carries no development writer lease. */
export type ReviewState = 'REQUEST' | 'SNAPSHOT' | 'SCOPE_CLASSIFIED' | 'REVIEW_INVESTIGATION' | 'INDEPENDENT_REVIEW' | 'EVIDENCE_VALIDATION' | 'REVIEW_COMPLETE' | 'PARTIAL' | 'BLOCKED'

/** Revisioned review state stored beside development tasks. */
export interface ReviewStateRecord {
  schemaVersion: 1
  taskId: string
  state: ReviewState
  revision: number
  workRevision: 0
  fixAttempts: 0
  writer: null
  updatedAt: string
  blocker?: string
  requiresStopConfirmation?: boolean
}

/** Immutable requested target and resolved Git snapshot for one review. */
export interface ReviewTaskDocument {
  schemaVersion: 1
  id: string
  target: GitReviewTarget
  snapshot: GitSnapshot
  scope: Array<{ path: string; status: string }>
  dataClass: 'public' | 'internal' | 'sensitive'
  createdAt: string
}

/** A finding linked to evidence gathered from the pinned source snapshot. */
export interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low'
  description: string
  path: string
  commit: string
  startLine: number
  endLine: number
  failureCondition: string
  changeRelation: string
  evidenceIds: string[]
}

/** Structured reviewer response before repository evidence validation. */
export interface ReviewOutput {
  summary: string
  findings: ReviewFinding[]
  inspectedEvidenceIds: string[]
  unresolvedQuestions: string[]
}
