import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskRepository } from '../src/repository.ts'
import { loadProjectVerificationConfig, runVerificationProfile, verificationEvidence } from '../src/verification.ts'

const ROOT = resolve(import.meta.dirname, '../../..')
const roots: string[] = []

function fixtureRoot(): string {
  const root = roots.at(-1)
  if (root === undefined) throw new Error('e2e repository fixture missing')
  return root
}
const baseline = { repositoryHead: 'fixture', dirty: false, summary: 'Synthetic baseline' }
const investigation = {
  findings: ['Fixture inspected'],
  hypotheses: [{ statement: 'Configured checks determine acceptance', evidence: ['fixture'] }],
  unresolvedAssumptions: [],
}
const plan = {
  problemStatement: 'Complete the synthetic task', hypotheses: ['Adapters are deterministic'],
  selectedApproach: 'Run configured argv adapters', rejectedAlternatives: ['Model self-report'],
  invariants: ['Required checks pass'], expectedComponents: ['fixture'], implementationScope: ['fixture'],
  falsificationTests: ['nonzero process exit'], acceptanceGates: ['profile passes'], unresolvedAssumptions: [],
}
const review = { decision: 'ACCEPT' as const, summary: 'Independent fixture review', findings: [] }

async function store(profile: 'compiler' | 'webapp'): Promise<TaskRepository> {
  const root = await mkdtemp(join(tmpdir(), `agent-e2e-${profile}-`))
  roots.push(root)
  const repository = new TaskRepository(root, join(ROOT, '.agent/schemas'), {
    now: () => '2026-10-04T00:00:00.000Z', writerToken: () => `writer-${profile}`,
  })
  await repository.init()
  await cp(join(ROOT, '.agent/profiles'), join(root, '.agent/profiles'), { recursive: true })
  await mkdir(join(root, '.agent/config'), { recursive: true })
  await mkdir(join(root, '.agent/adapters'), { recursive: true })
  await writeFile(join(root, '.agent/config/project.yaml'), JSON.stringify({ schemaVersion: 1, profile, adapter: '.agent/adapters/local.yaml', commandTimeoutMs: 30000 }))
  const configuration = await loadProjectVerificationConfig(join(ROOT, `tools/agent/examples/${profile}.project.yaml`))
  if (profile === 'compiler') {
    const reference = configuration.adapters.reference
    if (reference === undefined) throw new Error('compiler reference adapter fixture missing')
    reference.args = ['-e', "const fs = require('node:fs'); const marker = '.dsh/engineering/.runtime/reference-attempt'; if (!fs.existsSync(marker)) { fs.mkdirSync('.dsh/engineering/.runtime', { recursive: true }); fs.writeFileSync(marker, 'failed'); process.exit(2) }"]
  }
  await writeFile(join(root, '.agent/adapters/local.yaml'), JSON.stringify(configuration))
  await repository.createTask({
    schemaVersion: 1, id: profile, title: `Synthetic ${profile}`, profile, dataClass: 'public', createdAt: '2026-10-04T00:00:00.000Z',
  })
  await repository.baseline(profile, 0, baseline)
  await repository.investigate(profile, 1, investigation)
  await repository.freezePlan(profile, 2, plan)
  return repository
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('synthetic task examples', () => {
  it.each(['model-A', 'model-B'])('resolves %s for installed architecture and review from deployment configuration', async model => {
    const root = await mkdtemp(join(tmpdir(), 'agent-e2e-routing-'))
    roots.push(root)
    const entry = join(ROOT, 'tools/agent/agentctl.mjs')
    await execa(process.execPath, [entry, 'init', '--root', root], { cwd: ROOT })
    await cp(join(ROOT, '.agent/config'), join(root, '.agent/config'), { recursive: true })
    const { stdout } = await execa(process.execPath, [entry, 'smoke-models', '--root', root, '--deployment-root', root], { cwd: ROOT, env: { DSH_ARCHITECT_MODEL_ID: model, DSH_ARCHITECT_REASONING_EFFORT: 'medium', DSH_REVIEWER_REASONING_EFFORT: 'medium' } })
    const { routes: results } = JSON.parse(stdout) as { routes: Array<{ role: string; provider: string; model: string; reasoningEffort: string }> }
    for (const role of ['architect', 'reviewer']) {
      expect(results.find(result => result.role === role)).toMatchObject({
        provider: 'magpie-responses', model, reasoningEffort: 'medium',
      })
    }
  })

  it('accepts a webapp after its typecheck, unit, e2e, and build profile passes', async () => {
    const repository = await store('webapp')
    const implementing = await repository.startImplementation('webapp', 3)
    const verifying = await repository.beginVerification('webapp', implementing.revision, implementing.writer?.token ?? '')
    const snapshot = await repository.verificationExecutionContext('webapp')
    const assertCurrent = async (): Promise<void> => repository.assertVerificationExecutionContext('webapp', snapshot)
    const execution = await runVerificationProfile(fixtureRoot(), 'webapp', snapshot.config, undefined, snapshot.gates, snapshot.arguments, snapshot.identity, assertCurrent)
    await assertCurrent()
    await repository.appendEvidence('webapp', verifying.workRevision, verificationEvidence(fixtureRoot(), execution), verifying.revision)
    const verified = await repository.finishVerification('webapp', verifying.revision, execution.verification)
    const reviewed = await repository.review('webapp', verified.revision, review)
    expect(await repository.accept('webapp', reviewed.revision)).toMatchObject({ state: 'ACCEPTED', workRevision: 1 })
  })

  it('repairs one failed compiler verification and preserves partial target scope', async () => {
    const repository = await store('compiler')
    let implementing = await repository.startImplementation('compiler', 3)
    let verifying = await repository.beginVerification('compiler', implementing.revision, implementing.writer?.token ?? '')
    const firstSnapshot = await repository.verificationExecutionContext('compiler')
    const assertFirst = async (): Promise<void> => repository.assertVerificationExecutionContext('compiler', firstSnapshot)
    const failed = await runVerificationProfile(fixtureRoot(), 'compiler', firstSnapshot.config, undefined, firstSnapshot.gates, firstSnapshot.arguments, firstSnapshot.identity, assertFirst)
    await assertFirst()
    await repository.appendEvidence('compiler', verifying.workRevision, verificationEvidence(fixtureRoot(), failed), verifying.revision)
    let state = await repository.finishVerification('compiler', verifying.revision, failed.verification)
    expect(state).toMatchObject({ state: 'IMPLEMENTING', fixAttempts: 1 })

    implementing = await repository.startImplementation('compiler', state.revision)
    verifying = await repository.beginVerification('compiler', implementing.revision, implementing.writer?.token ?? '')
    const repairedSnapshot = await repository.verificationExecutionContext('compiler')
    const assertRepaired = async (): Promise<void> => repository.assertVerificationExecutionContext('compiler', repairedSnapshot)
    const repaired = await runVerificationProfile(fixtureRoot(), 'compiler', repairedSnapshot.config, undefined, repairedSnapshot.gates, repairedSnapshot.arguments, repairedSnapshot.identity, assertRepaired)
    await assertRepaired()
    await repository.appendEvidence('compiler', verifying.workRevision, verificationEvidence(fixtureRoot(), repaired), verifying.revision)
    expect(repaired.verification).toMatchObject({ status: 'PASS', scope: { targets: { A3: 'NOT_RUN' } } })
    state = await repository.finishVerification('compiler', verifying.revision, repaired.verification)
    state = await repository.review('compiler', state.revision, review)
    expect(await repository.accept('compiler', state.revision)).toMatchObject({ state: 'ACCEPTED', fixAttempts: 1 })
  })
})
