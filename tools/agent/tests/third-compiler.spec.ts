/** Repository-data onboarding of a Node compiler through the complete engineering workflow. */

import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { EngineeringRoleFailure, loadEngineeringProject, runEngineeringTask } from '../src/automatic.ts'
import type { EngineeringRole, RoleExecutor } from '../src/automatic.ts'
import { loadHarnessConfig } from '../src/config.ts'
import { captureSourceInventory, loadRepositoryVerificationContext } from '../src/identity.ts'
import { requiredVerificationGates, resolveVerificationRequirements } from '../src/policy.ts'
import { TaskRepository } from '../src/repository.ts'
import { ArtifactSchemas } from '../src/schemas.ts'
import type { ArtifactSchemaName } from '../src/schemas.ts'
import type { BoundDecisionDocument, BoundPlanDocument, BoundReviewDocument, BoundVerificationDocument, EvidenceDocument } from '../src/types.ts'
import { loadProjectVerificationConfig, runCommand, verificationInstanceId } from '../src/verification.ts'

const checkout = resolve(import.meta.dirname, '../../..')
const fixture = join(import.meta.dirname, 'fixtures/third-compiler')
const genericRoots = ['tools/agent/src', 'tools/agent/runtime']
const genericFiles = [
  'tools/agent/src/automatic.ts',
  'tools/agent/src/verification.ts',
  'tools/agent/runtime/index.ts',
  'tools/agent/src/state-machine.ts',
  'tools/agent/src/repository.ts',
  'tools/agent/src/types.ts',
]

interface FixtureResponses {
  investigation: object
  plan: { problemStatement: string }
  challenger: object
  implementation: { summary: string; edits: Array<{ path: string; before: string; after: string }> }
  review: object
}

async function hashes(): Promise<Record<string, string>> {
  const sourceFiles = (await Promise.all(genericRoots.map(directory => paths(checkout, directory)))).flat().sort()
  expect(sourceFiles).toEqual(expect.arrayContaining(genericFiles))
  return Object.fromEntries(await Promise.all(sourceFiles.map(async path => [
    path, createHash('sha256').update(await readFile(join(checkout, path))).digest('hex'),
  ])))
}

async function paths(root: string, directory = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory === '' ? entry.name : `${directory}/${entry.name}`
    if (entry.isDirectory()) files.push(...await paths(root, path))
    else files.push(path)
  }
  return files.sort()
}

async function json<Value>(path: string): Promise<Value> {
  return JSON.parse(await readFile(path, 'utf8')) as Value
}

async function prepare(root: string, profile: string) {
  const repository = new TaskRepository(root, join(root, '.agent/schemas'), { templateRoot: join(checkout, '.agent') })
  await repository.init()
  const gitEnvironment: Record<string, string | undefined> = Object.fromEntries(
    Object.keys(process.env).filter(name => name.startsWith('GIT_')).map(name => [name, undefined]),
  )
  const git = async (...args: string[]) => (await execa('git', [
    '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '-c', 'user.name=CompilerFixture',
    '-c', 'user.email=compiler@example.invalid', ...args,
  ], { cwd: root, env: { ...gitEnvironment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } })).stdout
  await writeFile(join(root, '.gitignore'), await readFile(join(fixture, 'repository/.gitignore')))
  await git('init', '-q')
  await git('add', '.')
  await git('commit', '-qm', 'Generic harness baseline')
  const beforeOnboarding = await hashes()
  await cp(join(fixture, 'repository'), root, { recursive: true })
  const profilePath = join(root, '.agent/profiles/pebble-ir-lab.yaml')
  if (profile !== 'pebble-ir-lab') {
    await writeFile(join(root, '.agent/profiles', `${profile}.yaml`), (await readFile(profilePath, 'utf8')).replace('id: pebble-ir-lab', `id: ${profile}`))
    await rm(profilePath)
    const projectPath = join(root, '.agent/config/project.yaml')
    await writeFile(projectPath, (await readFile(projectPath, 'utf8')).replace('profile: pebble-ir-lab', `profile: ${profile}`))
  }
  const commandsPath = join(root, '.agent/adapters/pebble.yaml')
  await writeFile(commandsPath, (await readFile(commandsPath, 'utf8')).replaceAll('{{NODE_EXECUTABLE}}', process.execPath.replaceAll('\\', '/')))
  const additions = (await git('ls-files', '--others', '--exclude-standard')).split('\n').filter(Boolean).sort()
  const fixturePaths = (await paths(join(fixture, 'repository'))).map(path => path === '.agent/profiles/pebble-ir-lab.yaml' ? `.agent/profiles/${profile}.yaml` : path)
  expect(additions.length).toBeGreaterThan(0)
  expect(additions.every(path => fixturePaths.includes(path))).toBe(true)
  expect(additions).toContain(`.agent/profiles/${profile}.yaml`)
  expect((await git('diff', '--name-only')).split('\n').filter(Boolean).every(path => fixturePaths.includes(path))).toBe(true)
  const afterOnboarding = await hashes()
  expect(afterOnboarding).toEqual(beforeOnboarding)
  await git('add', '.')
  await git('commit', '-qm', 'Onboard Pebble using repository declarations and compiler fixtures')
  expect(await git('status', '--porcelain')).toBe('')
  const project = await loadEngineeringProject(root)
  const commands = await loadProjectVerificationConfig(commandsPath)
  expect(project.profile).toBe(profile)
  expect(project.knowledge).toEqual({ instructionFiles: ['COMPILER.md'], skills: [] })
  expect(commands.adapters.stack).toMatchObject({
    runner: { kind: 'local', workingDirectory: '.' }, executable: process.execPath.replaceAll('\\', '/'),
    args: ['scripts/check.mjs', 'emit', 'stack'], env: { set: { PEBBLE_FIXTURE: '1' }, inherit: [] },
  })
  const baseline = await runCommand(root, commands.adapters.stack!, 30000)
  expect(baseline).toMatchObject({ status: 'FAIL', exitCode: 1, timedOut: false, quiescence: 'CONFIRMED' })
  expect(baseline.stderr).toContain('AssertionError')
  expect(await git('status', '--porcelain')).toBe('')
  return { git, beforeOnboarding, afterOnboarding, additions, baseline }
}

describe('third compiler repository-data onboarding', () => {
  it.each(['pebble-ir-lab', 'quartz-fold-203'])('accepts %s with scoped compiler evidence and unchanged generic code', async profile => {
    const root = await mkdtemp(join(tmpdir(), 'third-compiler-'))
    const controller = new AbortController()
    try {
      const onboarding = await prepare(root, profile)
      const responses = await json<FixtureResponses>(join(fixture, 'responses.json'))
      const roles: EngineeringRole[] = []
      const states: string[] = []
      const executeRole: RoleExecutor = async invocation => {
        roles.push(invocation.role)
        expect(invocation.context.repositoryKnowledge).toEqual({ instructionFiles: ['COMPILER.md'], skills: [] })
        expect(await readFile(join(root, 'COMPILER.md'), 'utf8')).toContain('Fold arithmetic before emitting stack or register target IR')
        if (invocation.role.startsWith('scout-')) return responses.investigation
        if (invocation.role === 'architect') return responses.plan
        if (invocation.role === 'challenger') return responses.challenger
        if (invocation.role === 'implementer') {
          for (const edit of responses.implementation.edits) {
            const destination = join(root, edit.path)
            const source = await readFile(destination, 'utf8')
            expect(source.split(edit.before)).toHaveLength(2)
            await writeFile(destination, source.replace(edit.before, edit.after))
          }
          return { summary: responses.implementation.summary }
        }
        expect(invocation.role).toBe('reviewer')
        expect(invocation.context.VERIFY).toMatchObject({ schemaVersion: 3, status: 'PASS' })
        expect(await readFile(join(root, 'task.runtime/stack.ir'), 'utf8')).toBe('push.i32 48\nreturn.i32\n')
        expect(await readFile(join(root, 'task.runtime/register.ir'), 'utf8')).toBe('r0 = imm.i32 48\nreturn.i32 r0\n')
        expect(await readFile(join(root, 'compiler/pebble.mjs'), 'utf8')).toContain("operation === 'add' ? left + right : left * right")
        return responses.review
      }
      const result = await runEngineeringTask({
        root, deployment: await loadHarnessConfig(checkout), request: responses.plan.problemStatement,
        executeRole, signal: controller.signal, onProgress: state => states.push(state.state),
      })
      expect(result.state).toMatchObject({ state: 'ACCEPTED', workRevision: 1, fixAttempts: 0, writer: null })
      expect(roles).toEqual(['scout-primary', 'scout-secondary', 'architect', 'challenger', 'implementer', 'reviewer'])
      expect(states).toEqual(['NEW', 'BASELINED', 'INVESTIGATED', 'PLAN_FROZEN', 'VERIFYING', 'VERIFIED', 'REVIEWED', 'ACCEPTED'])
      const directory = join(root, '.agent/tasks', result.taskId)
      const schemas = new ArtifactSchemas(join(root, '.agent/schemas'))
      const task = load(await readFile(join(directory, 'TASK.yaml'), 'utf8'))
      await schemas.validate('task', task)
      expect(task).toMatchObject({ id: result.taskId, profile, schemaVersion: 1 })
      const artifacts: Array<[ArtifactSchemaName, string, number]> = [
        ['baseline', 'BASELINE', 1], ['investigation', 'INVESTIGATION', 1], ['plan', 'PLAN', 2],
        ['verification', 'VERIFY', 3], ['review', 'REVIEW', 2], ['decision', 'DECISION', 2],
      ]
      for (const [schema, name, version] of artifacts) {
        const artifact = await json<object>(join(directory, `${name}.json`))
        await schemas.validate(schema, artifact)
        expect(artifact).toMatchObject({ taskId: result.taskId, schemaVersion: version })
      }
      const plan = await json<BoundPlanDocument>(join(directory, 'PLAN.json'))
      const verification = await json<BoundVerificationDocument>(join(directory, 'VERIFY.json'))
      const review = await json<BoundReviewDocument>(join(directory, 'REVIEW.json'))
      const decision = await json<BoundDecisionDocument>(join(directory, 'DECISION.json'))
      expect(plan.binding.seal).toEqual(verification.identity)
      expect(review.identity).toEqual(verification.identity)
      expect(decision.identity).toEqual(verification.identity)
      expect(decision).toMatchObject({ decision: 'ACCEPTED', verificationStatus: 'PASS', reviewDecision: 'ACCEPT' })
      for (const artifact of [plan, verification, review, decision]) expect(artifact.workRevision).toBe(result.state!.workRevision)
      expect(verification.identity.attempt).toBe(1)
      for (const digest of ['sourceTreeDigest', 'verificationPolicyDigest', 'repositoryProfileDigest', 'requiredSetDigest'] as const) {
        expect(verification.identity[digest]).toMatch(/^[a-f0-9]{64}$/)
      }
      expect((await captureSourceInventory(root)).sourceTreeDigest).toBe(verification.identity.sourceTreeDigest)
      expect(plan.binding.baseline.sourceTreeDigest).not.toBe(verification.identity.sourceTreeDigest)
      expect(plan.binding.requirements.tier).toBe('presubmit')
      const context = await loadRepositoryVerificationContext(root, profile)
      expect(context.verificationPolicyDigest).toBe(verification.identity.verificationPolicyDigest)
      expect(context.repositoryProfileDigest).toBe(verification.identity.repositoryProfileDigest)
      const initial = resolveVerificationRequirements(context.gates, context.policy, [])
      expect(requiredVerificationGates(context.gates, initial).find(gate => gate.name === 'reference')?.required).toBe(false)
      const reference = context.gates.find(gate => gate.name === 'reference')!
      expect(plan.binding.requirements.instances).toContainEqual({ id: verificationInstanceId(reference), sources: ['impact:0'] })
      expect(verification.checks).toHaveLength(5)
      expect(verification.checks.filter(check => check.required).map(check => check.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS'])
      expect(verification.checks).toContainEqual(expect.objectContaining({ name: 'hardware', required: false, status: 'NOT_RUN', scope: { device: 'pebble-board' } }))
      const evidence = (await readFile(join(directory, 'EVIDENCE.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as EvidenceDocument)
      expect(evidence).toHaveLength(5)
      expect(new Set(evidence.map(record => record.id)).size).toBe(5)
      for (const check of verification.checks) {
        expect(check.evidenceIds).toHaveLength(1)
        const record = evidence.find(entry => entry.id === check.evidenceIds[0])!
        await schemas.validate('evidence', record)
        expect(record).toMatchObject({ taskId: result.taskId, workRevision: result.state!.workRevision, kind: 'command', status: check.status })
        expect(record.scope).toMatchObject({ name: check.name, category: check.category, verificationScope: check.scope, identity: verification.identity, quiescence: 'CONFIRMED' })
        if (check.required) {
          expect(record.command).toMatchObject({ executable: process.execPath.replaceAll('\\', '/'), cwd: root, exitCode: 0, timedOut: false })
          expect(record.scope.commandIdentity).toMatch(/^[a-f0-9]{64}$/)
          expect(record.scope.stdout).toContain('"value":48')
        } else {
          expect(record.command).toBeUndefined()
          expect(record.scope.stderr).toBe('adapter not configured')
        }
      }
      const codegenEvidence = evidence.filter(record => record.scope.name === 'codegen')
      expect(codegenEvidence.map(record => record.command?.args)).toEqual([
        ['scripts/check.mjs', 'emit', 'stack'], ['scripts/check.mjs', 'emit', 'register'],
      ])
      expect(new Set(codegenEvidence.map(record => record.scope.commandIdentity)).size).toBe(2)
      const executions = (await readFile(join(root, '.agent/executions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(executions).toEqual([
        { mode: 'parse', target: null, value: 48 }, { mode: 'emit', target: 'stack', value: 48 },
        { mode: 'emit', target: 'register', value: 48 }, { mode: 'reference', target: null, value: 48 },
      ])
      expect((await onboarding.git('diff', '--name-only')).split('\n').sort()).toEqual(['compiler/pebble.mjs', 'programs/arithmetic.ir'])
      expect(await onboarding.git('ls-files', '--others', '--exclude-standard')).toBe('')
      expect(await onboarding.git('check-ignore', '.agent/tasks', '.agent/executions.jsonl', 'task.runtime/stack.ir')).toBe('.agent/tasks\n.agent/executions.jsonl\ntask.runtime/stack.ir')
      const afterExecution = await hashes()
      expect(afterExecution).toEqual(onboarding.beforeOnboarding)
      await writeFile(join(directory, 'ONBOARDING.json'), `${JSON.stringify({
        profile, addedFiles: onboarding.additions, classification: 'repository-data-and-compiler-fixture',
        evidenceRetention: 'temporary-until-test-cleanup', evidenceKind: 'reproducible-assertions', genericRoots,
        genericBefore: onboarding.beforeOnboarding, genericAfterOnboarding: onboarding.afterOnboarding,
        genericAfterExecution: afterExecution, baseline: onboarding.baseline.status,
        finalIdentity: verification.identity, finalState: result.state!.state,
      }, null, 2)}\n`)
      expect((await captureSourceInventory(root)).sourceTreeDigest).toBe(verification.identity.sourceTreeDigest)
    } finally {
      controller.abort()
      await rm(root, { recursive: true, force: true, maxRetries: 3 })
    }
  }, 60000)

  it('does not review or accept an IR-only edit that leaves multiplication broken', async () => {
    const root = await mkdtemp(join(tmpdir(), 'third-compiler-invalid-'))
    const controller = new AbortController()
    try {
      const onboarding = await prepare(root, 'pebble-ir-lab')
      const responses = await json<FixtureResponses>(join(fixture, 'responses.json'))
      const roles: EngineeringRole[] = []
      const executeRole: RoleExecutor = async invocation => {
        roles.push(invocation.role)
        if (invocation.role.startsWith('scout-')) {
          if (invocation.context.VERIFY !== undefined) throw new EngineeringRoleFailure('The compiler still fails arithmetic verification; stop without acceptance.')
          return responses.investigation
        }
        if (invocation.role === 'architect') return responses.plan
        if (invocation.role === 'challenger') return responses.challenger
        if (invocation.role === 'implementer') {
          const edit = responses.implementation.edits.find(entry => entry.path === 'programs/arithmetic.ir')!
          const path = join(root, edit.path)
          await writeFile(path, (await readFile(path, 'utf8')).replace(edit.before, edit.after))
          return { summary: 'Extended the input program without repairing the folder' }
        }
        return responses.review
      }
      const result = await runEngineeringTask({ root, deployment: await loadHarnessConfig(checkout), request: responses.plan.problemStatement, executeRole, signal: controller.signal })
      expect(result.state!.state).toBe('BLOCKED')
      expect(roles).not.toContain('reviewer')
      const directory = join(root, '.agent/tasks', result.taskId)
      const verification = await json<BoundVerificationDocument>(join(directory, 'VERIFY.json'))
      expect(verification.status).toBe('FAIL')
      expect(verification.checks.filter(check => check.required).map(check => check.status)).toEqual(['PASS', 'FAIL', 'FAIL', 'FAIL'])
      for (const name of ['REVIEW', 'DECISION']) await expect(readFile(join(directory, `${name}.json`))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await hashes()).toEqual(onboarding.beforeOnboarding)
    } finally {
      controller.abort()
      await rm(root, { recursive: true, force: true, maxRetries: 3 })
    }
  }, 60000)
})
