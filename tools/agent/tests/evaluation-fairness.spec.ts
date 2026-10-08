import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProfileEngineeringEvaluation } from '../runtime/evaluation.ts'
import { loadEngineeringProject } from '../src/automatic.ts'
import type { RoleInvocation } from '../src/automatic.ts'
import { loadHarnessConfig } from '../src/config.ts'
import { createEngineeringEvaluationCases, prepareEngineeringEvaluationRepository } from '../src/evaluation-fixtures.ts'
import { classifyEngineeringTask } from '../src/scheduling.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('registry facts shared by engineering comparison strategies', () => {
  it('gives adaptive roles the same immutable benchmark facts as fixed roles', async () => {
    const checkout = process.cwd()
    const deployment = await loadHarnessConfig(checkout, { env: {} })
    const testCase = (await createEngineeringEvaluationCases(checkout)).find(item => item.id === 'recovery-latch')!
    const invocations: RoleInvocation[] = []
    const strategyRoots: string[] = []
    const report = await runProfileEngineeringEvaluation({
      checkout, deploymentRoot: checkout, deployment, roleTimeoutMs: 30_000, caseId: testCase.id,
      strongRouteId: deployment.roles.architect!.route, cheapRouteId: deployment.roles.implementer!.route,
      withFixture: async (root, operation) => { strategyRoots.push(root); return operation() },
      executeRole: async input => {
        invocations.push(input)
        if (input.role === 'implementer') { await writeFile(join(input.root, 'answer.txt'), '42\n'); return { summary: 'Wrote answer.txt' } }
        if (input.role === 'reviewer') return { decision: 'ACCEPT', summary: 'The requested answer is present.', findings: [] }
        if (input.role === 'architect') return { problemStatement: testCase.request, hypotheses: ['The requested text is sufficient'], selectedApproach: 'Write answer.txt', rejectedAlternatives: ['Skip the output'], invariants: ['Only answer.txt changes'], expectedComponents: ['answer.txt'], implementationScope: ['answer.txt'], falsificationTests: [testCase.criteria], acceptanceGates: ['evaluation-oracle'], unresolvedAssumptions: [] }
        if (input.role === 'challenger') return { decision: 'ACCEPT', summary: 'The requested scope is bounded.', findings: [] }
        return { findings: ['answer.txt is the requested file'], hypotheses: [{ statement: 'Writing 42 satisfies the request', evidence: ['request'] }], unresolvedAssumptions: [] }
      },
    })
    roots.push(report.reportPath)
    expect(strategyRoots).toHaveLength(4)
    const fixed = invocations.filter(input => input.root === strategyRoots[2])
    const adaptive = invocations.filter(input => input.root === strategyRoots[3])
    expect(fixed.length).toBeGreaterThan(0)
    expect(adaptive.some(input => input.role === 'implementer')).toBe(true)
    const facts = { caseId: testCase.id, kind: testCase.kind, criteria: testCase.criteria, allowedPaths: testCase.allowedPaths, commandProfile: testCase.commandProfile, failureInjection: testCase.failureInjection }
    for (const invocation of [...fixed, ...adaptive]) expect(invocation.context.benchmark).toEqual(facts)
  }, 30_000)

  it.each(['pebble-mul', 'recovery-latch'])('generates explicit %s scheduling facts while preserving risk classification', async id => {
    const checkout = process.cwd()
    const deployment = await loadHarnessConfig(checkout, { env: {} })
    const testCase = (await createEngineeringEvaluationCases(checkout)).find(item => item.id === id)!
    const root = await mkdtemp(join(tmpdir(), 'dsh-fairness-scheduling-'))
    roots.push(root)
    await testCase.run(root)
    await prepareEngineeringEvaluationRepository(testCase, root, checkout)
    const project = await loadEngineeringProject(root)
    expect(project.scheduling).toMatchObject({ class: 'auto', scopePaths: testCase.allowedPaths, acceptanceCriteria: [testCase.criteria] })
    const classification = classifyEngineeringTask({ request: testCase.request, profile: project.profile, policy: project.scheduling, baselineDirty: false }, { simpleMaxFiles: deployment.workflow.simpleMaxFiles, standardMaxFiles: deployment.workflow.standardMaxFiles })
    expect(classification).toMatchObject({ taskClass: 'complex', needsInvestigation: true, needsChallenge: true, scopePaths: testCase.allowedPaths })
    expect(classification.risks).toContain(id === 'pebble-mul' ? 'compiler-ir' : 'lifecycle')
  })
})
