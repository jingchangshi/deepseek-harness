import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { dump } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { loadHarnessConfig } from '../src/config.ts'
import { recoverEngineeringTask } from '../src/automatic.ts'
import { runEngineeringReview } from '../src/review-only.ts'
import { TaskRepository } from '../src/repository.ts'
import { RoleInvocationError } from '../src/role-execution.ts'
import type { GitEvidenceReceipt } from '../src/git-evidence.ts'
import type { RoleInvocation } from '../src/automatic.ts'

const roots: string[] = []
const sourcePaths = Array.from({ length: 5 }, (_item, index) => `src/change-${index}.mjs`)

async function fixture(maxLogicalInvocations = 30) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-checkpoints-'))
  roots.push(root)
  await cp(resolve('.agent'), join(root, '.agent'), {
    recursive: true,
    filter: source => !source.includes(join('.agent', 'tasks')),
  })
  await writeFile(join(root, '.agent/config/project.yaml'), dump({
    schemaVersion: 1,
    profile: 'small-feature',
    adapter: '.agent/adapters/test.yaml',
    dataClass: 'public',
    maxSteps: 40,
    maxRoleCalls: 30,
    commandTimeoutMs: 30_000,
  }))
  await writeFile(join(root, '.agent/adapters/test.yaml'), dump({
    adapters: Object.fromEntries(['unit', 'typecheck', 'build'].map(name => [name, {
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
    }])),
  }))
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: root })
  await mkdir(join(root, 'src'), { recursive: true })
  for (const [index, path] of sourcePaths.entries()) {
    await writeFile(join(root, path), `export const value${index} = 1\n`)
  }
  await execa('git', ['add', ...sourcePaths], { cwd: root })
  await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base'], { cwd: root })
  for (const [index, path] of sourcePaths.entries()) {
    await writeFile(join(root, path), `export const value${index} = 2\n`)
  }
  await execa('git', ['add', ...sourcePaths], { cwd: root })
  await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'review target'], { cwd: root })
  const deployment = await loadHarnessConfig(root, { env: {} })
  return {
    root,
    deployment: {
      ...deployment,
      workflow: {
        ...deployment.workflow,
        reviewMaxDirectFiles: 4,
        reviewMaxScouts: 2,
        lifecycleBudget: { ...deployment.workflow.lifecycleBudget, maxLogicalInvocations },
      },
    },
    target: { kind: 'commit' as const, target: 'HEAD' },
  }
}

function scopePaths(input: RoleInvocation): string[] {
  return scopeEntries(input).map(entry => entry.path)
}

function scopeEntries(input: RoleInvocation): Array<{ path: string; status: string }> {
  const scope = input.context.reviewScope
  if (!Array.isArray(scope)) throw new Error('Role invocation is missing its assigned review scope')
  return scope.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('path' in entry) || typeof entry.path !== 'string'
      || !('status' in entry) || typeof entry.status !== 'string') {
      throw new Error('Review scope contains an invalid path')
    }
    return { path: entry.path, status: entry.status }
  })
}

function hashJson(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('cannot hash undefined checkpoint identity')
  return createHash('sha256').update(serialized).digest('hex')
}

async function inspect(input: RoleInvocation, paths: readonly string[]): Promise<string[]> {
  const evidence = input.reviewEvidence
  if (evidence === undefined) throw new Error('Role invocation is missing its trusted Git evidence repository')
  const ids: string[] = []
  for (const path of paths) {
    const source = await evidence.show({ path })
    const diff = await evidence.diff({ path })
    for (const receipt of evidence.observedEvidence().filter(item => item.id === source.evidenceId || item.id === diff.evidenceId)) {
      if (receipt.path !== path || receipt.contentHash.length !== 64) throw new Error('Git returned invalid inspection evidence')
      ids.push(receipt.id)
      const control = input.executionControl
      if (control !== undefined) {
        await control.reserveToolCall(receipt.id)
        await control.recordInspection({
          executionId: receipt.id,
          path,
          contentHash: receipt.contentHash,
          toolName: `git_${receipt.operation}`,
        })
      }
    }
  }
  await input.executionControl?.checkpoint()
  return ids
}

async function moveBranch(root: string): Promise<void> {
  await writeFile(join(root, 'after-target.mjs'), 'export const unrelated = true\n')
  await execa('git', ['add', 'after-target.mjs'], { cwd: root })
  await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'move branch after pinned target'], { cwd: root })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('review-only incremental checkpoints', () => {
  it('recovers only a failed Scout, reuses its sibling checkpoint, and reviews the pinned complete scope', async () => {
    const options = await fixture()
    const taskId = 'scout-resume'
    const roles: string[] = []
    const roleCalls = new Map<string, number>()
    const scoutScopes = new Map<string, string[]>()
    const scoutAssignments = new Map<string, Array<{ path: string; status: string }>>()
    const observedByRoleCall = new Map<string, string[]>()
    let reviewerScope: string[] = []
    let failSecondary = true
    const executeRole = async (input: RoleInvocation) => {
      roles.push(input.role)
      const occurrence = (roleCalls.get(input.role) ?? 0) + 1
      roleCalls.set(input.role, occurrence)
      const paths = scopePaths(input)
      if (input.role.startsWith('scout-')) {
        const key = `${input.role}:${occurrence}`
        scoutScopes.set(key, paths)
        scoutAssignments.set(key, scopeEntries(input))
      }
      if (input.role === 'reviewer') reviewerScope = paths
      if (input.role === 'scout-secondary' && failSecondary) {
        failSecondary = false
        throw new RoleInvocationError('deterministic Scout failure after quiescent settlement', 'MODEL_MALFORMED_OUTPUT', false)
      }
      const ids = await inspect(input, paths)
      observedByRoleCall.set(`${input.role}:${occurrence}`, ids)
      return {
        summary: `${input.role} inspected ${paths.join(', ')}`,
        findings: [],
        inspectedEvidenceIds: ids,
        unresolvedQuestions: [],
      }
    }

    const partial = await runEngineeringReview({ ...options, taskId, executeRole })
    expect(partial.status).toBe('PARTIAL')
    expect(roles).toEqual(['scout-primary', 'scout-secondary'])
    const primaryScope = scoutScopes.get('scout-primary:1')
    const secondaryScope = scoutScopes.get('scout-secondary:1')
    const primaryAssignment = scoutAssignments.get('scout-primary:1')
    if (primaryScope === undefined || secondaryScope === undefined || primaryAssignment === undefined) {
      throw new Error('the two Scouts did not receive their assigned review scopes')
    }
    expect(primaryScope.length).toBeGreaterThan(0)
    expect(secondaryScope.length).toBeGreaterThan(0)
    expect(new Set(primaryScope).size).toBe(primaryScope.length)
    expect(new Set(secondaryScope).size).toBe(secondaryScope.length)
    expect(primaryScope.some(path => secondaryScope.includes(path))).toBe(false)
    expect([...primaryScope, ...secondaryScope].toSorted()).toEqual(sourcePaths.toSorted())

    const repository = new TaskRepository(options.root)
    const pinnedTask = await repository.readReview(taskId)
    const checkpoint = await repository.readInvestigationCheckpoint(taskId, 'review-only', 'scout-primary')
    expect(checkpoint).toMatchObject({
      taskId,
      workflow: 'review-only',
      unitId: 'scout-primary',
      status: 'COMPLETE',
      repositorySnapshot: pinnedTask.snapshot.id,
      output: { summary: `scout-primary inspected ${primaryScope.join(', ')}` },
    })
    expect(checkpoint?.evidence.map(receipt => receipt.path).toSorted()).toEqual(primaryScope.toSorted())
    expect(checkpoint?.evidence).toHaveLength(primaryScope.length)
    expect(checkpoint?.evidence.every(receipt => /^[a-f0-9]{64}$/.test(receipt.contentHash))).toBe(true)
    expect(checkpoint).toHaveProperty('gitEvidence')
    expect(checkpoint).toHaveProperty('scopeDigest')
    expect(checkpoint).toHaveProperty('taskRevision')
    expect(checkpoint).toHaveProperty('validatedForRevision')
    const checkpointGitEvidence = (checkpoint as NonNullable<typeof checkpoint> & { gitEvidence?: GitEvidenceReceipt[] }).gitEvidence
    expect(checkpointGitEvidence).toBeDefined()
    expect(checkpointGitEvidence!.every(receipt => receipt.snapshotId === pinnedTask.snapshot.id)).toBe(true)
    expect(checkpointGitEvidence!.map(receipt => receipt.operation).toSorted()).toEqual(
      primaryScope.flatMap(() => ['diff', 'show']).toSorted(),
    )
    expect(checkpointGitEvidence!.every(receipt => receipt.path !== undefined && /^[a-f0-9]{64}$/.test(receipt.contentHash))).toBe(true)
    const primaryEvidenceIds = observedByRoleCall.get('scout-primary:1')
    if (primaryEvidenceIds === undefined) throw new Error('Scout A did not retain its actual Git evidence IDs')
    expect(checkpointGitEvidence!.map(receipt => receipt.id).toSorted()).toEqual(primaryEvidenceIds.toSorted())
    expect(checkpoint!.scopeDigest).toBe(hashJson([pinnedTask.snapshot.id, 'scout-primary', primaryAssignment]))
    expect(Number.isSafeInteger(checkpoint!.taskRevision)).toBe(true)
    expect(Number.isSafeInteger(checkpoint!.validatedForRevision)).toBe(true)

    await moveBranch(options.root)
    const recovered = await recoverEngineeringTask(options.root, taskId, false)
    expect(recovered).toMatchObject({ state: 'REVIEW_INVESTIGATION', writer: null })
    const result = await runEngineeringReview({ ...options, taskId, executeRole })

    expect(result.status, JSON.stringify(result.unresolvedQuestions)).toBe('REVIEW_COMPLETE')
    expect(result.snapshot).toEqual(pinnedTask.snapshot)
    expect(result.snapshot.targetCommit).toBe(pinnedTask.snapshot.targetCommit)
    expect(roles).toEqual(['scout-primary', 'scout-secondary', 'scout-secondary', 'reviewer'])
    expect(scoutScopes.get('scout-primary:1')).toEqual(primaryScope)
    expect(scoutScopes.get('scout-secondary:2')).toEqual(secondaryScope)
    expect(reviewerScope.toSorted()).toEqual(sourcePaths.toSorted())
    const reviewerReceipts = result.evidence.filter(receipt => receipt.operation === 'show' || receipt.operation === 'diff')
    expect(new Set(reviewerReceipts.map(receipt => receipt.path)).size).toBe(sourcePaths.length)
    expect(reviewerReceipts.every(receipt => receipt.snapshotId === pinnedTask.snapshot.id)).toBe(true)
    expect(result.findings).toEqual([])
    expect(result.state.writer).toBeNull()
    expect((await repository.readReview(taskId)).snapshot).toEqual(pinnedTask.snapshot)
    expect((await repository.readInvestigationCheckpoint(taskId, 'review-only', 'scout-primary'))?.validatedForRevision)
      .toBe(recovered.revision)
  })

  it('restores partial Git pages into the resumed Scout context for citation', async () => {
    const options = await fixture()
    const taskId = 'partial-scout-page-resume'
    const roles: string[] = []
    let restoredId: string | undefined
    let resumedScoutCitations: string[] = []
    let failAfterPage = true
    const executeRole = async (input: RoleInvocation) => {
      roles.push(input.role)
      const paths = scopePaths(input)
      if (input.role === 'scout-secondary' && failAfterPage) {
        failAfterPage = false
        const evidence = input.reviewEvidence
        const control = input.executionControl
        if (evidence === undefined || control === undefined) throw new Error('Scout is missing trusted Git evidence controls')
        const page = await evidence.show({ path: paths[0]! })
        const receipt = evidence.observedEvidence().find(item => item.id === page.evidenceId)
        if (receipt === undefined) throw new Error('Git page did not produce a durable receipt')
        restoredId = receipt.id
        await control.reserveToolCall(receipt.id)
        await control.recordInspection({ executionId: receipt.id, path: paths[0]!, contentHash: receipt.contentHash, toolName: 'git_show' })
        throw new RoleInvocationError('Scout failed after acquiring one Git page', 'MODEL_MALFORMED_OUTPUT', false)
      }
      const partial = input.context.partialInvestigationEvidence
      const partialReceipts = Array.isArray(partial) ? partial as GitEvidenceReceipt[] : []
      if (input.role === 'scout-secondary' && roles.filter(role => role === 'scout-secondary').length > 1) {
        expect(restoredId).toBeDefined()
        expect(partialReceipts.map(receipt => receipt.id)).toContain(restoredId)
      }
      const ids = await inspect(input, paths)
      const citedIds = [...new Set([...partialReceipts.map(receipt => receipt.id), ...ids])]
      if (input.role === 'scout-secondary' && roles.filter(role => role === 'scout-secondary').length > 1) resumedScoutCitations = citedIds
      return {
        summary: `${input.role} inspected ${paths.join(', ')}`,
        findings: [],
        inspectedEvidenceIds: citedIds,
        unresolvedQuestions: [],
      }
    }

    const partial = await runEngineeringReview({ ...options, taskId, executeRole })
    expect(partial.status).toBe('PARTIAL')
    expect(restoredId).toBeDefined()
    const partialCheckpoint = await new TaskRepository(options.root).readInvestigationCheckpoint(taskId, 'review-only', 'scout-secondary')
    expect(partialCheckpoint).toMatchObject({ status: 'PARTIAL', output: null })
    expect(partialCheckpoint?.gitEvidence?.map(receipt => receipt.id)).toContain(restoredId)

    await recoverEngineeringTask(options.root, taskId, false)
    const result = await runEngineeringReview({ ...options, taskId, executeRole })
    expect(result.status, JSON.stringify(result.unresolvedQuestions)).toBe('REVIEW_COMPLETE')
    expect(roles).toEqual(['scout-primary', 'scout-secondary', 'scout-secondary', 'reviewer'])
    expect(resumedScoutCitations).toContain(restoredId)
    expect(new Set(result.evidence.map(receipt => receipt.id)).size).toBe(result.evidence.length)
  })

  it('does not renew an exhausted review invocation budget during recovery', async () => {
    const options = await fixture(1)
    const taskId = 'scout-budget'
    const roles: string[] = []
    const executeRole = async (input: RoleInvocation) => {
      roles.push(input.role)
      const paths = scopePaths(input)
      const ids = await inspect(input, paths)
      return { summary: `${input.role} inspected assigned files`, findings: [], inspectedEvidenceIds: ids, unresolvedQuestions: [] }
    }

    const exhausted = await runEngineeringReview({ ...options, taskId, executeRole })
    expect(exhausted.status).toBe('BUDGET_EXHAUSTED')
    expect(roles).toEqual(['scout-primary'])
    expect(exhausted.unresolvedQuestions.join('\n')).toMatch(/budget exhausted.*logicalInvocations/i)

    const recovered = await recoverEngineeringTask(options.root, taskId, false)
    expect(recovered).toMatchObject({ state: 'REVIEW_INVESTIGATION', writer: null })
    const stillExhausted = await runEngineeringReview({ ...options, taskId, executeRole })
    expect(stillExhausted.status).toBe('BUDGET_EXHAUSTED')
    expect(roles).toEqual(['scout-primary'])
    const lifecycle = await new TaskRepository(options.root).lifecycle(taskId, 'review-only', options.deployment.workflow.lifecycleBudget)
    expect((await lifecycle.read()).counts.logicalInvocations).toBe(1)
    expect(stillExhausted.state.writer).toBeNull()
  })
})
