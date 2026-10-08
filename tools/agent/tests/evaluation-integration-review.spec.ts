import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEngineeringEvaluationCases,
  engineeringEvaluationOracle,
  evaluationReviewTarget,
} from '../src/evaluation-fixtures.ts'

const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-evaluation-review-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true })))
})

describe('evaluation fixture and oracle integration', () => {
  it('creates all immutable cases with distinct seed and source identities', async () => {
    const cases = await createEngineeringEvaluationCases(process.cwd())
    expect(cases.map(item => item.id)).toEqual(['pebble-mul', 'mlir-pass', 'review-overflow', 'recovery-latch'])
    expect(new Set(cases.map(item => item.seedSha)).size).toBe(cases.length)
    expect(cases.every(item => /^[0-9a-f]{64}$/u.test(item.sourceDigest))).toBe(true)
    expect(cases.every(item => /^[0-9a-f]{64}$/u.test(item.requestDigest))).toBe(true)
  })

  it('rejects a recovery oracle result when an out-of-scope file changes', async () => {
    const recovery = (await createEngineeringEvaluationCases(process.cwd())).find(item => item.id === 'recovery-latch')!
    const cwd = await root()
    await recovery.run(cwd)
    await writeFile(join(cwd, 'answer.txt'), '42\n')
    await writeFile(join(cwd, 'unexpected.txt'), 'model output\n')
    const result = await engineeringEvaluationOracle(recovery, cwd, [])
    expect(result.accepted).toBe(false)
    expect(result.evidence).toMatchObject({ outOfScope: expect.arrayContaining(['unexpected.txt']) })
  })

  it('rejects a committed out-of-scope recovery change', async () => {
    const recovery = (await createEngineeringEvaluationCases(process.cwd())).find(item => item.id === 'recovery-latch')!
    const cwd = await root()
    await recovery.run(cwd)
    await writeFile(join(cwd, 'answer.txt'), '42\n')
    await writeFile(join(cwd, 'unexpected.txt'), 'committed model output\n')
    await execa('git', ['add', 'answer.txt', 'unexpected.txt'], { cwd })
    await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'out of scope'], { cwd })
    const result = await engineeringEvaluationOracle(recovery, cwd, [])
    expect(result.accepted).toBe(false)
    expect(result.evidence).toMatchObject({ outOfScope: expect.arrayContaining(['unexpected.txt']) })
  })

  it('accepts a recovery fixture when only its allowed file changes', async () => {
    const recovery = (await createEngineeringEvaluationCases(process.cwd())).find(item => item.id === 'recovery-latch')!
    const cwd = await root()
    await recovery.run(cwd)
    await writeFile(join(cwd, 'answer.txt'), '42\n')
    const result = await engineeringEvaluationOracle(recovery, cwd, [])
    expect(result.accepted).toBe(true)
  })

  it('requires the pinned review case before exposing a review target', async () => {
    const cases = await createEngineeringEvaluationCases(process.cwd())
    const review = cases.find(item => item.id === 'review-overflow')!
    expect(evaluationReviewTarget(review)).toEqual({ kind: 'commit', target: review.seedSha })
    expect(() => evaluationReviewTarget(cases.find(item => item.id === 'recovery-latch')!)).toThrow('not a pinned review fixture')
  })

  it('does not accept a forged review report for a different commit', async () => {
    const review = (await createEngineeringEvaluationCases(process.cwd())).find(item => item.id === 'review-overflow')!
    const cwd = await root()
    await review.run(cwd)
    const reviewDir = join(cwd, '.agent/reviews', 'forged')
    await import('node:fs/promises').then(fs => fs.mkdir(reviewDir, { recursive: true }))
    await writeFile(join(reviewDir, 'RESULT.json'), JSON.stringify({
      snapshot: { targetCommit: '0000000000000000000000000000000000000000' },
      findings: [{ path: 'add.mjs', commit: review.seedSha, startLine: 2, endLine: 2, failureCondition: '2147483647 + 1' }],
    }))
    const result = await engineeringEvaluationOracle(review, cwd, [])
    expect(result.accepted).toBe(false)
  })
})
