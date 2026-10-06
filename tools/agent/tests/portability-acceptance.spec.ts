import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { dump, load } from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadEngineeringProject, runEngineeringTask } from '../src/automatic.ts'
import type { EngineeringRunOptions, RoleExecutor } from '../src/automatic.ts'
import { installationFiles, installEngineeringProject } from '../src/installation.ts'
import { TaskRepository } from '../src/repository.ts'
import { loadHarnessConfig } from '../src/config.ts'
import { ArtifactSchemas } from '../src/schemas.ts'
import { loadVerificationProfile, runCommand } from '../src/verification.ts'

const checkout = resolve(import.meta.dirname, '../../..')
const roots: string[] = []
const controllers = new Set<AbortController>()
const work = new Set<Promise<unknown>>()
const timestamp = '2026-10-06T00:00:00.000Z'
const investigation = {
  findings: ['The requested output is a repository source file'],
  hypotheses: [{ statement: 'The output must contain 42', evidence: ['Task requirement'] }],
  unresolvedAssumptions: [],
}
const plan = {
  problemStatement: 'Write answer.txt containing 42',
  hypotheses: ['A focused content check can reject wrong output'],
  selectedApproach: 'Write the requested file',
  rejectedAlternatives: ['Skip deterministic checks'],
  invariants: ['Do not change unrelated files'],
  expectedComponents: ['answer.txt'],
  implementationScope: ['answer.txt'],
  falsificationTests: ['Content other than 42 must fail'],
  acceptanceGates: ['unit'],
  unresolvedAssumptions: [],
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'engineering-portability-'))
  roots.push(root)
  return root
}

function track<Result>(promise: Promise<Result>): Promise<Result> {
  work.add(promise)
  void promise.then(() => work.delete(promise), () => work.delete(promise))
  return promise
}

function automaticRun(options: EngineeringRunOptions) {
  const controller = new AbortController()
  controllers.add(controller)
  return track(runEngineeringTask({ ...options, signal: controller.signal }))
}

async function automaticFixture(profile = 'small-feature'): Promise<EngineeringRunOptions> {
  const root = await temporaryRoot()
  await cp(join(checkout, '.agent'), join(root, '.agent'), {
    recursive: true,
    filter: source => source !== join(checkout, '.agent/tasks'),
  })
  await writeFile(join(root, '.agent/config/project.yaml'), dump({
    schemaVersion: 1, profile, adapter: '.agent/adapters/fixture.yaml', dataClass: 'public',
    maxSteps: 40, maxRoleCalls: 30, commandTimeoutMs: 30_000,
  }))
  const names = ['typecheck', 'unit', 'build']
  await writeFile(join(root, '.agent/profiles', `${profile}.yaml`), dump({
    schemaVersion: 1, id: profile,
    checks: names.map(name => ({ name, category: 'focused', required: true, timeoutMs: 30_000 })),
  }))
  await writeFile(join(root, '.agent/adapters/fixture.yaml'), dump({
    adapters: Object.fromEntries(names.map(name => [name, {
      executable: process.execPath,
      args: ['-e', `const fs=require('node:fs');fs.appendFileSync('.agent/command-executions.jsonl',${JSON.stringify(JSON.stringify({ name }) + '\n')});if(fs.readFileSync('answer.txt','utf8')!=='42')process.exit(1)`],
    }])),
  }))
  await writeFile(join(root, '.gitignore'), '.agent/\n')
  await execa('git', ['init', '-q'], { cwd: root })
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: root })
  await execa('git', ['config', 'core.hooksPath', join(root, 'empty-hooks')], { cwd: root })
  await writeFile(join(root, 'answer.txt'), 'unimplemented')
  await execa('git', ['add', '.gitignore', 'answer.txt'], { cwd: root })
  await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Portability baseline'], { cwd: root })
  const executeRole: RoleExecutor = async ({ role }) => {
    if (role === 'scout-primary' || role === 'scout-secondary') return investigation
    if (role === 'architect') return plan
    if (role === 'implementer') {
      await writeFile(join(root, 'answer.txt'), '42')
      return { summary: 'Wrote the requested source file' }
    }
    return { decision: 'ACCEPT', summary: 'Inspected the requested output', findings: [] }
  }
  return { root, deployment: await loadHarnessConfig(root), request: plan.problemStatement, executeRole }
}

beforeEach(async () => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GIT_')) vi.stubEnv(name, undefined)
  }
  const root = await temporaryRoot()
  const config = join(root, 'gitconfig')
  await writeFile(config, '')
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
})

afterEach(async () => {
  for (const controller of controllers) controller.abort()
  await Promise.allSettled(work)
  controllers.clear()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('repository-independent engineering acceptance', () => {
  it('renders identical user profiles for different target repositories', async () => {
    const root = await temporaryRoot()
    const options = { checkout, project: join(root, 'repository-a'), home: join(root, 'home'), binDirectory: join(root, 'bin'), node: process.execPath }
    const other = { ...options, project: join(root, 'repository-b') }
    expect(installationFiles(options)).toEqual(installationFiles(other))
  })

  it('exposes engineering and engineering-run without Ascend-specific launcher defaults', async () => {
    const root = await temporaryRoot()
    const files = installationFiles({ checkout, home: join(root, 'home'), binDirectory: join(root, 'bin'), node: process.execPath })
    expect(files.map(file => file.path)).toContain(join(root, 'home/profiles/engineering/cordis.patch.yml'))
    expect(files.map(file => file.path)).toContain(join(root, 'home/profiles/engineering-run/cordis.patch.yml'))
    expect(files.find(file => file.path === join(root, 'bin/dsh'))?.content).toContain('set -- engineering')
  })

  it('does not initialize a generic repository with an Ascend adapter', async () => {
    const root = await temporaryRoot()
    const project = join(root, 'repository')
    await mkdir(project)
    await installEngineeringProject({ checkout, project, home: join(root, 'home'), binDirectory: join(root, 'bin'), node: process.execPath })
    expect(await readdir(join(project, '.agent/adapters'))).not.toContain('ascend-npu-ir.yaml')
    expect(await readFile(join(project, '.agent/config/project.yaml'), 'utf8')).not.toContain('ascend-npu-ir')
  })

  it('accepts a synthetic compiler profile in the task artifact schema', async () => {
    const schemas = new ArtifactSchemas(join(checkout, '.agent/schemas'))
    await expect(schemas.validate('task', {
      schemaVersion: 1, id: 'synthetic-task', title: 'Synthetic compiler task',
      profile: 'synthetic-compiler', dataClass: 'public', createdAt: timestamp,
    })).resolves.toMatchObject({ profile: 'synthetic-compiler' })
  })

  it('loads an existing synthetic compiler profile in automatic project configuration', async () => {
    const options = await automaticFixture('synthetic-compiler')
    await expect(loadVerificationProfile(options.root, 'synthetic-compiler')).resolves.toHaveLength(3)
    await expect(loadEngineeringProject(options.root)).resolves.toMatchObject({ profile: 'synthetic-compiler' })
  })

  it('creates a synthetic compiler task through the public CLI', async () => {
    const options = await automaticFixture('synthetic-compiler')
    const result = await track(execa(process.execPath, [join(checkout, 'tools/agent/agentctl.mjs'),
      'new', 'synthetic-task', '--root', options.root, '--title', 'Synthetic compiler task',
      '--profile', 'synthetic-compiler', '--data-class', 'public',
    ], { cwd: checkout, timeout: 30_000 }))
    expect(JSON.parse(result.stdout)).toMatchObject({ state: 'NEW', taskId: 'synthetic-task' })
  })

  it.each(['../outside', 'Uppercase', 'has_space', ''])('rejects unsafe profile ID %j before reading a profile', async profile => {
    const root = await temporaryRoot()
    await mkdir(join(root, '.agent/profiles'), { recursive: true })
    await writeFile(join(root, '.agent/profiles', `${profile}.yaml`), dump({
      schemaVersion: 1, id: profile,
      checks: [{ name: 'unit', category: 'focused', required: true, timeoutMs: 30_000 }],
    }))
    await expect(loadVerificationProfile(root, profile)).rejects.toThrow()
  })

  it.each(['profiles/small-feature.yaml', 'adapters/fixture.yaml', 'config/project.yaml', 'config/verification-policy.yaml'])(
    'invalidates acceptance when %s changes after verification', async policy => {
      const options = await automaticFixture()
      if (policy === 'config/verification-policy.yaml') {
        await writeFile(join(options.root, '.agent/config/project.yaml'), dump({
          schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/fixture.yaml', dataClass: 'public',
          verificationPolicy: '.agent/config/verification-policy.yaml', maxSteps: 40, maxRoleCalls: 30, commandTimeoutMs: 30000,
        }))
        await writeFile(join(options.root, '.agent', policy), dump({
          schemaVersion: 1, defaultTier: 'development', allowedTiers: ['development'], alwaysRequired: [],
          tiers: { development: [], presubmit: [], qualification: [] },
          impactRules: [{ paths: ['answer.txt'], require: [{ name: 'unit', scope: {} }] }],
        }))
      }
      let mutated = false
      let taskId: string | undefined
      await automaticRun({ ...options, executeRole: async invocation => {
        if (invocation.role === 'reviewer') {
          taskId = invocation.taskId
          const verification = JSON.parse(await readFile(join(options.root, '.agent/tasks', invocation.taskId, 'VERIFY.json'), 'utf8'))
          expect(verification).toMatchObject({ status: 'PASS' })
          const filename = join(options.root, '.agent', policy)
          const source = await readFile(filename, 'utf8')
          const updated = policy.startsWith('profiles/')
            ? source.replace('required: true', 'required: false')
            : policy.startsWith('adapters/')
              ? source.replace('executable:', 'cwd: .\n    executable:')
              : policy.endsWith('verification-policy.yaml')
                ? source.replace('answer.txt', 'other.txt')
                : source.replace('maxSteps: 40', 'maxSteps: 41')
          expect(updated).not.toBe(source)
          await writeFile(filename, updated)
          mutated = true
        }
        return options.executeRole(invocation)
      } }).then(result => {
        expect(result.state!.state).toMatch(/^(BLOCKED|REPLAN)$/)
      }, (error: unknown) => {
        expect(error).toBeInstanceOf(Error)
        if (!(error instanceof Error)) throw error
        expect(error.message).toMatch(/policy|profile|changed|identity/i)
      })
      expect(mutated).toBe(true)
      if (taskId === undefined) throw new Error('policy mutation did not reach review')
      expect((await new TaskRepository(options.root).readState(taskId)).state).not.toBe('ACCEPTED')
      await expect(readFile(join(options.root, '.agent/tasks', taskId, 'DECISION.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('starts zero verification commands when the adapter changes before verification', async () => {
    const options = await automaticFixture()
    let taskId: string | undefined
    await expect(automaticRun({ ...options, executeRole: async invocation => {
      taskId = invocation.taskId
      if (invocation.role === 'implementer') {
        await writeFile(join(options.root, '.agent/adapters/fixture.yaml'), dump({ adapters: {} }))
      }
      return options.executeRole(invocation)
    } })).rejects.toThrow(/policy|profile|changed|identity/i)
    if (taskId === undefined) throw new Error('adapter drift workflow did not reach a role')
    await expect(readFile(join(options.root, '.agent/command-executions.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await new TaskRepository(options.root).readState(taskId)).state).not.toBe('ACCEPTED')
  })

  it('does not publish authoritative evidence when the adapter changes during verification', async () => {
    const options = await automaticFixture()
    const original = join(options.root, '.agent/adapters/fixture.yaml')
    const command = (name: string) => `const fs=require('node:fs');fs.appendFileSync('.agent/command-executions.jsonl',${JSON.stringify(JSON.stringify({ name }) + '\n')});fs.appendFileSync('.agent/adapters/fixture.yaml','# drift\\n');if(fs.readFileSync('answer.txt','utf8')!=='42')process.exit(1)`
    await writeFile(original, dump({
      adapters: Object.fromEntries(['typecheck', 'unit', 'build'].map(name => [name, {
        executable: process.execPath, args: ['-e', command(name)],
      }])),
    }))
    let taskId: string | undefined
    await expect(automaticRun({ ...options, executeRole: async invocation => {
      taskId = invocation.taskId
      return options.executeRole(invocation)
    } })).rejects.toThrow(/policy|profile|changed|identity/i)
    if (taskId === undefined) throw new Error('adapter drift workflow did not reach a role')
    const executions = (await readFile(join(options.root, '.agent/command-executions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(executions).toEqual([{ name: 'typecheck' }])
    await expect(readFile(join(options.root, '.agent/tasks', taskId, 'EVIDENCE.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(options.root, '.agent/tasks', taskId, 'VERIFY.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await new TaskRepository(options.root).readState(taskId)).state).not.toBe('ACCEPTED')
  })

  it('runs policy-required gates omitted by the Architect', async () => {
    const options = await automaticFixture()
    const result = await automaticRun(options)
    expect(result.state!.state).toBe('ACCEPTED')
    const verification = JSON.parse(await readFile(join(options.root, '.agent/tasks', result.taskId, 'VERIFY.json'), 'utf8'))
    expect(verification.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'typecheck', required: true, status: 'PASS' }),
      expect.objectContaining({ name: 'build', required: true, status: 'PASS' }),
    ]))
    const executions = (await readFile(join(options.root, '.agent/command-executions.jsonl'), 'utf8'))
      .trim().split('\n').map((line): unknown => JSON.parse(line))
    expect(executions).toEqual([{ name: 'typecheck' }, { name: 'unit' }, { name: 'build' }])
    const evidence = (await readFile(join(options.root, '.agent/tasks', result.taskId, 'EVIDENCE.jsonl'), 'utf8'))
      .trim().split('\n').map((line): unknown => JSON.parse(line))
    expect(evidence).toHaveLength(3)
    expect(evidence).toEqual(expect.arrayContaining(['typecheck', 'unit', 'build'].map(name => expect.objectContaining({
      summary: `${name}: PASS`, status: 'PASS', kind: 'command', workRevision: result.state!.workRevision,
      command: expect.objectContaining({ executable: process.execPath, exitCode: 0, timedOut: false }),
    }))))
  })

  it('loads the same gate independently for two repository-defined scopes', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, '.agent/profiles'), { recursive: true })
    await writeFile(join(root, '.agent/profiles/synthetic-compiler.yaml'), dump({
      schemaVersion: 1, id: 'synthetic-compiler',
      checks: ['backend-one', 'backend-two'].map(targetBackend => ({
        name: 'source-codegen', category: 'source', required: true, timeoutMs: 30_000, scope: { targetBackend },
      })),
    }))
    await expect(loadVerificationProfile(root, 'synthetic-compiler')).resolves.toEqual([
      expect.objectContaining({ name: 'source-codegen', scope: { targetBackend: 'backend-one' } }),
      expect.objectContaining({ name: 'source-codegen', scope: { targetBackend: 'backend-two' } }),
    ])
  })

  it.each(['path-failure', 'path-not-run', 'presubmit-failure', 'qualification-not-run', 'unrelated-path'])(
    'applies deterministic requirements for %s without Architect selection', async mode => {
      const options = await automaticFixture('policy-compiler')
      const semantic = { name: 'semantic-regression', scope: { compilerLayer: 'analysis' } }
      await writeFile(join(options.root, '.agent/config/project.yaml'), dump({
        schemaVersion: 1, profile: 'policy-compiler', adapter: '.agent/adapters/fixture.yaml', dataClass: 'public',
        verificationPolicy: '.agent/config/verification-policy.yaml', maxSteps: 40, maxRoleCalls: 30, commandTimeoutMs: 30000,
      }))
      await writeFile(join(options.root, '.agent/config/verification-policy.yaml'), dump({
        schemaVersion: 1,
        defaultTier: mode === 'presubmit-failure' ? 'presubmit' : mode === 'qualification-not-run' ? 'qualification' : 'development',
        allowedTiers: ['development', 'presubmit', 'qualification'], alwaysRequired: [],
        tiers: { development: [], presubmit: [semantic], qualification: [] },
        impactRules: [{ paths: [mode === 'unrelated-path' ? 'compiler/**' : 'answer.txt'], require: [semantic] }],
      }))
      await writeFile(join(options.root, '.agent/profiles/policy-compiler.yaml'), dump({
        schemaVersion: 1, id: 'policy-compiler', checks: [
          ...['typecheck', 'unit', 'build'].map(name => ({ name, category: 'focused', required: true, timeoutMs: 30000 })),
          { ...semantic, category: 'correctness', required: false, timeoutMs: 30000 },
        ],
      }))
      if (mode.endsWith('failure')) {
        const path = join(options.root, '.agent/adapters/fixture.yaml')
        const adapters = load(await readFile(path, 'utf8')) as { adapters: Record<string, { executable: string; args: string[] }> }
        adapters.adapters[semantic.name] = { executable: process.execPath, args: ['-e', 'process.exit(7)'] }
        await writeFile(path, dump(adapters))
      }
      const transitions: string[] = []
      let taskId: string | undefined
      const running = automaticRun({ ...options, onProgress: state => { transitions.push(state.state) }, executeRole: invocation => {
        taskId = invocation.taskId
        return options.executeRole(invocation)
      } })
      if (mode === 'unrelated-path') {
        const result = await running
        expect(result.state!.state).toBe('ACCEPTED')
      } else {
        await expect(running).rejects.toThrow('role-call budget exhausted')
        expect(transitions).toContain('REPLAN')
        expect(transitions).not.toContain('ACCEPTED')
      }
      if (taskId === undefined) throw new Error('policy workflow did not start')
      const directory = join(options.root, '.agent/tasks', taskId)
      const verification = JSON.parse(await readFile(join(directory, 'VERIFY.json'), 'utf8'))
      if (mode === 'unrelated-path') {
        expect(verification.checks).toContainEqual(expect.objectContaining({ ...semantic, required: false, status: 'NOT_RUN' }))
        return
      }
      const state = JSON.parse(await readFile(join(directory, 'STATE.json'), 'utf8'))
      expect(state.state).not.toBe('ACCEPTED')
      expect(verification.checks).toContainEqual(expect.objectContaining({ ...semantic, required: true, status: mode.endsWith('failure') ? 'FAIL' : 'NOT_RUN' }))
      await expect(readFile(join(directory, 'DECISION.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    },
    // Failure cases deliberately consume the complete 30-call workflow budget.
    60_000,
  )

  it.each(['valid', 'borrowed-evidence', 'missing-scope'])('handles %s scoped verification through the complete artifact chain', async mode => {
    const options = await automaticFixture('scoped-compiler')
    await writeFile(join(options.root, '.agent/profiles/scoped-compiler.yaml'), dump({
      schemaVersion: 1, id: 'scoped-compiler', checks: ['typecheck', 'unit'].map(adapter => ({
        name: 'codegen', category: 'source', adapter, scope: { targetBackend: adapter }, required: true, timeoutMs: 30000,
      })),
    }))
    let taskId: string | undefined
    const running = automaticRun({ ...options, executeRole: async invocation => {
      taskId = invocation.taskId
      if (invocation.role === 'reviewer' && mode !== 'valid') {
        const path = join(options.root, '.agent/tasks', invocation.taskId, 'VERIFY.json')
        const verification = JSON.parse(await readFile(path, 'utf8'))
        if (mode === 'borrowed-evidence') verification.checks[1].evidenceIds = verification.checks[0].evidenceIds
        if (mode === 'missing-scope') verification.checks.splice(1, 1)
        await writeFile(path, JSON.stringify(verification))
      }
      return options.executeRole(invocation)
    } })
    if (mode !== 'valid') {
      await expect(running).rejects.toThrow(/scoped command evidence|required instance/)
      if (taskId === undefined) throw new Error('scoped workflow did not start')
      await expect(readFile(join(options.root, '.agent/tasks', taskId, 'DECISION.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      return
    }
    const result = await running
    expect(result.state!.state).toBe('ACCEPTED')
    const directory = join(options.root, '.agent/tasks', result.taskId)
    const verification = JSON.parse(await readFile(join(directory, 'VERIFY.json'), 'utf8'))
    expect(verification.schemaVersion).toBe(3)
    expect(verification.checks).toHaveLength(2)
    expect(new Set(verification.checks.flatMap((check: { evidenceIds: string[] }) => check.evidenceIds)).size).toBe(2)
    const evidence = (await readFile(join(directory, 'EVIDENCE.jsonl'), 'utf8')).trim().split('\n').map((line): unknown => JSON.parse(line))
    expect(evidence).toHaveLength(2)
    expect(evidence).toEqual(expect.arrayContaining(['typecheck', 'unit'].map(targetBackend => expect.objectContaining({
      scope: expect.objectContaining({ name: 'codegen', category: 'source', verificationScope: { targetBackend } }),
      command: expect.objectContaining({ executable: process.execPath, cwd: options.root, exitCode: 0, timedOut: false }),
    }))))
  })

  it('reports confirmed local quiescence after a command exits', async () => {
    const root = await temporaryRoot()
    await expect(runCommand(root, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }, 30_000))
      .resolves.toMatchObject({ status: 'PASS', exitCode: 0, quiescence: 'CONFIRMED' })
  })

  it.skipIf(process.platform === 'win32')('confirms local cancellation only after the process exits', async () => {
    const root = await temporaryRoot()
    const controller = new AbortController()
    const command = runCommand(root, {
      executable: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('ready',String(process.pid));setInterval(()=>{},1000)"],
    }, 30_000, controller.signal)
    try {
      let pid = 0
      await vi.waitFor(async () => {
        pid = Number(await readFile(join(root, 'ready'), 'utf8'))
        expect(pid).toBeGreaterThan(0)
      }, { timeout: 10_000 })
      controller.abort()
      const result = await command
      expect(() => process.kill(pid, 0)).toThrow()
      expect(result).toMatchObject({ status: 'INCOMPLETE', timedOut: false, quiescence: 'CONFIRMED' })
    } finally {
      controller.abort()
      await command
    }
  }, 30_000)

  it('completes a third compiler workflow using repository data and unchanged runtime', async () => {
    const options = await automaticFixture('synthetic-compiler')
    const roles: string[] = []
    const result = await automaticRun({ ...options, executeRole: async invocation => {
      roles.push(invocation.role)
      return options.executeRole(invocation)
    } })
    expect(result.state!.state).toBe('ACCEPTED')
    expect(roles).toEqual(['scout-primary', 'scout-secondary', 'architect', 'challenger', 'implementer', 'reviewer'])
    expect(await readFile(join(options.root, 'answer.txt'), 'utf8')).toBe('42')
  })
})
