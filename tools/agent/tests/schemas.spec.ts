import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ArtifactSchemas, ArtifactValidationError } from '../src/schemas.ts'
import type { ArtifactSchemaName, ReviewArtifactSchemaName } from '../src/schemas.ts'

const schemas = new ArtifactSchemas(resolve('.agent/schemas'))
const timestamp = '2026-10-04T00:00:00.000Z'

const fixtures: Record<ArtifactSchemaName | ReviewArtifactSchemaName, object> = {
  'review-task': {
    schemaVersion: 1, id: 'schema-review', target: { kind: 'commit', target: 'a'.repeat(40) },
    snapshot: { schemaVersion: 1, id: 'b'.repeat(64), repositoryRoot: '/fixture', targetCommit: 'a'.repeat(40), baseCommit: 'c'.repeat(40), objectFormat: 'sha1' },
    scope: [{ path: 'source.ts', status: 'M' }], dataClass: 'public', createdAt: timestamp,
  },
  'review-state': {
    schemaVersion: 1, taskId: 'schema-review', state: 'REVIEW_COMPLETE', revision: 7, workRevision: 0, fixAttempts: 0, writer: null, updatedAt: timestamp,
  },
  'review-result': {
    schemaVersion: 1, taskId: 'schema-review', revision: 7, status: 'REVIEW_COMPLETE',
    snapshot: { schemaVersion: 1, id: 'b'.repeat(64), repositoryRoot: '/fixture', targetCommit: 'a'.repeat(40), baseCommit: 'c'.repeat(40), objectFormat: 'sha1' },
    state: { schemaVersion: 1, taskId: 'schema-review', state: 'REVIEW_COMPLETE', revision: 7, workRevision: 0, fixAttempts: 0, writer: null, updatedAt: timestamp },
    summary: 'Changed source inspected', findings: [], inspectedEvidenceIds: ['receipt-1'],
    evidence: [{ id: 'receipt-1', snapshotId: 'b'.repeat(64), operation: 'show', path: 'source.ts', commit: 'a'.repeat(40),
      startLine: 1, endLine: 3, totalLines: 3, contentHash: 'd'.repeat(64), complete: true, binary: false }],
    unresolvedQuestions: [],
  },
  task: {
    schemaVersion: 1,
    id: 'schema-task',
    title: 'Schema task',
    profile: 'compiler',
    dataClass: 'public',
    createdAt: timestamp,
  },
  state: {
    schemaVersion: 1,
    taskId: 'schema-task',
    state: 'NEW',
    revision: 0,
    workRevision: 0,
    fixAttempts: 0,
    writer: null,
    updatedAt: timestamp,
  },
  baseline: {
    schemaVersion: 1,
    taskId: 'schema-task',
    taskRevision: 1,
    repositoryHead: 'dsh-v0.2.1-alpha.1',
    dirty: false,
    summary: 'Baseline captured',
  },
  investigation: {
    schemaVersion: 1,
    taskId: 'schema-task',
    taskRevision: 2,
    findings: ['Finding'],
    hypotheses: [{ statement: 'Hypothesis', evidence: ['Evidence'] }],
    unresolvedAssumptions: [],
  },
  plan: {
    schemaVersion: 1,
    taskId: 'schema-task',
    taskRevision: 3,
    workRevision: 1,
    problemStatement: 'Problem',
    hypotheses: ['Hypothesis'],
    selectedApproach: 'Approach',
    rejectedAlternatives: ['Alternative'],
    invariants: ['Invariant'],
    expectedComponents: ['Component'],
    implementationScope: ['Scope'],
    falsificationTests: ['Test'],
    acceptanceGates: ['Gate'],
    unresolvedAssumptions: [],
  },
  evidence: {
    schemaVersion: 1,
    id: 'evidence-1',
    taskId: 'schema-task',
    workRevision: 1,
    kind: 'command',
    status: 'PASS',
    timestamp,
    summary: 'Command passed',
    scope: { target: 'host' },
    command: { executable: 'node', args: ['--version'], cwd: '.', exitCode: 0, timedOut: false },
  },
  verification: {
    schemaVersion: 1,
    taskId: 'schema-task',
    taskRevision: 6,
    workRevision: 1,
    status: 'PASS',
    checks: [{ name: 'unit', required: true, status: 'PASS', evidenceIds: ['evidence-1'] }],
    scope: { target: 'host' },
  },
  review: {
    schemaVersion: 1,
    taskId: 'schema-task',
    taskRevision: 8,
    workRevision: 1,
    decision: 'ACCEPT',
    summary: 'Accepted',
    findings: [],
  },
  decision: {
    schemaVersion: 1,
    taskId: 'schema-task',
    taskRevision: 9,
    workRevision: 1,
    decision: 'ACCEPTED',
    acceptedAt: timestamp,
    verificationStatus: 'PASS',
    reviewDecision: 'ACCEPT',
  },
}

describe('artifact schemas', () => {
  it.each([undefined, [{ id: 'receipt-1', snapshotId: 'b'.repeat(64), operation: 'show', complete: true, binary: false }]])(
    'rejects a review result without validated receipt metadata: %j', async evidence => {
      await expect(schemas.validate('review-result', { ...fixtures['review-result'], evidence })).rejects.toBeInstanceOf(ArtifactValidationError)
    },
  )

  it.each([
    { writer: { role: 'implementer', token: 'forbidden-writer', baseRevision: 1 } },
    { state: 'IMPLEMENTING' },
    { workRevision: 1 },
    { fixAttempts: 1 },
  ])('rejects development authority in persisted review state: %j', async invalid => {
    await expect(schemas.validate('review-state', { ...fixtures['review-state'], ...invalid })).rejects.toBeInstanceOf(ArtifactValidationError)
  })

  it('dispatches verification generations explicitly and rejects duplicate or non-JSON instances', async () => {
    const legacy = fixtures.verification
    const check = { name: 'unit', required: true, status: 'PASS', evidenceIds: ['evidence-1'] }
    const current = { ...legacy, schemaVersion: 2, checks: [{ ...check, category: 'unit', scope: { backend: 'one' } }] }
    await expect(schemas.validate('verification', legacy)).resolves.toBe(legacy)
    await expect(schemas.validate('verification', current)).resolves.toBe(current)
    await expect(schemas.validate('verification', { ...current, schemaVersion: 3 })).rejects.toBeInstanceOf(ArtifactValidationError)
    await expect(schemas.validate('verification', { ...current, checks: [...current.checks, ...current.checks] })).rejects.toThrow('duplicate')
    await expect(schemas.validate('verification', { ...current, checks: [{ ...check, category: 'unit', scope: { timestamp: new Date() } }] })).rejects.toThrow('JSON')
  })

  it.each(['../outside', 'Uppercase', 'has_space', '', 'compiler\n', 'compiler\r', '-compiler', 42, null])(
    'rejects task profile ID %j', async profile => {
      await expect(schemas.validate('task', { ...fixtures.task, profile })).rejects.toBeInstanceOf(ArtifactValidationError)
    },
  )

  it.each(Object.entries(fixtures))('accepts a valid %s artifact', async (name, fixture) => {
    await expect(schemas.validate(name as ArtifactSchemaName | ReviewArtifactSchemaName, fixture)).resolves.toBe(fixture)
  })

  it.each(Object.keys(fixtures))('rejects an invalid %s artifact', async (name) => {
    await expect(schemas.validate(name as ArtifactSchemaName | ReviewArtifactSchemaName, {})).rejects.toBeInstanceOf(ArtifactValidationError)
  })
})
