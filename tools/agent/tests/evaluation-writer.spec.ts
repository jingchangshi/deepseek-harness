import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEngineeringEvaluationCases,
  prepareEngineeringEvaluationRepository,
} from '../src/evaluation-fixtures.ts'
import { createDirectEngineeringInvoker } from '../src/benchmark-direct.ts'
import { createProductionEngineeringBindings } from '../src/benchmark.ts'
import { loadHarnessConfig } from '../src/config.ts'
import { RoleQuiescenceError } from '../src/role-execution.ts'
import { loadProjectVerificationConfig, loadVerificationProfile, runVerificationProfile } from '../src/verification.ts'
import type { BoundVerificationDocument, BoundPlanDocument, EvidenceDocument } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function prepared() {
  const testCase = (await createEngineeringEvaluationCases(process.cwd())).find(item => item.id === 'recovery-latch')
  if (testCase === undefined) throw new Error('missing recovery-latch evaluation case')
  const root = await mkdtemp(join(tmpdir(), 'dsh-evaluation-writer-'))
  roots.push(root)
  await testCase.run(root)
  await prepareEngineeringEvaluationRepository(testCase, root, process.cwd())
  for (const name of await readdir(join(process.cwd(), '.agent/config'))) {
    if (name !== 'project.yaml' && name.endsWith('.yaml')) await cp(join(process.cwd(), '.agent/config', name), join(root, '.agent/config', name))
  }
  return { root, testCase, deployment: await loadHarnessConfig(root, { env: {} }) }
}

function roleOutput(role: string): object {
  if (role === 'architect') return { problemStatement: 'Write answer.txt', hypotheses: ['A text file satisfies the request'], selectedApproach: 'Write 42', rejectedAlternatives: ['Skip the file'], invariants: ['Only answer.txt changes'], expectedComponents: ['answer.txt'], implementationScope: ['answer.txt'], falsificationTests: ['Check exact file content'], acceptanceGates: ['evaluation-oracle'], unresolvedAssumptions: [] }
  if (role === 'challenger') return { decision: 'ACCEPT', summary: 'The plan is bounded.', findings: [] }
  if (role === 'reviewer') return { decision: 'ACCEPT', summary: 'The requested file is correct.', findings: [] }
  if (role === 'implementer') return { summary: 'Wrote answer.txt' }
  return { findings: ['answer.txt is the requested output'], hypotheses: [{ statement: 'Write the requested value', evidence: ['request'] }], unresolvedAssumptions: [] }
}

describe('evaluation writer lease and verification boundaries', () => {
  it('has a frozen PLAN and an active writer in STATE before the model executor runs', async () => {
    const { root, testCase, deployment } = await prepared()
    const direct = createDirectEngineeringInvoker({
      deployment,
      executeRole: async input => {
        const task = join(root, '.agent', 'tasks')
        const taskIds = await readdir(task)
        const state = JSON.parse(await readFile(join(task, taskIds[0]!, 'STATE.json'), 'utf8')) as { state: string; writer: { token: string } | null }
        expect(state.state).toBe('IMPLEMENTING')
        expect(state.writer).not.toBeNull()
        expect(await readFile(join(task, taskIds[0]!, 'PLAN.json'), 'utf8')).toContain('answer.txt')
        expect(JSON.stringify({ state: input.state, context: input.context, request: input.request })).not.toContain(state.writer?.token)
        return { summary: 'Wrote answer.txt' }
      },
      verify: async () => true,
      reviewTarget: () => ({ kind: 'commit', target: testCase.seedSha }),
    })
    await direct.invoke({ routeId: deployment.roles.implementer!.route, role: 'implementer', request: testCase.request, root, readOnly: false, testCase })
  })

  it('passes the actual plan and bound command verification to fixed-stage roles', async () => {
    const { root, testCase, deployment } = await prepared()
    const seen = new Map<string, Record<string, unknown>>()
    const direct = createDirectEngineeringInvoker({
      deployment,
      executeRole: async input => { if (input.role === 'implementer') await writeFile(join(root, 'answer.txt'), '42\n'); seen.set(input.role, input.context); return roleOutput(input.role) },
      verify: async () => true,
      reviewTarget: () => ({ kind: 'commit', target: testCase.seedSha }),
    })
    const bindings = createProductionEngineeringBindings({
      deployment, strongRouteId: deployment.roles.architect!.route, cheapRouteId: deployment.roles['scout-secondary']!.route,
      roleExecutorForCase: () => { throw new Error('C_FIXED must use direct stages') }, direct,
      verifySingle: async () => ({ stage: 'VERIFICATION', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), outcome: 'SUCCESS', requestIds: [] }),
      firstImplementationOracle: async () => true, reviewTarget: () => ({ kind: 'commit', target: testCase.seedSha }),
    })
    const receipts = await bindings.run('C_FIXED', testCase, root)
    expect(receipts.map(receipt => receipt.stage)).toEqual(['SCOUT', 'ARCHITECT', 'CHALLENGER', 'IMPLEMENTER', 'VERIFICATION', 'REVIEWER'])
    expect(seen.get('challenger')?.candidatePlan).toMatchObject(roleOutput('architect'))
    expect(seen.get('implementer')?.plan).toMatchObject(roleOutput('architect'))
    const taskIds = await readdir(join(root, '.agent/tasks'))
    expect(taskIds).toHaveLength(1)
    const directory = join(root, '.agent/tasks', taskIds[0]!)
    const plan = JSON.parse(await readFile(join(directory, 'PLAN.json'), 'utf8')) as BoundPlanDocument
    const verification = JSON.parse(await readFile(join(directory, 'VERIFY.json'), 'utf8')) as BoundVerificationDocument
    expect(seen.get('reviewer')?.verification).toEqual(verification)
    expect(verification).toMatchObject({ schemaVersion: 3, status: 'PASS', identity: plan.binding.seal })
    expect(verification.checks).toContainEqual(expect.objectContaining({ name: 'evaluation-oracle', status: 'PASS', evidenceIds: expect.any(Array) }))
    const evidence = (await readFile(join(directory, 'EVIDENCE.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as EvidenceDocument)
    const cited = verification.checks.flatMap(check => check.evidenceIds)
    expect(cited.length).toBeGreaterThan(0)
    for (const id of cited) expect(evidence.find(item => item.id === id)).toMatchObject({ kind: 'command', status: 'PASS', command: { exitCode: 0, timedOut: false }, scope: { identity: verification.identity } })
  })

  it('keeps an uncertain writer lease and rejects a new writer dispatch', async () => {
    const { root, deployment } = await prepared()
    const testCase = (await createEngineeringEvaluationCases(process.cwd())).find(item => item.id === 'recovery-latch')!
    let calls = 0
    const direct = createDirectEngineeringInvoker({ deployment, executeRole: async input => { calls += 1; if (input.role === 'implementer') throw new RoleQuiescenceError('writer shutdown is uncertain'); return roleOutput(input.role) }, verify: async () => true, reviewTarget: () => ({ kind: 'commit', target: testCase.seedSha }) })
    await expect(direct.invoke({ routeId: deployment.roles.implementer!.route, role: 'implementer', request: testCase.request, root, readOnly: false, testCase })).rejects.toThrow(RoleQuiescenceError)
    expect(await direct.report?.('B_CHEAP', testCase, root, [])).toMatchObject({ confirmedStopped: false })
    const taskIds = await readdir(join(root, '.agent/tasks'))
    const state = JSON.parse(await readFile(join(root, '.agent/tasks', taskIds[0]!, 'STATE.json'), 'utf8')) as { writer: { token: string } | null }
    expect(state.writer?.token).toEqual(expect.any(String))
    await expect(direct.invoke({ routeId: deployment.roles.implementer!.route, role: 'implementer', request: testCase.request, root, readOnly: false, testCase })).rejects.toThrow(/writer|quiescence|stop/i)
    expect(calls).toBe(1)
  })

  it('accepts the configured recovery gate only for answer.txt containing 42 and a newline', async () => {
    const { root } = await prepared()
    const project = await loadProjectVerificationConfig(join(root, '.agent/adapters/evaluation.yaml'))
    const gates = await loadVerificationProfile(root, 'evaluation-recovery-latch')
    await writeFile(join(root, 'answer.txt'), '42\n')
    await expect(runVerificationProfile(root, 'evaluation-recovery-latch', project, undefined, gates)).resolves.toMatchObject({ verification: { status: 'PASS' } })
    await writeFile(join(root, 'answer.txt'), '41\n')
    await expect(runVerificationProfile(root, 'evaluation-recovery-latch', project, undefined, gates)).resolves.toMatchObject({ verification: { status: 'FAIL' } })
  })
})
