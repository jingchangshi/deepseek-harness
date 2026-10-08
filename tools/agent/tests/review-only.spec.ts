import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { dump } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadHarnessConfig } from '../src/config.ts'
import { runEngineeringReview } from '../src/review-only.ts'
import { runEngineeringTask, recoverEngineeringTask, getEngineeringStatus } from '../src/automatic.ts'
import { collectRole } from '../runtime/index.ts'
import { TaskRepository } from '../src/repository.ts'
import { createGitSnapshot } from '../src/git-evidence.ts'
import type { GitEvidenceReceipt } from '../src/git-evidence.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RoleInvocation } from '../src/automatic.ts'

const roots: string[] = []
const safe = 'export function divide(denominator) {\n  return 12 / Math.max(denominator, 1)\n}\n'
const defective = 'export function divide(denominator) {\n  return 12 / denominator\n}\n'
const clean = 'export function divide(denominator) {\n  return 24 / Math.max(denominator, 1)\n}\n'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  return { promise, resolve }
}

async function fixture(bug = true, secondFile = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-only-'))
  roots.push(root)
  await cp(resolve('.agent'), join(root, '.agent'), { recursive: true, filter: source => !source.includes(join('.agent', 'tasks')) })
  await writeFile(join(root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 40, maxRoleCalls: 30, commandTimeoutMs: 30_000 }))
  await writeFile(join(root, '.agent/adapters/test.yaml'), dump({ adapters: Object.fromEntries(['unit', 'typecheck', 'build'].map(name => [name, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }])) }))
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: root })
  await writeFile(join(root, 'calc.mjs'), safe)
  if (secondFile) await writeFile(join(root, 'other.mjs'), 'export const value = 1\n')
  await execa('git', ['add', 'calc.mjs', ...secondFile ? ['other.mjs'] : []], { cwd: root })
  await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base'], { cwd: root })
  await writeFile(join(root, 'calc.mjs'), bug ? defective : clean)
  if (secondFile) await writeFile(join(root, 'other.mjs'), 'export const value = 2\n')
  await execa('git', ['add', 'calc.mjs', ...secondFile ? ['other.mjs'] : []], { cwd: root })
  await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'review target'], { cwd: root })
  const commit = (await execa('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout
  const oracle = await execa(process.execPath, ['--input-type=module', '-e', 'const m = await import(process.argv[1]); console.log(m.divide(0))', pathToFileURL(join(root, 'calc.mjs')).href])
  return { root, commit, oracle: oracle.stdout, deployment: await loadHarnessConfig(root, { env: {} }) }
}

async function inspected(input: RoleInvocation, paths = ['calc.mjs']) {
  if (input.reviewEvidence === undefined) throw new Error('Review executor has no trusted Git evidence repository')
  for (const path of paths) {
    await input.reviewEvidence.show({ path })
    await input.reviewEvidence.diff({ path })
  }
  return input.reviewEvidence.observedEvidence().filter(receipt => receipt.path !== undefined && paths.includes(receipt.path)).map(receipt => receipt.id)
}

function finding(commit: string, evidenceIds: readonly string[]) {
  return { severity: 'high' as const, description: 'Zero denominator produces Infinity', path: 'calc.mjs', commit,
    startLine: 2, endLine: 2, failureCondition: 'divide(0) returns Infinity', changeRelation: 'The changed expression removes the denominator clamp', evidenceIds: [...evidenceIds] }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('independent review-only workflow', () => {
  it.each([true, false])('completes a local Git review whose independent defect oracle is %s', async bug => {
    const options = await fixture(bug)
    expect(options.oracle).toBe(bug ? 'Infinity' : '24')
    const roles: string[] = []
    let observed: readonly GitEvidenceReceipt[] = []
    const result = await runEngineeringReview({ ...options, target: { kind: 'commit', target: options.commit }, executeRole: async input => {
      roles.push(input.role)
      const ids = await inspected(input)
      observed = input.reviewEvidence!.observedEvidence()
      return { summary: bug ? 'Division regression found' : 'Changed clamp remains safe', findings: bug ? [finding(options.commit, ids)] : [], inspectedEvidenceIds: ids, unresolvedQuestions: [] }
    } })
    expect(result.status, JSON.stringify(result.unresolvedQuestions)).toBe('REVIEW_COMPLETE')
    expect(result.snapshot.targetCommit).toBe(options.commit)
    expect(result.findings).toHaveLength(bug ? 1 : 0)
    const durable = await new TaskRepository(options.root).readReviewResult(result.taskId)
    expect(durable.evidence).toEqual(observed)
    expect(durable.inspectedEvidenceIds.toSorted()).toEqual(observed.map(receipt => receipt.id).toSorted())
    for (const receipt of durable.evidence) {
      expect(receipt.snapshotId).toBe(result.snapshot.id)
      expect(receipt.path).toBe('calc.mjs')
      expect(receipt.contentHash).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(durable.evidence.map(receipt => receipt.operation).toSorted()).toEqual(['diff', 'show'])
    expect(result.state).toMatchObject({ state: 'REVIEW_COMPLETE', writer: null })
    expect(roles).toEqual(['reviewer'])
    expect(await readFile(join(options.root, 'calc.mjs'), 'utf8')).toBe(bug ? defective : clean)
  })

  it.each(['placeholder', 'fabricated-line', 'fabricated-commit', 'unobserved-evidence', 'incomplete-coverage'] as const)('returns PARTIAL for schema-valid %s evidence', async invalid => {
    const options = await fixture(true, invalid === 'incomplete-coverage')
    const result = await runEngineeringReview({ ...options, target: { kind: 'commit', target: options.commit }, executeRole: async input => {
      const ids = invalid === 'placeholder' ? [] : await inspected(input)
      const value = finding(options.commit, ids)
      if (invalid === 'placeholder') { value.description = 'placeholder'; value.failureCondition = 'placeholder'; value.changeRelation = 'placeholder' }
      if (invalid === 'fabricated-line') { value.startLine = 999; value.endLine = 999 }
      if (invalid === 'fabricated-commit') value.commit = '0'.repeat(options.commit.length)
      if (invalid === 'unobserved-evidence') value.evidenceIds = ['fabricated-receipt']
      return { summary: 'Review result', findings: [value], inspectedEvidenceIds: ids, unresolvedQuestions: [] }
    } })
    expect(result.status, JSON.stringify(result.unresolvedQuestions)).toBe('PARTIAL')
    expect(result.state).toMatchObject({ state: 'PARTIAL', writer: null })
    expect(result.unresolvedQuestions.length).toBeGreaterThan(0)
  })

  it.each(['binary', 'truncated-text'] as const)('returns PARTIAL when %s scope has no complete inspection', async scenario => {
    const options = await fixture(false)
    const path = scenario === 'binary' ? 'binary.dat' : 'large.txt'
    await writeFile(join(options.root, path), scenario === 'binary' ? new Uint8Array([0, 255, 0, 128]) : Array.from({ length: 1000 }, (_item, index) => `changed line ${index}`).join('\n') + '\n')
    await execa('git', ['add', path], { cwd: options.root })
    await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', scenario], { cwd: options.root })
    const commit = (await execa('git', ['rev-parse', 'HEAD'], { cwd: options.root })).stdout
    const result = await runEngineeringReview({ ...options, target: { kind: 'commit', target: commit }, executeRole: async input => {
      if (input.reviewEvidence === undefined) throw new Error('Missing trusted evidence repository')
      const diff = await input.reviewEvidence.diff({ path, limit: 1 })
      const ids = [diff.evidenceId]
      if (scenario === 'truncated-text') ids.push((await input.reviewEvidence.show({ path, startLine: 1, lineCount: 1 })).evidenceId)
      return { summary: 'Partial scope inspection', findings: [], inspectedEvidenceIds: ids, unresolvedQuestions: [] }
    } })
    expect(result.status, JSON.stringify(result.unresolvedQuestions)).toBe('PARTIAL')
    expect(result.unresolvedQuestions.length).toBeGreaterThan(0)
    expect(result.state.writer).toBeNull()
  })

  it('accepts complete source and diff coverage assembled from multiple pages', async () => {
    const options = await fixture(false)
    const result = await runEngineeringReview({ ...options, target: { kind: 'commit', target: options.commit }, executeRole: async input => {
      const evidence = input.reviewEvidence
      if (evidence === undefined) throw new Error('Missing trusted evidence')
      const ids: string[] = []
      let line = 1
      for (;;) {
        const page = await evidence.show({ path: 'calc.mjs', startLine: line, lineCount: 1 })
        ids.push(page.evidenceId)
        if (page.completeness.complete) break
        if (page.completeness.nextLine === undefined) throw new Error('Source page has no continuation')
        line = page.completeness.nextLine
      }
      let offset = 0
      for (;;) {
        const page = await evidence.diff({ path: 'calc.mjs', offset, limit: 40 })
        ids.push(page.evidenceId)
        if (page.completeness.complete) break
        if (page.completeness.nextOffset === undefined) throw new Error('Diff page has no continuation')
        offset = page.completeness.nextOffset
      }
      return { summary: 'Every source and diff page inspected', findings: [], inspectedEvidenceIds: ids, unresolvedQuestions: [] }
    } })
    expect(result.status, JSON.stringify(result.unresolvedQuestions)).toBe('REVIEW_COMPLETE')
    expect(result.unresolvedQuestions).toEqual([])
  })

  it.each(['range-outside-read', 'range-beyond-eof', 'diff-only-finding', 'placeholder-summary', 'unresolved-question'] as const)('returns PARTIAL for %s despite otherwise complete file coverage', async invalid => {
    const options = await fixture()
    const result = await runEngineeringReview({ ...options, target: { kind: 'commit', target: options.commit }, executeRole: async input => {
      const evidence = input.reviewEvidence
      if (evidence === undefined) throw new Error('Missing trusted evidence')
      const show = await evidence.show({ path: 'calc.mjs' })
      const diff = await evidence.diff({ path: 'calc.mjs' })
      const value = finding(options.commit, [show.evidenceId, diff.evidenceId])
      if (invalid === 'range-outside-read') {
        const partial = await evidence.show({ path: 'calc.mjs', startLine: 2, lineCount: 1 })
        value.evidenceIds = [partial.evidenceId, diff.evidenceId]
        value.endLine = 3
      }
      if (invalid === 'range-beyond-eof') value.endLine = 999
      if (invalid === 'diff-only-finding') value.evidenceIds = [diff.evidenceId]
      return { summary: invalid === 'placeholder-summary' ? 'placeholder' : 'Evidence-linked review',
        findings: invalid === 'placeholder-summary' || invalid === 'unresolved-question' ? [] : [value],
        inspectedEvidenceIds: [show.evidenceId, diff.evidenceId], unresolvedQuestions: invalid === 'unresolved-question' ? ['Cannot establish behavior for zero denominator'] : [] }
    } })
    expect(result.status, JSON.stringify(result.unresolvedQuestions)).toBe('PARTIAL')
    expect(result.unresolvedQuestions.length).toBeGreaterThan(0)
  })

  it.each([1, 2])('partitions complex scope into exactly %s disjoint Scout assignments', async maxScouts => {
    const options = await fixture(false, true)
    const deployment = { ...options.deployment, workflow: { ...options.deployment.workflow, reviewMaxDirectFiles: 1, reviewMaxScouts: maxScouts } }
    const calls: Array<{ role: string; paths: string[] }> = []
    const result = await runEngineeringReview({ ...options, deployment, target: { kind: 'commit', target: options.commit }, executeRole: async input => {
      const scope = input.context.reviewScope
      if (!Array.isArray(scope)) throw new Error('Missing explicit review scope')
      const paths = scope.map((entry: unknown) => {
        if (typeof entry !== 'object' || entry === null || !('path' in entry) || typeof entry.path !== 'string') throw new Error('Invalid scope entry')
        return entry.path
      })
      calls.push({ role: input.role, paths })
      return { summary: 'Assigned source inspected', findings: [], inspectedEvidenceIds: await inspected(input, paths), unresolvedQuestions: [] }
    } })
    expect(result.status, JSON.stringify(result.unresolvedQuestions)).toBe('REVIEW_COMPLETE')
    const scouts = calls.filter(call => call.role.startsWith('scout-'))
    expect(scouts).toHaveLength(maxScouts)
    const scoutPaths = scouts.flatMap(call => call.paths)
    expect(scoutPaths.toSorted()).toEqual(['calc.mjs', 'other.mjs'])
    expect(new Set(scoutPaths).size).toBe(scoutPaths.length)
    expect(calls.filter(call => call.role === 'reviewer')).toEqual([{ role: 'reviewer', paths: ['calc.mjs', 'other.mjs'] }])
    expect(calls.some(call => ['architect', 'challenger', 'implementer'].includes(call.role))).toBe(false)
  })

  it.each(['onTaskSelected', 'onProgress'] as const)('does not dispatch a resumed empty-scope review cancelled by %s', async callback => {
    const options = await fixture(false)
    const target = { kind: 'commit' as const, target: options.commit, base: options.commit }
    const snapshot = await createGitSnapshot(options.root, target)
    const repository = new TaskRepository(options.root)
    const taskId = `cancelled-${callback.toLowerCase()}`
    let state = await repository.createReview({ schemaVersion: 1, id: taskId, target, snapshot, scope: [], dataClass: 'public', createdAt: new Date().toISOString() })
    state = await repository.advanceReview(taskId, state.revision, 'SNAPSHOT')
    await repository.classifyReviewScope(taskId, state.revision, [])
    const controller = new AbortController()
    const noDispatch = vi.fn(async () => { throw new Error('Cancelled resumed review reached its Reviewer') })
    const callbacks = callback === 'onTaskSelected'
      ? { onTaskSelected: async () => { controller.abort(new Error('Resume callback cancelled')) } }
      : { onProgress: () => { controller.abort(new Error('Resume callback cancelled')) } }
    await expect(runEngineeringReview({ ...options, taskId, target, signal: controller.signal, ...callbacks, executeRole: noDispatch })).rejects.toThrow(/cancelled|abort/i)
    expect(noDispatch).not.toHaveBeenCalled()
  })

  it('rejects a narrowed persisted nonterminal scope before model dispatch', async () => {
    const options = await fixture(false)
    const target = { kind: 'commit' as const, target: options.commit }
    const snapshot = await createGitSnapshot(options.root, target)
    const repository = new TaskRepository(options.root)
    const taskId = 'narrowed-scope'
    let state = await repository.createReview({ schemaVersion: 1, id: taskId, target, snapshot, scope: [], dataClass: 'public', createdAt: new Date().toISOString() })
    state = await repository.advanceReview(taskId, state.revision, 'SNAPSHOT')
    await repository.classifyReviewScope(taskId, state.revision, [{ path: 'calc.mjs', status: 'M' }])
    const path = join(options.root, '.agent/reviews', taskId, 'TASK.json')
    const task = await repository.readReview(taskId)
    await writeFile(path, JSON.stringify({ ...task, scope: [] }))
    const noDispatch = vi.fn(async () => { throw new Error('Narrowed persisted scope reached a model') })
    await expect(runEngineeringReview({ ...options, taskId, target, executeRole: noDispatch })).rejects.toThrow(/scope.*(match|snapshot|changed)|changed.*scope/i)
    expect(noDispatch).not.toHaveBeenCalled()
  })

  it('accepts a valid finding on an added source line that starts with two plus signs', async () => {
    const options = await fixture(false)
    await writeFile(join(options.root, 'increment.mjs'), 'let counter = 0\n++counter\nexport { counter }\n')
    await execa('git', ['add', 'increment.mjs'], { cwd: options.root })
    await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'counter increment'], { cwd: options.root })
    const commit = (await execa('git', ['rev-parse', 'HEAD'], { cwd: options.root })).stdout
    const oracle = await execa(process.execPath, ['--input-type=module', '-e', 'const m = await import(process.argv[1]); console.log(m.counter)', pathToFileURL(join(options.root, 'increment.mjs')).href])
    expect(oracle.stdout).toBe('1')
    const result = await runEngineeringReview({ ...options, target: { kind: 'commit', target: commit }, executeRole: async input => {
      const evidence = input.reviewEvidence
      if (evidence === undefined) throw new Error('Missing trusted evidence')
      const show = await evidence.show({ path: 'increment.mjs' })
      const diff = await evidence.diff({ path: 'increment.mjs' })
      expect(diff.text).toContain('\n+++counter\n')
      const ids = [show.evidenceId, diff.evidenceId]
      return { summary: 'Counter increment before requested action', findings: [{ severity: 'medium', description: 'Import increments the counter before a caller requests it', path: 'increment.mjs', commit, startLine: 2, endLine: 2,
        failureCondition: 'Importing the module returns counter 1 while initialization requires 0', changeRelation: 'The new prefix increment executes during module initialization', evidenceIds: ids }], inspectedEvidenceIds: ids, unresolvedQuestions: [] }
    } })
    expect(result.status, JSON.stringify(result.unresolvedQuestions)).toBe('REVIEW_COMPLETE')
    expect(result.findings).toHaveLength(1)
  })

  it('resumes the original task snapshot after branch movement and rejects a conflicting selector', async () => {
    const options = await fixture(false)
    const first = await runEngineeringReview({ ...options, target: { kind: 'branch', target: 'refs/heads/main' }, executeRole: async input => ({ summary: 'Pinned source inspected', findings: [], inspectedEvidenceIds: await inspected(input), unresolvedQuestions: [] }) })
    await writeFile(join(options.root, 'calc.mjs'), defective)
    await execa('git', ['add', 'calc.mjs'], { cwd: options.root })
    await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'branch moved after completion'], { cwd: options.root })
    const movedCommit = (await execa('git', ['rev-parse', 'HEAD'], { cwd: options.root })).stdout
    const noDispatch = vi.fn(async () => { throw new Error('Completed review dispatched again') })
    const resumed = await runEngineeringReview({ ...options, taskId: first.taskId, target: { kind: 'branch', target: 'refs/heads/main' }, executeRole: noDispatch })
    expect(resumed).toEqual(first)
    expect(resumed.snapshot.targetCommit).toBe(options.commit)
    await expect(runEngineeringReview({ ...options, taskId: first.taskId, target: { kind: 'commit', target: movedCommit }, executeRole: noDispatch })).rejects.toThrow(/different Git target|selector|pinned/)
    expect(noDispatch).not.toHaveBeenCalled()
  })

  it('persists uncertain review cleanup and blocks Development dispatch while child work remains live', async () => {
    const options = await fixture(false)
    const stop = deferred()
    let backgroundLive = true
    const stopped = stop.promise.then(() => { backgroundLive = false })
    try {
      const result = await runEngineeringReview({ ...options, target: { kind: 'commit', target: options.commit }, executeRole: async input => collectRole({
        id: SessionId('uncertain-review-child'), localAgent: undefined,
        result: Promise.resolve({ stopReason: 'completed', output: [], structured: { summary: 'Child result returned before owned work stopped', findings: [], inspectedEvidenceIds: [], unresolvedQuestions: [] } }),
        async dispose() { if (backgroundLive) throw new Error('Review command termination is uncertain') },
      }, 'reviewer', input.route.provider, input.route.model, input.signal) })
      expect(result.status, JSON.stringify(result.unresolvedQuestions)).toBe('BLOCKED')
      expect(result.state).toMatchObject({ state: 'BLOCKED', writer: null, requiresStopConfirmation: true })
      const state = JSON.parse(await readFile(join(options.root, '.agent/reviews', result.taskId, 'STATE.json'), 'utf8'))
      expect(state).toMatchObject({ state: 'BLOCKED', requiresStopConfirmation: true })
      const noDispatch = vi.fn(async () => { throw new Error('Development started while review work remained live') })
      await expect(runEngineeringTask({ ...options, request: 'Make a source change', executeRole: noDispatch })).rejects.toThrow(/confirm|stopped|uncertain/i)
      expect(noDispatch).not.toHaveBeenCalled()
      expect(backgroundLive).toBe(true)
      await expect(recoverEngineeringTask(options.root, result.taskId, false)).rejects.toThrow(/confirm|stopped/i)
      const before = await getEngineeringStatus(options.root, result.taskId)
      expect(before.reviews?.[0]?.state).toMatchObject({ state: 'BLOCKED', requiresStopConfirmation: true })
      stop.resolve()
      await stopped
      const recovered = await recoverEngineeringTask(options.root, result.taskId, true)
      expect(recovered.writer).toBeNull()
      expect('requiresStopConfirmation' in recovered && recovered.requiresStopConfirmation).not.toBe(true)
      const after = await getEngineeringStatus(options.root, result.taskId)
      expect(after.reviews?.[0]?.task.snapshot).toEqual(result.snapshot)
      const resumed = await runEngineeringReview({ ...options, taskId: result.taskId, target: { kind: 'commit', target: options.commit }, executeRole: async input => ({ summary: 'Recovered review inspected', findings: [], inspectedEvidenceIds: await inspected(input), unresolvedQuestions: [] }) })
      expect(resumed.status).toBe('REVIEW_COMPLETE')
      expect(resumed.snapshot).toEqual(result.snapshot)
    } finally {
      stop.resolve()
      await stopped
      expect(backgroundLive).toBe(false)
    }
  })

  it('pins branch evidence before the branch moves during review', async () => {
    const options = await fixture()
    const entered = deferred()
    const moved = deferred()
    const seen: string[] = []
    const pending = runEngineeringReview({ ...options, target: { kind: 'branch', target: 'refs/heads/main' }, executeRole: async input => {
      const snapshot = input.context.reviewSnapshot
      if (typeof snapshot !== 'object' || snapshot === null || !('targetCommit' in snapshot) || typeof snapshot.targetCommit !== 'string') throw new Error('Review lacks snapshot')
      seen.push(snapshot.targetCommit)
      entered.resolve()
      await moved.promise
      const ids = await inspected(input)
      return { summary: 'Pinned defect review', findings: [finding(options.commit, ids)], inspectedEvidenceIds: ids, unresolvedQuestions: [] }
    } })
    try {
      await entered.promise
      await writeFile(join(options.root, 'calc.mjs'), clean)
      await execa('git', ['add', 'calc.mjs'], { cwd: options.root })
      await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'branch moved'], { cwd: options.root })
      expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: options.root })).stdout).not.toBe(options.commit)
      moved.resolve()
      const result = await pending
      expect(result.status, JSON.stringify(result.unresolvedQuestions)).toBe('REVIEW_COMPLETE')
      expect(result.snapshot.targetCommit).toBe(options.commit)
      expect(result.findings[0]?.commit).toBe(options.commit)
      expect(seen).toEqual([options.commit])
    } finally {
      moved.resolve()
      await Promise.allSettled([pending])
    }
  })
})
