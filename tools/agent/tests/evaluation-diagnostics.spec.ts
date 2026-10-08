import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngineeringEvaluationCases, engineeringEvaluationOracle, evaluationReviewTarget } from '../src/evaluation-fixtures.ts'
import { createGitSnapshot, GitEvidenceRepository } from '../src/git-evidence.ts'

const roots: string[] = []
const sentinel = 'MODEL_PRIVATE_SENTINEL_DO_NOT_COPY'

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function reviewFixture() {
  const testCase = (await createEngineeringEvaluationCases(process.cwd())).find(item => item.id === 'review-overflow')
  if (testCase === undefined) throw new Error('missing pinned review case')
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-diagnostics-'))
  roots.push(root)
  await testCase.run(root)
  const evidence = new GitEvidenceRepository(await createGitSnapshot(root, evaluationReviewTarget(testCase)))
  const show = await evidence.show({ path: 'add.mjs' })
  const diff = await evidence.diff({ path: 'add.mjs' })
  const finding = {
    path: 'add.mjs', commit: testCase.seedSha, startLine: 2, endLine: 2,
    description: sentinel, failureCondition: `${sentinel}: add(2147483647, 1) wraps`,
    evidenceIds: [show.evidenceId, diff.evidenceId] as string[],
  }
  const directory = join(root, '.agent/reviews', 'diagnostic-fixture')
  await mkdir(directory, { recursive: true })
  return {
    finding,
    async evaluate(changes: Partial<typeof finding> = {}) {
      await writeFile(join(directory, 'RESULT.json'), JSON.stringify({
        status: 'REVIEW_COMPLETE', snapshot: evidence.snapshot, summary: sentinel,
        findings: [{ ...finding, ...changes }], evidence: evidence.observedEvidence(),
        inspectedEvidenceIds: [show.evidenceId, diff.evidenceId],
      }))
      return engineeringEvaluationOracle(testCase, root, [])
    },
  }
}

describe('pinned review oracle boolean diagnostics', () => {
  it('explains an accepted exact-line finding without copying model text or evidence IDs', async () => {
    const fixture = await reviewFixture()
    const result = await fixture.evaluate()
    expect(result.accepted).toBe(true)
    expect(result.evidence).toMatchObject({
      reviewChecks: { durableComplete: true, snapshotMatchesTarget: true, pinnedBugVerified: true, cleanControlVerified: true },
      findingChecks: [{ index: 0, pathMatchesTarget: true, commitMatchesTarget: true, exactLine2: true,
        validSpanContainsLine2: true, failureConditionIncludesLiteral2147483647: true, failureConditionIncludesLiteral1: true,
        nonemptyCitations: true, allCitationsObservedForTargetPath: true, sourceShowCoversLine2: true, diffPresent: true, accepted: true }],
    })
    const diagnostic = result.evidence as { reviewChecks: Record<string, boolean>; findingChecks: Array<Record<string, boolean | number>> }
    const serialized = JSON.stringify({ reviewChecks: diagnostic.reviewChecks, findingChecks: diagnostic.findingChecks })
    expect(serialized).not.toContain(sentinel)
    for (const id of fixture.finding.evidenceIds) expect(serialized).not.toContain(id)
    expect(Object.values(diagnostic.reviewChecks).every(value => typeof value === 'boolean')).toBe(true)
    expect(diagnostic.findingChecks.every(check => Object.entries(check).every(([key, value]) => key === 'index' ? typeof value === 'number' : typeof value === 'boolean'))).toBe(true)
  })

  it('reports a containing span while preserving rejection unless both lines equal two', async () => {
    const fixture = await reviewFixture()
    const result = await fixture.evaluate({ startLine: 1, endLine: 3 })
    expect(result.accepted).toBe(false)
    expect(result.evidence).toMatchObject({ findingChecks: [{ index: 0, exactLine2: false, validSpanContainsLine2: true, accepted: false }] })
  })

  it('identifies an invented citation even when real source and diff receipts exist', async () => {
    const fixture = await reviewFixture()
    const result = await fixture.evaluate({ evidenceIds: ['invented-citation-private-sentinel'] })
    expect(result.accepted).toBe(false)
    expect(result.evidence).toMatchObject({ findingChecks: [{ index: 0, nonemptyCitations: true, allCitationsObservedForTargetPath: false, sourceShowCoversLine2: true, diffPresent: true, accepted: false }] })
    expect(JSON.stringify(result.evidence)).not.toContain('invented-citation-private-sentinel')
  })

  it('names literal condition checks without treating an equivalent explanation as acceptance', async () => {
    const fixture = await reviewFixture()
    const result = await fixture.evaluate({ failureCondition: `${sentinel}: add(MAX_INT, one) wraps` })
    expect(result.accepted).toBe(false)
    expect(result.evidence).toMatchObject({ findingChecks: [{ index: 0, failureConditionIncludesLiteral2147483647: false, failureConditionIncludesLiteral1: false, accepted: false }] })
  })
})
