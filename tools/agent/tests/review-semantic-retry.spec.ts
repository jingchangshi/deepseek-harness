import { cp, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadHarnessConfig } from '../src/config.ts'
import { createEngineeringEvaluationCases, evaluationReviewTarget, prepareEngineeringEvaluationRepository } from '../src/evaluation-fixtures.ts'
import { runEngineeringReview } from '../src/review-only.ts'
import { TaskRepository } from '../src/repository.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('bounded corrective review after incomplete semantic evidence', () => {
  it('requests missing evidence once and persists the complete second review', async () => {
    const checkout = process.cwd()
    const testCase = (await createEngineeringEvaluationCases(checkout)).find(item => item.id === 'review-overflow')!
    const root = await mkdtemp(join(tmpdir(), 'dsh-review-semantic-retry-'))
    roots.push(root)
    await testCase.run(root)
    await prepareEngineeringEvaluationRepository(testCase, root, checkout)
    for (const name of await readdir(join(checkout, '.agent/config'))) {
      if (name !== 'project.yaml' && name.endsWith('.yaml')) await cp(join(checkout, '.agent/config', name), join(root, '.agent/config', name))
    }
    const deployment = await loadHarnessConfig(root, { env: {} })
    const unresolved = 'Confirm the pinned addition source and diff before reporting overflow.'
    const requests: string[] = []
    const result = await runEngineeringReview({
      root, deployment, target: evaluationReviewTarget(testCase),
      executeRole: async input => {
        expect(input.role).toBe('reviewer')
        requests.push(input.request)
        if (requests.length === 1) return {
          summary: 'The overflow trigger needs source inspection.', findings: [], inspectedEvidenceIds: [], unresolvedQuestions: [unresolved],
        }
        expect(requests).toHaveLength(2)
        expect(input.request).toContain(unresolved)
        expect(input.request).not.toBe(requests[0])
        const evidence = input.reviewEvidence
        if (evidence === undefined) throw new Error('corrective reviewer requires trusted pinned Git evidence')
        const show = await evidence.show({ path: 'add.mjs' })
        const diff = await evidence.diff({ path: 'add.mjs' })
        const ids = [show.evidenceId, diff.evidenceId]
        return {
          summary: 'The pinned addition introduces signed overflow.',
          findings: [{ severity: 'high', description: 'Signed arithmetic wraps for a valid positive sum.', path: 'add.mjs', commit: testCase.seedSha,
            startLine: 2, endLine: 2, failureCondition: 'add(2147483647, 1) returns -2147483648 instead of 2147483648',
            changeRelation: 'The changed addition applies signed 32-bit coercion.', evidenceIds: ids }],
          inspectedEvidenceIds: ids, unresolvedQuestions: [],
        }
      },
    })
    expect(result.status, JSON.stringify(result.unresolvedQuestions)).toBe('REVIEW_COMPLETE')
    expect(requests).toHaveLength(2)
    expect(result.unresolvedQuestions).toEqual([])
    expect(result.findings).toHaveLength(1)
    const durable = await new TaskRepository(root).readReviewResult(result.taskId)
    expect(durable.status).toBe('REVIEW_COMPLETE')
    expect(durable.findings).toEqual(result.findings)
    expect(durable.evidence.map(receipt => receipt.operation).toSorted()).toEqual(['diff', 'show'])
    expect(new Set(durable.evidence.map(receipt => receipt.snapshotId))).toEqual(new Set([result.snapshot.id]))
  })
})
