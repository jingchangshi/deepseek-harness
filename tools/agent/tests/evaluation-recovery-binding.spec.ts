import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EngineeringRoleFailure } from '../src/automatic.ts'
import type { RoleExecutor } from '../src/automatic.ts'
import { createProductionEngineeringBindings, InjectedBeforeWriteFailure, runEngineeringBenchmark } from '../src/benchmark.ts'
import type { EngineeringStageReceipt } from '../src/benchmark.ts'
import { RoleQuiescenceError } from '../src/role-execution.ts'
import { createDirectEngineeringInvoker } from '../src/benchmark-direct.ts'
import { loadHarnessConfig } from '../src/config.ts'
import { createEngineeringEvaluationCases, engineeringEvaluationOracle, engineeringFirstImplementationOracle, evaluationReviewTarget, prepareEngineeringEvaluationRepository } from '../src/evaluation-fixtures.ts'
import { TaskRepository } from '../src/repository.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) }, 30_000)

describe('adaptive recovery evaluation binding', () => {
  it.each(['injected', 'ordinary', 'uncertain', 'repeated-injection', 'injected-then-uncertain'] as const)('recovers only the named stopped fixture injection and preserves other failures (%s)', async failure => {
    const checkout = process.cwd()
    const testCase = (await createEngineeringEvaluationCases(checkout)).find(item => item.id === 'recovery-latch')!
    let root = await mkdtemp(join(tmpdir(), 'dsh-recovery-binding-'))
    roots.push(root)
    await testCase.run(root)
    await prepareEngineeringEvaluationRepository(testCase, root, checkout)
    for (const name of await readdir(join(checkout, '.agent/config'))) {
      if (name !== 'project.yaml' && name.endsWith('.yaml')) await cp(join(checkout, '.agent/config', name), join(root, '.agent/config', name))
    }
    const deployment = await loadHarnessConfig(root, { env: {} })
    const taskIds = new Set<string>()
    let writerCalls = 0
    let roleCalls = 0
    let firstFailureLogicalInvocations = 0
    const executeRole: RoleExecutor = async input => {
      taskIds.add(input.taskId)
      roleCalls += 1
      const control = input.executionControl
      if (control === undefined) throw new Error('production binding requires durable role accounting')
      const requestId = `recovery-provider-${control.attemptId}`
      await control.lifecycle.reserveProviderRequest(control.attemptId, requestId, { provider: input.route.provider, model: input.route.model, routeId: input.route.routeId, purpose: 'agent' })
      await control.lifecycle.settleProviderRequest(requestId, { startedAt: control.startedAt, endedAt: new Date().toISOString(), outcome: 'SUCCESS', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } })
      if (input.role === 'implementer') {
        writerCalls += 1
        if (writerCalls === 1 || failure === 'repeated-injection' || failure === 'injected-then-uncertain') {
          expect(await engineeringFirstImplementationOracle(testCase, root)).toBe(false)
          if (writerCalls === 1) firstFailureLogicalInvocations = (await control.lifecycle.read()).counts.logicalInvocations
          if (failure === 'injected' || failure === 'repeated-injection' || failure === 'injected-then-uncertain' && writerCalls === 1) throw new InjectedBeforeWriteFailure()
          if (failure === 'uncertain' || failure === 'injected-then-uncertain') throw new RoleQuiescenceError('Writer termination is uncertain')
          throw new EngineeringRoleFailure('Ordinary role failure requires operator recovery')
        }
        input.markMutationStarted?.()
        await writeFile(join(root, 'answer.txt'), '42\n')
        return { summary: 'Wrote the requested answer after recovery.' }
      }
      if (input.role === 'architect') return { problemStatement: testCase.request, hypotheses: ['The specified file satisfies the request'], selectedApproach: 'Write 42 and a newline', rejectedAlternatives: ['Skip the output'], invariants: ['Only answer.txt changes'], expectedComponents: ['answer.txt'], implementationScope: ['answer.txt'], falsificationTests: [testCase.criteria], acceptanceGates: ['evaluation-oracle'], unresolvedAssumptions: [] }
      if (input.role === 'challenger') return { decision: 'ACCEPT', summary: 'The plan matches the request.', findings: [] }
      if (input.role === 'reviewer') return { decision: 'ACCEPT', summary: 'The requested answer passed verification.', findings: [] }
      return { findings: ['answer.txt is the requested file'], hypotheses: [{ statement: 'Writing 42 satisfies the request', evidence: ['request'] }], unresolvedAssumptions: [] }
    }
    const direct = createDirectEngineeringInvoker({ deployment, executeRole, verify: engineeringFirstImplementationOracle, reviewTarget: evaluationReviewTarget })
    const bindings = createProductionEngineeringBindings({
      deployment, strongRouteId: deployment.roles.architect!.route, cheapRouteId: deployment.roles.implementer!.route,
      roleExecutorForCase: () => executeRole, direct,
      verifySingle: (testCase, root) => direct.invokeFixedStage({ stage: 'VERIFICATION', request: testCase.request, root, readOnly: true, testCase }),
      firstImplementationOracle: engineeringFirstImplementationOracle, reviewTarget: evaluationReviewTarget,
    })
    let receipts: EngineeringStageReceipt[] = []
    const uncertain = failure === 'uncertain' || failure === 'injected-then-uncertain'
    if (failure === 'injected-then-uncertain') {
      const benchmark = await runEngineeringBenchmark({
        cases: [{ ...testCase, run: async cwd => { await testCase.run(cwd); root = cwd; roots.push(cwd) } }],
        strategies: [{ id: 'D_ADAPTIVE' }], mode: 'OFFLINE_SYNTHETIC',
        executor: {
          run: async (...args) => {
            await prepareEngineeringEvaluationRepository(testCase, root, checkout)
            for (const name of await readdir(join(checkout, '.agent/config'))) {
              if (name !== 'project.yaml' && name.endsWith('.yaml')) await cp(join(checkout, '.agent/config', name), join(root, '.agent/config', name))
            }
            return bindings.run(...args)
          },
          report: (...args) => bindings.report!(...args),
        }, oracle: engineeringEvaluationOracle,
      })
      expect(benchmark.results[0]).toMatchObject({ status: 'UNCERTAIN', fixturePath: root })
      expect(await readdir(join(root, '.agent/tasks'))).toHaveLength(1)
    }
    else if (uncertain) await expect(bindings.run('D_ADAPTIVE', testCase, root)).rejects.toThrow(RoleQuiescenceError)
    else receipts = await bindings.run('D_ADAPTIVE', testCase, root)
    const report = await bindings.report?.('D_ADAPTIVE', testCase, root, receipts)
    if (failure !== 'injected') {
      expect(report).toMatchObject({ workflowStatus: uncertain ? 'UNCERTAIN' : 'BLOCKED', confirmedStopped: !uncertain, firstImplementationPass: false })
      expect(report).toHaveProperty('taskId', [...taskIds][0])
      expect(writerCalls).toBe(failure === 'repeated-injection' || failure === 'injected-then-uncertain' ? 2 : 1)
      expect(taskIds.size).toBe(1)
      expect(await engineeringEvaluationOracle(testCase, root, receipts)).toMatchObject({ accepted: false })
      const repository = new TaskRepository(root)
      const state = await repository.readState([...taskIds][0]!)
      if (uncertain) expect(state.writer).not.toBeNull()
      else expect(state.writer).toBeNull()
      if (failure === 'repeated-injection' || failure === 'injected-then-uncertain') expect(report?.usageReport?.counts.logicalInvocations).toBeGreaterThan(firstFailureLogicalInvocations)
      else expect(report?.usageReport?.counts.logicalInvocations).toBe(firstFailureLogicalInvocations)
      expect(report?.usageReport?.counts.logicalInvocations).toBe(roleCalls)
      expect((await readdir(join(root, '.agent/tasks'), { withFileTypes: true })).filter(entry => entry.isDirectory())).toHaveLength(1)
      return
    }
    expect(report).toMatchObject({ workflowStatus: 'ACCEPTED', confirmedStopped: true, firstImplementationPass: false })
    expect(writerCalls).toBe(2)
    expect(taskIds.size).toBe(1)
    expect(await readFile(join(root, 'answer.txt'), 'utf8')).toBe('42\n')
    expect(await engineeringEvaluationOracle(testCase, root, receipts)).toMatchObject({ accepted: true })
    const directories = (await readdir(join(root, '.agent/tasks'), { withFileTypes: true })).filter(entry => entry.isDirectory())
    expect(directories).toHaveLength(1)
    expect(await new TaskRepository(root).readState(directories[0]!.name)).toMatchObject({ state: 'ACCEPTED', writer: null })
    expect(receipts.filter(receipt => receipt.stage === 'IMPLEMENTER').map(receipt => receipt.outcome)).toEqual(['FAILED', 'SUCCESS'])
    expect(report?.usageReport?.counts.logicalInvocations).toBeGreaterThan(firstFailureLogicalInvocations)
    expect(report?.usageReport?.counts.logicalInvocations).toBe(roleCalls)
    expect(report?.usageReport?.counts.providerRequests).toBe(roleCalls)
    expect(report?.usageReport?.totalTokens).toMatchObject({ status: 'KNOWN', knownSubtotal: roleCalls * 5 })
  }, 30_000)
})
