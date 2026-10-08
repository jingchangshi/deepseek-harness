import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { dump } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { getEngineeringStatus, recoverEngineeringTask, runEngineeringTask } from '../src/automatic.ts'
import { loadHarnessConfig, resolveRoleRoute } from '../src/config.ts'
import { RoleInvocationError } from '../src/role-execution.ts'
import { TaskRepository } from '../src/repository.ts'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lifecycle-budget-'))
  roots.push(root)
  await cp(resolve('.agent'), join(root, '.agent'), { recursive: true, filter: source => !source.includes(join('.agent', 'tasks')) && !source.includes(join('.agent', 'reviews')) })
  await writeFile(join(root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 40, maxRoleCalls: 6, commandTimeoutMs: 30_000 }))
  await writeFile(join(root, '.agent/adapters/test.yaml'), dump({ adapters: Object.fromEntries(['unit', 'typecheck', 'build'].map(name => [name, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }])) }))
  await execa('git', ['init', '-q'], { cwd: root })
  await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root })
  return { root, deployment: await loadHarnessConfig(root, { env: {} }) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('task lifecycle budgets', () => {
  it.each(['cost-pending', 'inconsistent-total', 'missing-cache-total'] as const)('does not turn %s usage into a free provider allowance', async scenario => {
    const options = await fixture()
    const repository = new TaskRepository(options.root)
    await repository.createTask({ schemaVersion: 1, id: 'usage', title: 'Keep incomplete usage unknown', profile: 'small-feature', dataClass: 'public', createdAt: '2026-10-08T00:00:00.000Z' })
    const limits = { maxProviderRequests: 3, ...scenario === 'cost-pending' ? { maxKnownCostUsd: 1 } : { maxTotalTokens: 100 } }
    const ledger = await repository.initializeLifecycle('usage', 'development', limits)
    const invocation = await ledger.reserveInvocation('scout-primary')
    const route = resolveRoleRoute(options.deployment, 'scout-primary')
    const attempt = await ledger.reserveAttempt(invocation, route)
    const details = { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' as const }
    await ledger.reserveProviderRequest(attempt, 'first', details)
    if (scenario === 'inconsistent-total') await expect(ledger.recordUsage('first', { inputTokens: 10, outputTokens: 5, totalTokens: 0 })).rejects.toThrow(/usage|token|total|invalid/i)
    if (scenario === 'missing-cache-total') {
      await ledger.recordUsage('first', { inputTokens: 10, outputTokens: 5 })
      expect((await ledger.read()).unknownUsage).toBe(true)
    }
    await expect(ledger.reserveProviderRequest(attempt, 'second', details)).rejects.toThrow(/budget|unknown|pending|token|cost/i)
  })

  it.each(['elapsed', 'provider', 'tool'] as const)('preserves historical %s uncertainty rather than granting a fresh allowance', async dimension => {
    const options = await fixture()
    const repository = new TaskRepository(options.root, undefined, { now: () => '2026-10-08T01:00:00.000Z' })
    await repository.createTask({ schemaVersion: 1, id: 'old', title: 'Historical task', profile: 'small-feature', dataClass: 'public', createdAt: '2026-10-08T00:00:00.000Z' })
    const limits = { maxLogicalInvocations: 10, maxModelAttempts: 10, ...dimension === 'elapsed' ? { maxElapsedMs: 1000 } : {}, ...dimension === 'provider' ? { maxProviderRequests: 10 } : {}, ...dimension === 'tool' ? { maxToolCalls: 10 } : {} }
    const ledger = await repository.lifecycle('old', 'development', limits)
    if (dimension === 'elapsed') {
      await expect(ledger.reserveInvocation('scout-primary')).rejects.toThrow(/elapsed|budget/i)
      return
    }
    const invocation = await ledger.reserveInvocation('scout-primary')
    const route = resolveRoleRoute(options.deployment, 'scout-primary')
    const attempt = await ledger.reserveAttempt(invocation, route)
    if (dimension === 'provider') await expect(ledger.reserveProviderRequest(attempt, 'new-request', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' })).rejects.toThrow(/history|unknown|budget/i)
    if (dimension === 'tool') await expect(ledger.reserveToolCall(attempt, 'new-execution')).rejects.toThrow(/history|unknown|budget/i)
  })

  it('validates persisted inspection execution identities against their owning attempt', async () => {
    const options = await fixture()
    const repository = new TaskRepository(options.root)
    await repository.createTask({ schemaVersion: 1, id: 'identity', title: 'Bind inspection ownership', profile: 'small-feature', dataClass: 'public', createdAt: '2026-10-08T00:00:00.000Z' })
    const ledger = await repository.initializeLifecycle('identity', 'development', {})
    const route = resolveRoleRoute(options.deployment, 'scout-primary')
    const first = await ledger.reserveAttempt(await ledger.reserveInvocation('scout-primary'), route)
    const second = await ledger.reserveAttempt(await ledger.reserveInvocation('scout-secondary'), { ...route, role: 'scout-secondary' })
    await ledger.reserveToolCall(first, 'owned-inspection')
    const reopened = await repository.lifecycle('identity', 'development', {})
    await expect(reopened.validateInspection([first], 'owned-inspection')).resolves.toBe(true)
    await expect(reopened.validateInspection([second], 'owned-inspection')).resolves.toBe(false)
    await expect(reopened.validateInspection([first], 'invented-execution')).resolves.toBe(false)
    await expect(reopened.validateInspection(['invented-attempt'], 'owned-inspection')).resolves.toBe(false)
  })

  it('persists disjoint invocation, attempt, provider and tool counts across repository instances', async () => {
    const options = await fixture()
    const repository = new TaskRepository(options.root)
    await repository.createTask({ schemaVersion: 1, id: 'ledger', title: 'Count actual scheduling', profile: 'small-feature', dataClass: 'public', createdAt: '2026-10-08T00:00:00.000Z' })
    const limits = { maxLogicalInvocations: 2, maxModelAttempts: 3, maxProviderRequests: 3, maxToolCalls: 2, maxElapsedMs: 60_000 }
    const ledger = await repository.initializeLifecycle('ledger', 'development', limits)
    const invocation = await ledger.reserveInvocation('scout-primary')
    const route = resolveRoleRoute(options.deployment, 'scout-primary')
    const first = await ledger.reserveAttempt(invocation, route)
    const second = await ledger.reserveAttempt(invocation, { ...route, routeId: 'fallback', model: 'fallback-model' })
    const details = { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' as const }
    await ledger.reserveProviderRequest(first, 'request-1', details)
    await ledger.reserveProviderRequest(first, 'request-1', details)
    await ledger.recordUsage('request-1', { inputTokens: 8, outputTokens: 2, totalTokens: 13, cacheReadTokens: 3 })
    await ledger.recordUsage('request-1', { inputTokens: 8, outputTokens: 2, totalTokens: 13, cacheReadTokens: 3 })
    await ledger.reserveProviderRequest(second, 'request-2', { ...details, model: 'fallback-model', routeId: 'fallback', purpose: 'compaction' })
    await ledger.reserveToolCall(first, 'child-1/1/call-1')
    await ledger.reserveToolCall(first, 'child-1/1/call-1')
    await ledger.reserveToolCall(second, 'child-2/1/call-1')
    const reopened = await new TaskRepository(options.root).lifecycle('ledger', 'development', limits)
    expect((await reopened.read()).counts).toMatchObject({ logicalInvocations: 1, modelAttempts: 2, providerRequests: 2, toolCalls: 2, totalTokens: 13 })
    await expect(reopened.reserveToolCall(second, 'child-2/2/call-1')).rejects.toThrow(/budget/i)
    await expect(reopened.reserveProviderRequest(first, 'request-1', { ...details, model: 'conflicting-model' })).rejects.toThrow(/conflict|mismatch/i)
    expect((await reopened.read()).counts.toolCalls).toBe(2)
  })

  it.each(['logical', 'attempt', 'provider', 'tool', 'elapsed', 'tokens', 'cost'] as const)('denies new scheduling after the %s ceiling', async dimension => {
    const options = await fixture()
    let now = Date.parse('2026-10-08T00:00:00.000Z')
    const repository = new TaskRepository(options.root, undefined, { now: () => new Date(now).toISOString() })
    await repository.createTask({ schemaVersion: 1, id: 'bounded', title: 'Stop at a durable ceiling', profile: 'small-feature', dataClass: 'public', createdAt: new Date(now).toISOString() })
    const limits = { maxLogicalInvocations: 1, maxModelAttempts: 1, maxProviderRequests: ['tokens', 'cost'].includes(dimension) ? 2 : 1, maxToolCalls: 1, maxElapsedMs: 1000, ...dimension === 'tokens' ? { maxTotalTokens: 10 } : {}, ...dimension === 'cost' ? { maxKnownCostUsd: 1 } : {} }
    const ledger = await repository.initializeLifecycle('bounded', 'development', limits)
    const route = resolveRoleRoute(options.deployment, 'scout-primary')
    const invocation = await ledger.reserveInvocation('scout-primary')
    const attempt = await ledger.reserveAttempt(invocation, route)
    const details = { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' as const }
    if (dimension === 'logical') await expect(ledger.reserveInvocation('reviewer')).rejects.toThrow(/budget/i)
    if (dimension === 'attempt') await expect(ledger.reserveAttempt(invocation, route)).rejects.toThrow(/budget/i)
    if (dimension === 'provider') {
      await ledger.reserveProviderRequest(attempt, 'request-1', details)
      await expect(ledger.reserveProviderRequest(attempt, 'request-2', details)).rejects.toThrow(/budget/i)
    }
    if (dimension === 'tool') {
      await ledger.reserveToolCall(attempt, 'execution-1')
      await expect(ledger.reserveToolCall(attempt, 'execution-2')).rejects.toThrow(/budget/i)
    }
    if (dimension === 'elapsed') {
      now += 1001
      await expect(ledger.reserveProviderRequest(attempt, 'request-1', details)).rejects.toThrow(/budget/i)
    }
    if (dimension === 'tokens') {
      await ledger.reserveProviderRequest(attempt, 'request-1', details)
      await ledger.recordUsage('request-1', { inputTokens: 7, outputTokens: 3, totalTokens: 10 })
      await expect(ledger.reserveProviderRequest(attempt, 'request-2', details)).rejects.toThrow(/budget|token/i)
    }
    if (dimension === 'cost') {
      await ledger.reserveProviderRequest(attempt, 'request-1', details)
      await ledger.recordUsage('request-1', { inputTokens: 1, outputTokens: 1 })
      await expect(ledger.reserveProviderRequest(attempt, 'request-2', details)).rejects.toThrow(/budget|unknown|cost/i)
    }
  })

  it('serializes concurrent reservations and rejects durable task identity substitution', async () => {
    const options = await fixture()
    const repository = new TaskRepository(options.root)
    await repository.createTask({ schemaVersion: 1, id: 'race', title: 'Reserve a single slot', profile: 'small-feature', dataClass: 'public', createdAt: '2026-10-08T00:00:00.000Z' })
    const limits = { maxLogicalInvocations: 1, maxModelAttempts: 2, maxProviderRequests: 2, maxToolCalls: 2, maxElapsedMs: 60_000 }
    const ledger = await repository.initializeLifecycle('race', 'development', limits)
    const contenders = await Promise.allSettled([ledger.reserveInvocation('scout-primary'), ledger.reserveInvocation('scout-secondary')])
    expect(contenders.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(contenders.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await ledger.read()).counts.logicalInvocations).toBe(1)
    const path = join(options.root, '.agent/tasks/race/LIFECYCLE.json')
    const document = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, `${JSON.stringify({ ...document, taskId: 'another-task' })}\n`)
    await expect(ledger.read()).rejects.toThrow(/identity|task|mismatch/i)
  })

  it('retains known historical consumption and stops token-limited scheduling when usage is unknown', async () => {
    const options = await fixture()
    const repository = new TaskRepository(options.root, undefined, { now: () => '2026-10-08T00:00:01.000Z' })
    await repository.createTask({ schemaVersion: 1, id: 'historical', title: 'Recover a pre-ledger task', profile: 'small-feature', dataClass: 'public', createdAt: '2026-10-08T00:00:00.000Z' })
    await writeFile(join(options.root, '.agent/tasks/historical/AUTO.json'), `${JSON.stringify({ schemaVersion: 1, requests: ['Historical request'], steps: 4, roleCalls: 4, pendingTask: null, completedWriterRevision: null, verifiedTreeHash: null })}\n`)
    const limits = { maxLogicalInvocations: 10, maxModelAttempts: 10, maxProviderRequests: 10, maxToolCalls: 10, maxElapsedMs: 60_000, maxTotalTokens: 1000 }
    await expect(repository.initializeLifecycle('historical', 'development', limits)).rejects.toThrow(/histor|consum|initial|attempt/i)
    const ledger = await repository.lifecycle('historical', 'development', limits)
    expect((await ledger.read()).counts.logicalInvocations).toBe(4)
    const invocation = await ledger.reserveInvocation('scout-primary')
    const route = resolveRoleRoute(options.deployment, 'scout-primary')
    const attempt = await ledger.reserveAttempt(invocation, route)
    await expect(ledger.reserveProviderRequest(attempt, 'historical-resume', { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' })).rejects.toThrow(/unknown|token|budget/i)
  })

  it('blocks another token-limited request while the first request has no settled usage', async () => {
    const options = await fixture()
    const repository = new TaskRepository(options.root)
    await repository.createTask({ schemaVersion: 1, id: 'pending', title: 'Bound concurrent unknown usage', profile: 'small-feature', dataClass: 'public', createdAt: '2026-10-08T00:00:00.000Z' })
    const limits = { maxLogicalInvocations: 2, maxModelAttempts: 2, maxProviderRequests: 2, maxToolCalls: 2, maxElapsedMs: 60_000, maxTotalTokens: 1000 }
    const ledger = await repository.initializeLifecycle('pending', 'development', limits)
    const invocation = await ledger.reserveInvocation('scout-primary')
    const route = resolveRoleRoute(options.deployment, 'scout-primary')
    const attempt = await ledger.reserveAttempt(invocation, route)
    const details = { provider: route.provider, model: route.model, routeId: route.routeId, purpose: 'agent' as const }
    await ledger.reserveProviderRequest(attempt, 'pending-first', details)
    await expect(ledger.reserveProviderRequest(attempt, 'pending-second', details)).rejects.toThrow(/unknown|pending|token|budget/i)
    await ledger.recordUsage('pending-first', { inputTokens: 3, outputTokens: 2, totalTokens: 5 })
    await expect(ledger.reserveProviderRequest(attempt, 'pending-second', details)).resolves.toBeUndefined()
    expect((await ledger.read()).counts.providerRequests).toBe(2)
  })

  it('does not grant new logical role calls after exhaustion and repeated recovery', async () => {
    const options = await fixture()
    const calls: string[] = []
    const first = await runEngineeringTask({ ...options, request: 'Clarify a bounded source change', executeRole: async ({ role }) => {
      calls.push(role)
      if (role.startsWith('scout-')) return { findings: ['The fixture has no product source'], hypotheses: [{ statement: 'Specify a source file', evidence: ['Fixture repository'] }], unresolvedAssumptions: [] }
      if (role === 'architect') return {
        problemStatement: 'Specify the target', hypotheses: ['A target is required'], selectedApproach: 'Clarify the target',
        rejectedAlternatives: ['Write an arbitrary file'], invariants: ['Keep existing files intact'], expectedComponents: ['answer.txt'],
        implementationScope: ['answer.txt'], falsificationTests: ['Reject unspecified target'], acceptanceGates: ['unit'], unresolvedAssumptions: [],
      }
      if (role === 'challenger') return { decision: 'REVISE', summary: 'The target needs clarification', findings: ['Specify the target'] }
      throw new Error(`Unexpected role ${role}`)
    } }).then(result => ({ result }), error => ({ error }))
    if ('error' in first) {
      if (!(first.error instanceof Error)) throw first.error
      expect(first.error.message).toContain('role-call budget exhausted')
    } else expect.soft(first.result.status).toBe('BUDGET_EXHAUSTED')
    expect(calls).toHaveLength(6)
    const stored = (await getEngineeringStatus(options.root)).tasks[0]
    if (stored === undefined) throw new Error('Exhausted task was not persisted')
    expect(stored.state.writer).toBeNull()
    for (let recovery = 0; recovery < 2; recovery++) {
      await recoverEngineeringTask(options.root, stored.task.id, false)
      const additionalCalls: string[] = []
      const resumed = await runEngineeringTask({ ...options, taskId: stored.task.id, request: '', executeRole: async ({ role }) => {
        additionalCalls.push(role)
        throw new RoleInvocationError('An exhausted task dispatched another model', 'NON_FALLBACKABLE', false)
      } })
      expect.soft(additionalCalls).toEqual([])
      expect.soft(resumed.status).toBe('BUDGET_EXHAUSTED')
      expect.soft(resumed.state?.writer).toBeNull()
    }
  })
})
