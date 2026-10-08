import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dump, load } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineeringRoleFailure, getEngineeringStatus, recoverEngineeringTask, runEngineeringTask as executeEngineeringTask } from '../src/automatic.ts'
import type { EngineeringRunOptions, RoleExecutor, RoleInvocation } from '../src/automatic.ts'
import { RoleInvocationError, RoleQuiescenceError, roleInvocationErrorForLlmCode } from '../src/role-execution.ts'
import { TaskRepository } from '../src/repository.ts'
import { loadHarnessConfig } from '../src/config.ts'
import { resolveVerificationPolicy } from '../src/policy.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { collectRole } from '../runtime/index.ts'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

const exec = promisify(execFile)
const roots: string[] = []
const controllers = new Set<AbortController>()
const work = new Set<Promise<unknown>>()

function runEngineeringTask(options: EngineeringRunOptions) {
  const controller = new AbortController()
  controllers.add(controller)
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal])
  const pending = executeEngineeringTask({ ...options, signal })
  work.add(pending)
  void pending.then(() => work.delete(pending), () => work.delete(pending))
  return pending
}
const investigation = { findings: ['Observed fixture'], hypotheses: [{ statement: 'Writing the file satisfies the request', evidence: ['test fixture'] }], unresolvedAssumptions: [] }
const plan = {
  problemStatement: 'Write the requested file', hypotheses: ['The requested content is 42'], selectedApproach: 'Write answer.txt',
  rejectedAlternatives: ['Skip the write'], invariants: ['Keep unrelated files intact'], expectedComponents: ['answer.txt'],
  implementationScope: ['answer.txt'], falsificationTests: ['Wrong file contents fail'], acceptanceGates: ['unit'], unresolvedAssumptions: [],
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => {}
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

async function fixture(profile = 'small-feature'): Promise<EngineeringRunOptions> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-automatic-'))
  roots.push(root)
  await cp(resolve('.agent'), join(root, '.agent'), { recursive: true, filter: source => !source.includes(`${join('.agent', 'tasks')}`) })
  await writeFile(join(root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile, adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 40, maxRoleCalls: 30, commandTimeoutMs: 30000 }))
  await writeFile(join(root, '.agent/profiles', `${profile}.yaml`),
    (await readFile(resolve('.agent/profiles/small-feature.yaml'), 'utf8')).replace('id: small-feature', `id: ${profile}`))
  await writeFile(join(root, '.agent/adapters/test.yaml'), dump({ adapters: Object.fromEntries(['typecheck', 'unit', 'build'].map(name => [name, { executable: process.execPath, args: ['-e', "if(require('fs').readFileSync('answer.txt','utf8')!=='42')process.exit(1)"] }])) }))
  await exec('git', ['init'], { cwd: root })
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: root })
  const executeRole: RoleExecutor = async ({ role }) => {
    if (role.startsWith('scout-')) return investigation
    if (role === 'architect') return plan
    if (role === 'challenger') return { decision: 'ACCEPT', summary: 'Tests falsify wrong output', findings: [] }
    if (role === 'implementer') {
      await writeFile(join(root, 'answer.txt'), '42')
      return { summary: 'Wrote answer.txt' }
    }
    return { decision: 'ACCEPT', summary: 'File and commands inspected', findings: [] }
  }
  return { root, deployment: await loadHarnessConfig(root, { env: {} }), request: 'Write answer.txt containing 42', executeRole }
}

afterEach(async () => {
  for (const controller of controllers) controller.abort()
  await Promise.allSettled(work)
  controllers.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('automatic engineering workflow', () => {
  it('requests scope for a frozen blocking assumption and replans only after a changed request', async () => {
    const options = await fixture()
    const calls: string[] = []
    const blocked = await runEngineeringTask({ ...options, executeRole: async input => {
      calls.push(input.role)
      if (input.role === 'architect') return { ...plan, unresolvedAssumptions: [{ statement: 'Choose the supported product scope', acceptanceBlocking: true }] }
      return options.executeRole(input)
    } })
    expect(blocked).toMatchObject({ status: 'BLOCKED', nextAction: 'REPLAN_WITH_SCOPE', requiresStopConfirmation: false, state: { state: 'BLOCKED' } })
    expect(blocked.summary).toContain('Choose the supported product scope')
    await expect(readFile(join(options.root, '.agent/tasks', blocked.taskId, 'DECISION.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const noDispatch = vi.fn(options.executeRole)
    const repeat = await runEngineeringTask({ ...options, taskId: blocked.taskId, request: '', executeRole: noDispatch })
    expect(repeat).toEqual(blocked)
    expect(noDispatch).not.toHaveBeenCalled()
    const resumed = await runEngineeringTask({ ...options, taskId: blocked.taskId, request: 'Supported product scope: write only answer.txt', executeRole: async input => {
      calls.push(input.role)
      return options.executeRole(input)
    } })
    expect(resumed).toMatchObject({ status: 'ACCEPTED', taskId: blocked.taskId, nextAction: 'NONE' })
    expect(calls.filter(role => role === 'architect')).toHaveLength(2)
  }, 20000)

  it.each(['adapter', 'policy', 'profile'] as const)('starts no command when %s drifts after the execution snapshot', async kind => {
    const options = await fixture()
    const projectPath = join(options.root, '.agent/config/project.yaml')
    await writeFile(projectPath, dump({ ...load(await readFile(projectPath, 'utf8')) as object, verificationPolicy: '.agent/config/verification-policy.yaml' }))
    await writeFile(join(options.root, '.agent/config/verification-policy.yaml'), dump(resolveVerificationPolicy(undefined)))
    const path = kind === 'adapter' ? '.agent/adapters/test.yaml' : kind === 'policy' ? '.agent/config/verification-policy.yaml' : '.agent/profiles/small-feature.yaml'
    await mkdir(join(options.root, '.dsh'), { recursive: true })
    const marker = join(options.root, '.dsh/command-count')
    await writeFile(join(options.root, '.agent/adapters/test.yaml'), dump({ adapters: Object.fromEntries(['typecheck', 'unit', 'build'].map(name => [name, {
      executable: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)},'spawn\\n')`],
    }])) }))
    const capture = TaskRepository.prototype.verificationExecutionContext
    let drifted = false
    const snapshot = vi.spyOn(TaskRepository.prototype, 'verificationExecutionContext').mockImplementation(async function (this: TaskRepository, taskId) {
      const result = await capture.call(this, taskId)
      if (!drifted) {
        drifted = true
        await writeFile(join(options.root, path), kind === 'adapter'
          ? dump({ adapters: Object.fromEntries(['typecheck', 'unit', 'build'].map(name => [name, {
            executable: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)},'replacement\\n')`],
          }])) })
          : `${await readFile(join(options.root, path), 'utf8')}\n`)
      }
      return result
    })
    try {
      await expect(runEngineeringTask(options)).rejects.toThrow(/identity changed|input changed/)
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      const task = (await getEngineeringStatus(options.root)).tasks[0]!
      expect(task.state.state).toBe('VERIFYING')
      await expect(readFile(join(options.root, '.agent/tasks', task.task.id, 'EVIDENCE.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      snapshot.mockRestore()
    }
  })

  it.each(['adapter', 'policy', 'profile'] as const)('rejects %s drift during a command before subsequent dispatch or evidence', async kind => {
    for (const checks of [['unit'], ['unit', 'build']]) {
      const options = await fixture()
      const projectPath = join(options.root, '.agent/config/project.yaml')
      await writeFile(projectPath, dump({ ...load(await readFile(projectPath, 'utf8')) as object, verificationPolicy: '.agent/config/verification-policy.yaml' }))
      await writeFile(join(options.root, '.agent/config/verification-policy.yaml'), dump(resolveVerificationPolicy(undefined)))
      await writeFile(join(options.root, '.agent/profiles/small-feature.yaml'), dump({ schemaVersion: 1, id: 'small-feature', checks: checks.map(name => ({ name, category: 'unit', required: true, timeoutMs: 30000 })) }))
      const path = kind === 'adapter' ? '.agent/adapters/test.yaml' : kind === 'policy' ? '.agent/config/verification-policy.yaml' : '.agent/profiles/small-feature.yaml'
      await mkdir(join(options.root, '.dsh'), { recursive: true })
      const marker = join(options.root, '.dsh/command-count')
      await writeFile(join(options.root, '.agent/adapters/test.yaml'), dump({ adapters: Object.fromEntries(checks.map(name => [name, {
        executable: process.execPath, args: ['-e', `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'spawn\\n');fs.appendFileSync(${JSON.stringify(join(options.root, path))},'\\n')`],
      }])) }))
      await expect(runEngineeringTask(options)).rejects.toThrow(/identity changed|input changed/)
      expect(await readFile(marker, 'utf8')).toBe('spawn\n')
      const task = (await getEngineeringStatus(options.root)).tasks[0]!
      expect(task.state.state).toBe('VERIFYING')
      await expect(readFile(join(options.root, '.agent/tasks', task.task.id, 'EVIDENCE.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(options.root, '.agent/tasks', task.task.id, 'VERIFY.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('awaits durable task selection before saving or creating a task', async () => {
    const options = await fixture()
    const selected = deferred()
    const release = deferred()
    let taskId = ''
    let roles = 0
    const pending = runEngineeringTask({ ...options, onTaskSelected: async id => {
      taskId = id
      selected.resolve()
      await release.promise
    }, executeRole: async input => {
      roles++
      return options.executeRole(input)
    } })
    try {
      await Promise.race([selected.promise, pending.then(() => { throw new Error('run completed before task selection') })])
      expect(roles).toBe(0)
      for (const filename of ['AUTO.json', 'TASK.json', 'STATE.json']) {
        await expect(readFile(join(options.root, '.agent/tasks', taskId, filename), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      release.resolve()
      await pending
    }
    expect(roles).toBeGreaterThan(0)
  })

  it('does not save or dispatch when durable task selection fails', async () => {
    const options = await fixture()
    let taskId = ''
    await expect(runEngineeringTask({ ...options, onTaskSelected: async id => {
      taskId = id
      throw new Error('claim persistence failed')
    }, executeRole: async () => { throw new Error('unexpected dispatch') } })).rejects.toThrow('claim persistence failed')
    await expect(readFile(join(options.root, '.agent/tasks', taskId, 'AUTO.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32').each(['timeout', 'cancel'])(
    'blocks uncertain provider %s independently of the executable basename', async mode => {
      const options = await fixture()
      const executable = join(options.root, '.agent/transport-driver')
      await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync('.agent/transport-ready','ready');setInterval(()=>{},1000)\n`)
      await chmod(executable, 0o700)
      await writeFile(join(options.root, '.agent/profiles/small-feature.yaml'), dump({ schemaVersion: 1, id: 'small-feature', checks: [
        { name: 'unit', category: 'focused', required: true, timeoutMs: mode === 'timeout' ? 300 : 30000 },
      ] }))
      await writeFile(join(options.root, '.agent/adapters/test.yaml'), dump({
        runners: { fixture: { kind: 'docker', executable, container: 'fixture-container', user: 'fixture', home: '/home/fixture', workingDirectory: options.root } },
        commands: { unit: { runner: 'fixture', executable: 'compiler-check', args: [], env: { set: {}, inherit: [] } } },
      }))
      const controller = new AbortController()
      const running = runEngineeringTask({ ...options, signal: controller.signal })
      const outcome = running.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
      try {
        if (mode === 'cancel') {
          await vi.waitFor(async () => { expect(await readFile(join(options.root, '.agent/transport-ready'), 'utf8')).toBe('ready') }, { timeout: 10000 })
          controller.abort()
        }
        const result = await outcome
        if (mode === 'timeout') expect(result.value).toMatchObject({ state: { state: 'BLOCKED' }, requiresStopConfirmation: true })
        else expect(result.error).toBeInstanceOf(Error)
        const task = (await getEngineeringStatus(options.root)).tasks[0]
        expect(task?.state).toMatchObject({ state: 'BLOCKED', writer: null, blocker: expect.stringContaining('termination is uncertain') })
        if (task === undefined) throw new Error('provider task missing')
        await expect(readFile(join(options.root, '.agent/tasks', task.task.id, 'DECISION.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        controller.abort()
        await outcome
      }
    },
    20000,
  )

  it('supplies repository instruction paths and skill metadata without preloading skill bodies', async () => {
    const options = await fixture()
    await mkdir(join(options.root, '.agents/skills/example'), { recursive: true })
    await writeFile(join(options.root, 'CONTRIBUTING.md'), 'PRIVATE INSTRUCTION BODY\n')
    await writeFile(join(options.root, '.agents/skills/example/SKILL.md'), '---\nname: example\ndescription: Read repository guidance.\n---\nPRIVATE SKILL BODY\n')
    await writeFile(join(options.root, '.agent/config/knowledge.yaml'), dump({ schemaVersion: 1, instructionFiles: ['CONTRIBUTING.md'], skillRoots: ['.agents/skills'] }))
    const path = join(options.root, '.agent/config/project.yaml')
    await writeFile(path, (await readFile(path, 'utf8')) + 'knowledge: .agent/config/knowledge.yaml\n')
    const roles: string[] = []
    const result = await runEngineeringTask({ ...options, executeRole: async invocation => {
      roles.push(invocation.role)
      expect(invocation.context.repositoryKnowledge).toEqual({ instructionFiles: ['CONTRIBUTING.md'], skills: [{ name: 'example', description: 'Read repository guidance.', path: '.agents/skills/example/SKILL.md' }] })
      expect(JSON.stringify(invocation.context)).not.toContain('PRIVATE')
      return options.executeRole(invocation)
    } })
    expect(result.state!.state).toBe('ACCEPTED')
    expect(roles).toEqual(['scout-primary', 'scout-secondary', 'architect', 'challenger', 'implementer', 'reviewer'])
  })

  it('rejects an absent declared knowledge file before role dispatch', async () => {
    const options = await fixture()
    const path = join(options.root, '.agent/config/project.yaml')
    await writeFile(path, (await readFile(path, 'utf8')) + 'knowledge: .agent/config/missing.yaml\n')
    const executeRole = vi.fn(options.executeRole)
    await expect(runEngineeringTask({ ...options, executeRole })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(executeRole).not.toHaveBeenCalled()
  })
  it('rejects a project whose profile declaration does not match its profile file before dispatch', async () => {
    const options = await fixture('synthetic-compiler')
    const filename = join(options.root, '.agent/profiles/synthetic-compiler.yaml')
    await writeFile(filename, (await readFile(filename, 'utf8')).replace('id: synthetic-compiler', 'id: other-compiler'))
    const executeRole = vi.fn(options.executeRole)
    await expect(runEngineeringTask({ ...options, executeRole })).rejects.toThrow('invalid synthetic-compiler profile')
    expect(executeRole).not.toHaveBeenCalled()
  })

  it('authorizes dispatch against the supplied deployment snapshot instead of rereading repository routes', async () => {
    const options = await fixture()
    await writeFile(join(options.root, '.agent/config/project.yaml'), dump({
      schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'internal',
      maxSteps: 40, maxRoleCalls: 30, commandTimeoutMs: 30_000,
    }))
    const executeRole = vi.fn(options.executeRole)
    const deployment = {
      ...options.deployment,
      routes: Object.fromEntries(Object.entries(options.deployment.routes).map(([name, route]) => [name, { ...route, maxDataClass: 'public' as const }])),
    }
    await expect(runEngineeringTask({ ...options, deployment, executeRole })).rejects.toThrow('does not allow internal')
    expect(executeRole).not.toHaveBeenCalled()
  })

  it('runs independent scouts concurrently and accepts actual command evidence', async () => {
    const options = await fixture()
    const entered = deferred()
    let scouts = 0
    const roles: string[] = []
    const result = await runEngineeringTask({ ...options, executeRole: async (input) => {
      roles.push(input.role)
      expect(input.state).not.toHaveProperty('writer')
      if (input.role.startsWith('scout-')) {
        scouts += 1
        if (scouts === 2) entered.resolve()
        await entered.promise
      }
      return options.executeRole(input)
    } })
    expect(result.state!.state).toBe('ACCEPTED')
    expect(roles).toEqual(['scout-primary', 'scout-secondary', 'architect', 'challenger', 'implementer', 'reviewer'])
    expect(await readFile(join(options.root, 'answer.txt'), 'utf8')).toBe('42')
    const directory = join(options.root, '.agent/tasks', result.taskId)
    const journal = JSON.parse(await readFile(join(directory, 'AUTO.json'), 'utf8'))
    expect(journal.roleCalls).toBe(6)
    const evidence = (await readFile(join(directory, 'EVIDENCE.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(evidence).toHaveLength(3)
    expect(evidence.every(item => item.command.exitCode === 0 && item.status === 'PASS')).toBe(true)
  })

  it('blocks a settled role failure without redispatching until explicit recovery', async () => {
    const options = await fixture()
    const roles: string[] = []
    const failed = await runEngineeringTask({ ...options, executeRole: async input => {
      roles.push(input.role)
      if (input.role === 'architect') throw new EngineeringRoleFailure('architect provider returned HTTP 404; correct its endpoint, then explicitly recover the task')
      return options.executeRole(input)
    } })
    expect(failed.state).toMatchObject({
      state: 'BLOCKED', writer: null,
      blocker: 'architect provider returned HTTP 404; correct its endpoint, then explicitly recover the task',
    })
    expect(failed.status).toBe('BLOCKED')
    expect(failed.nextAction).toBe('RECOVER')
    expect(failed.requiresStopConfirmation).toBe(false)
    expect(roles).toEqual(['scout-primary', 'scout-secondary', 'architect'])

    const repeated = await runEngineeringTask({ ...options, taskId: failed.taskId, request: '', executeRole: async () => {
      throw new Error('blocked task dispatched a role')
    } })
    expect(repeated).toMatchObject({ status: 'BLOCKED', nextAction: 'RECOVER', requiresStopConfirmation: false })
    expect(repeated.state!.state).toBe('BLOCKED')
    expect(JSON.parse(await readFile(join(options.root, '.agent/tasks', failed.taskId, 'AUTO.json'), 'utf8'))).toMatchObject({ roleCalls: 3 })

    await recoverEngineeringTask(options.root, failed.taskId, false)
    await expect(runEngineeringTask({ ...options, taskId: failed.taskId, request: '' })).resolves.toMatchObject({ state: { state: 'ACCEPTED' } })
  })

  it('maps a missing product-scope blocker to replan with scope', async () => {
    const options = await fixture()
    const failed = await runEngineeringTask({ ...options, executeRole: async input => {
      if (input.role === 'architect') throw new EngineeringRoleFailure('Missing product scope information; ask the operator for the required scope before continuing')
      return options.executeRole(input)
    } })
    expect(failed.status).toBe('BLOCKED')
    expect(failed.nextAction).toBe('REPLAN_WITH_SCOPE')
    expect(failed.requiresStopConfirmation).toBe(false)
  })

  it('releases the implementer lease before blocking its settled role failure', async () => {
    const options = await fixture()
    const failed = await runEngineeringTask({ ...options, executeRole: async input => {
      if (input.role === 'implementer') throw new EngineeringRoleFailure('implementer stopped')
      return options.executeRole(input)
    } })
    expect(failed).toMatchObject({ state: { state: 'BLOCKED', writer: null, blocker: 'implementer stopped' }, nextAction: 'RECOVER', requiresStopConfirmation: false })
  })

  it('quarantines cancelled Scout cleanup until stopped work is explicitly confirmed', async () => {
    const options = await fixture()
    const controller = new AbortController()
    const disposing = deferred()
    const rejectCleanup = deferred()
    const stopBackground = deferred()
    let backgroundLive = true
    const backgroundStopped = stopBackground.promise.then(() => { backgroundLive = false })
    const repository = new TaskRepository(options.root)
    let taskId = ''
    const noDispatch = vi.fn(async () => { throw new Error('Role dispatched before cleanup was confirmed') })
    const pending = runEngineeringTask({ ...options, signal: controller.signal,
      onTaskSelected: async id => { taskId = id }, executeRole: async input => {
        if (input.role !== 'scout-primary') return options.executeRole(input)
        return collectRole({
          id: SessionId('cancelled-scout-child'), localAgent: undefined,
          result: Promise.resolve({ stopReason: 'completed', output: [], structured: investigation }),
          async dispose() {
            disposing.resolve()
            await rejectCleanup.promise
            if (backgroundLive) throw new Error('Scout background work termination is uncertain')
          },
        }, input.role, input.route.provider, input.route.model, input.signal)
      },
    })
    const settled = pending.then(result => {
      expect(result.status).not.toBe('ACCEPTED')
      return undefined
    }, (error: unknown) => error)
    try {
      await disposing.promise
      controller.abort()
      rejectCleanup.resolve()
      expect(await settled).toBeInstanceOf(Error)
      const state = await repository.readState(taskId)
      expect(state).toMatchObject({ state: 'BLOCKED', writer: null, blocker: expect.stringMatching(/termination is uncertain/i) })
      expect(backgroundLive).toBe(true)
      await expect(runEngineeringTask({ ...options, taskId, request: '', executeRole: noDispatch })).rejects.toThrow(/requires confirmation/)
      const otherTaskId = 'other-cancelled-scout-task'
      await repository.createTask({ schemaVersion: 1, id: otherTaskId, title: 'Other task', profile: 'small-feature', dataClass: 'public', createdAt: new Date().toISOString() })
      await expect(runEngineeringTask({ ...options, taskId: otherTaskId, request: '', executeRole: noDispatch })).rejects.toThrow()
      expect(noDispatch).not.toHaveBeenCalled()
      await expect(recoverEngineeringTask(options.root, taskId, false)).rejects.toThrow(/requires confirmation/)
      stopBackground.resolve()
      await backgroundStopped
      await expect(recoverEngineeringTask(options.root, taskId, true)).resolves.toMatchObject({ state: 'REPLAN', writer: null })
    } finally {
      rejectCleanup.resolve()
      stopBackground.resolve()
      await Promise.all([settled, backgroundStopped])
    }
  })

  it('retains uncertain writer authority when route-attempt audit persistence fails', async () => {
    const options = await fixture()
    const stopBackground = deferred()
    let backgroundLive = true
    const backgroundStopped = stopBackground.promise.then(() => { backgroundLive = false })
    const repository = new TaskRepository(options.root)
    let taskId = ''
    try {
      await runEngineeringTask({ ...options, onTaskSelected: async id => { taskId = id }, executeRole: async input => {
        if (input.role !== 'implementer') return options.executeRole(input)
        await mkdir(join(options.root, '.agent/tasks', taskId, 'ROUTE_ATTEMPTS.implementer.jsonl'))
        input.markMutationStarted?.()
        return collectRole({
          id: SessionId('audit-failed-writer-child'), localAgent: undefined,
          result: Promise.resolve({ stopReason: 'completed', output: [], structured: { summary: 'Child result before uncertain cleanup' } }),
          async dispose() { if (backgroundLive) throw new Error('Writer background work termination is uncertain') },
        }, input.role, input.route.provider, input.route.model, input.signal)
      } }).then(result => {
        expect(result.status).not.toBe('ACCEPTED')
        expect(result).toMatchObject({ status: 'BLOCKED', nextAction: 'RECOVER', requiresStopConfirmation: true })
        expect(result.summary).toMatch(/cleanup failed/)
      }, (error: unknown) => {
        expect(error).toBeInstanceOf(RoleQuiescenceError)
        if (!(error instanceof RoleQuiescenceError)) throw new Error('Fixture did not retain its quiescence error')
        expect(error.message).toMatch(/cleanup failed/)
        expect(error.cause).toBeInstanceOf(AggregateError)
        if (!(error.cause instanceof AggregateError)) throw new Error('Fixture did not retain both failure causes')
        const causes: unknown[] = error.cause.errors
        expect(causes).toEqual(expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining('Writer background work termination is uncertain') }),
          expect.objectContaining({ code: 'EISDIR' }),
        ]))
      })
      expect((await repository.readState(taskId)).writer).not.toBeNull()
      expect(backgroundLive).toBe(true)
      const noDispatch = vi.fn(async () => { throw new Error('Role dispatched before uncertain writer stopped') })
      await expect(runEngineeringTask({ ...options, taskId, request: '', executeRole: noDispatch })).rejects.toThrow()
      const otherTaskId = 'other-audit-failed-task'
      await repository.createTask({ schemaVersion: 1, id: otherTaskId, title: 'Other task', profile: 'small-feature', dataClass: 'public', createdAt: new Date().toISOString() })
      await expect(runEngineeringTask({ ...options, taskId: otherTaskId, request: '', executeRole: noDispatch })).rejects.toThrow()
      expect(noDispatch).not.toHaveBeenCalled()
      await expect(recoverEngineeringTask(options.root, taskId, false)).rejects.toThrow(/requires confirmation/)
      stopBackground.resolve()
      await backgroundStopped
      await expect(recoverEngineeringTask(options.root, taskId, true)).resolves.toMatchObject({ state: 'REPLAN', writer: null })
    } finally {
      stopBackground.resolve()
      await backgroundStopped
    }
  })

  it.each(['completed', 'error'] as const)('retains repository writer authority when %s child cleanup cannot confirm stopped work', async stopReason => {
    const options = await fixture()
    const repository = new TaskRepository(options.root)
    const otherTaskId = 'other-frozen-task'
    const stopBackground = deferred()
    let backgroundLive = true
    const backgroundStopped = stopBackground.promise.then(() => { backgroundLive = false })
    let taskId = ''
    const noDispatch = vi.fn(async () => { throw new Error('A second role was dispatched while background work was live') })
    try {
      await runEngineeringTask({ ...options, onTaskSelected: async id => { taskId = id }, executeRole: async input => {
        if (input.role !== 'implementer') return options.executeRole(input)
        input.markMutationStarted?.()
        return collectRole({
          id: SessionId('uncertain-writer-child'), localAgent: undefined,
          result: Promise.resolve({ stopReason, output: [], ...(stopReason === 'completed' ? { structured: { summary: 'Child finished while owned command remained active' } } : {}) }),
          async dispose() {
            if (backgroundLive) throw new Error('Background command termination is uncertain')
          },
        }, 'implementer', input.route.provider, input.route.model, input.signal)
      } }).then(result => {
        expect(result.status).not.toBe('ACCEPTED')
        expect(result).toMatchObject({ status: 'BLOCKED', summary: expect.stringMatching(/cleanup failed/) })
      }, (error: unknown) => {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toMatch(/cleanup failed/)
      })
      expect(backgroundLive).toBe(true)
      const interrupted = await repository.readState(taskId)
      expect.soft(interrupted.writer).not.toBeNull()
      await expect.soft(runEngineeringTask({ ...options, taskId, request: '', executeRole: noDispatch })).rejects.toThrow(/interrupted writer/)
      await repository.createTask({ schemaVersion: 1, id: otherTaskId, title: 'Other frozen task', profile: 'small-feature', dataClass: 'public', createdAt: new Date().toISOString() })
      await repository.baseline(otherTaskId, 0, { repositoryHead: 'fixture', dirty: false, summary: 'Clean baseline' })
      await repository.investigate(otherTaskId, 1, investigation)
      await repository.freezePlan(otherTaskId, 2, plan)
      await writeFile(join(options.root, '.agent/tasks', otherTaskId, 'AUTO.json'), JSON.stringify({
        schemaVersion: 1, requests: [options.request], steps: 0, roleCalls: 0, completedWriterRevision: null,
        pendingTask: null, verifiedTreeHash: null,
      }))
      await expect.soft(runEngineeringTask({ ...options, taskId: otherTaskId, request: '', executeRole: noDispatch })).rejects.toThrow(/interrupted writer|writer.*active|writer.*stop/i)
      expect.soft(noDispatch).not.toHaveBeenCalled()
      await expect.soft(recoverEngineeringTask(options.root, taskId, false)).rejects.toThrow(/requires confirmation/)
      expect(backgroundLive).toBe(true)
      stopBackground.resolve()
      await backgroundStopped
      expect(backgroundLive).toBe(false)
      await expect(recoverEngineeringTask(options.root, taskId, true)).resolves.toMatchObject({ state: 'REPLAN', writer: null })
    } finally {
      stopBackground.resolve()
      await backgroundStopped
    }
  })

  it('uses the repository lock to reject a concurrent run before another writer starts', async () => {
    const options = await fixture()
    const entered = deferred()
    const release = deferred()
    const first = runEngineeringTask({ ...options, executeRole: async input => {
      if (input.role === 'implementer') { entered.resolve(); await release.promise }
      return options.executeRole(input)
    } })
    try {
      await entered.promise
      const duplicate = await runEngineeringTask(options)
      expect(duplicate).toMatchObject({ status: 'RUN_ALREADY_ACTIVE', nextAction: 'WAIT_FOR_CURRENT_RUN' })
      const task = (await getEngineeringStatus(options.root)).tasks[0]
      if (task === undefined) throw new Error('fixture task missing')
      await expect(recoverEngineeringTask(options.root, task.task.id, true)).rejects.toThrow('writer lock')
      expect((await getEngineeringStatus(options.root)).tasks[0]?.state).toEqual(task.state)
    } finally {
      release.resolve()
      await first
    }
  })

  it('does not take over a lock held by another live process', async () => {
    const options = await fixture()
    const executeRole = vi.fn(options.executeRole)
    const child = spawn(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], process.pid+'\\n', {flag:'wx',mode:0o600});process.stdout.write('ready');setInterval(()=>{},1000)", join(options.root, '.agent/AUTO_RUN.lock')], { stdio: ['ignore', 'pipe', 'pipe'] })
    const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject) })
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('lock holder exited before readiness'))) })
      const duplicate = await runEngineeringTask({ ...options, executeRole })
      expect(duplicate).toMatchObject({ status: 'RUN_ALREADY_ACTIVE', nextAction: 'WAIT_FOR_CURRENT_RUN' })
      expect(executeRole).not.toHaveBeenCalled()
      expect((await getEngineeringStatus(options.root)).tasks).toHaveLength(0)
    } finally {
      child.kill('SIGKILL')
      await closed
    }
    const result = await runEngineeringTask(options)
    expect(result.state!.state).toBe('ACCEPTED')
  })

  it('throws on a timed-out corrupt AUTO_RUN lock without dispatching work or taking it over', async () => {
    const options = await fixture()
    const executeRole = vi.fn(options.executeRole)
    const lockPath = join(options.root, '.agent/AUTO_RUN.lock')
    await writeFile(lockPath, 'incomplete', { mode: 0o600 })

    await expect(runEngineeringTask({ ...options, executeRole })).rejects.toThrow(/timed out waiting for the writer lock/)
    expect(executeRole).not.toHaveBeenCalled()
    expect(await readFile(lockPath, 'utf8')).toBe('incomplete')
    expect((await getEngineeringStatus(options.root)).tasks).toHaveLength(0)
  })

  it('does not classify an inner STATE lock timeout as an active engineering run', async () => {
    const options = await fixture()
    const taskId = 'locked-state'
    const repository = new TaskRepository(options.root)
    await repository.createTask({
      schemaVersion: 1, id: taskId, title: 'Locked state', profile: 'small-feature', dataClass: 'public', createdAt: new Date().toISOString(),
    })
    await writeFile(join(options.root, '.agent/tasks', taskId, 'AUTO.json'), JSON.stringify({
      schemaVersion: 1, requests: [options.request], steps: 0, roleCalls: 0, completedWriterRevision: null,
      pendingTask: null, verifiedTreeHash: null,
    }))
    const statePath = join(options.root, '.agent/tasks', taskId, 'STATE.json')
    const acquired = deferred()
    const release = deferred()
    const holder = withFileLock(statePath, async () => { acquired.resolve(); await release.promise })
    const executeRole = vi.fn(options.executeRole)
    try {
      await acquired.promise
      await expect(runEngineeringTask({ ...options, taskId, request: '', executeRole }))
        .rejects.toThrow(`atomic-write: timed out waiting for the writer lock at ${statePath}.lock`)
      expect(executeRole).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await holder
    }
  })

  it('releases a cancelled writer only after its executor stops and resumes the unique task', async () => {
    const options = await fixture()
    const controller = new AbortController()
    await expect(runEngineeringTask({ ...options, signal: controller.signal, executeRole: async input => {
      if (input.role === 'implementer') { controller.abort(); throw new Error('executor stopped') }
      return options.executeRole(input)
    } })).rejects.toThrow('executor stopped')
    const before = await getEngineeringStatus(options.root)
    expect(before.tasks[0]?.state).toMatchObject({ state: 'IMPLEMENTING', writer: null })
    const resumed = await runEngineeringTask({ ...options, request: '' })
    expect(resumed.taskId).toBe(before.tasks[0]?.task.id)
    expect(resumed.state!.state).toBe('ACCEPTED')
  })

  it('refuses an uncheckpointed writer left by an interrupted process', async () => {
    const options = await fixture()
    await expect(runEngineeringTask({ ...options, executeRole: async input => {
      if (input.role === 'implementer') throw new Error('stopped')
      return options.executeRole(input)
    } })).rejects.toThrow('stopped')
    const task = (await getEngineeringStatus(options.root)).tasks[0]
    if (task === undefined) throw new Error('fixture task missing')
    await new TaskRepository(options.root).startImplementation(task.task.id, task.state.revision)
    await expect(runEngineeringTask(options)).rejects.toThrow('interrupted writer')
  })

  it('requires operator confirmation before releasing an interrupted writer and replanning', async () => {
    const options = await fixture()
    await expect(runEngineeringTask({ ...options, executeRole: async input => {
      if (input.role === 'implementer') throw new Error('stopped')
      return options.executeRole(input)
    } })).rejects.toThrow('stopped')
    const task = (await getEngineeringStatus(options.root)).tasks[0]
    if (task === undefined) throw new Error('fixture task missing')
    await new TaskRepository(options.root).startImplementation(task.task.id, task.state.revision)
    await expect(recoverEngineeringTask(options.root, task.task.id, false)).rejects.toThrow('requires confirmation')
    await expect(recoverEngineeringTask(options.root, task.task.id, true)).resolves.toMatchObject({ state: 'REPLAN', writer: null })
  })

  it('preserves an exhausted lifecycle budget after recovery when no durable work remains active', async () => {
    const options = await fixture()
    await writeFile(join(options.root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 40, maxRoleCalls: 6, commandTimeoutMs: 30000 }))
    const exhausted = await runEngineeringTask({ ...options, executeRole: async input => input.role === 'challenger'
      ? { decision: 'REVISE', summary: 'Refine the acceptance criteria', findings: ['Clarify output'] }
      : options.executeRole(input) })
    expect(exhausted).toMatchObject({ status: 'BUDGET_EXHAUSTED', nextAction: 'INCREASE_BUDGET', requiresStopConfirmation: false })
    const task = (await getEngineeringStatus(options.root)).tasks[0]
    if (task === undefined) throw new Error('fixture task missing')
    expect(task.state).toMatchObject({ state: 'BUDGET_EXHAUSTED', writer: null })
    const directory = join(options.root, '.agent/tasks', task.task.id)
    expect(JSON.parse(await readFile(join(directory, 'AUTO.json'), 'utf8'))).toMatchObject({ roleCalls: 6 })
    const lifecycle = await readFile(join(directory, 'LIFECYCLE.json'), 'utf8')
    expect(JSON.parse(lifecycle)).toMatchObject({ counts: { logicalInvocations: 6 } })
    await expect(recoverEngineeringTask(options.root, task.task.id, false)).resolves.toMatchObject({ state: 'REPLAN', writer: null })
    expect(JSON.parse(await readFile(join(directory, 'AUTO.json'), 'utf8'))).toMatchObject({
      steps: 0, roleCalls: 0, completedWriterRevision: null, verifiedTreeHash: null, requests: [options.request],
    })
    const executeRole = vi.fn(options.executeRole)
    const resumed = await runEngineeringTask({ ...options, request: '', taskId: task.task.id, executeRole })
    expect(resumed).toMatchObject({ status: 'BUDGET_EXHAUSTED', state: { state: 'BUDGET_EXHAUSTED', writer: null } })
    expect(executeRole).not.toHaveBeenCalled()
    expect(resumed.taskId).toBe(task.task.id)
    expect(JSON.parse(await readFile(join(directory, 'AUTO.json'), 'utf8'))).toMatchObject({ roleCalls: 0 })
    expect(await readFile(join(directory, 'LIFECYCLE.json'), 'utf8')).toBe(lifecycle)
  })

  it('invalidates verification checkpoints when recovering a paused review', async () => {
    const options = await fixture()
    await expect(runEngineeringTask({ ...options, executeRole: async input => {
      if (input.role === 'reviewer') throw new Error('paused review')
      return options.executeRole(input)
    } })).rejects.toThrow('paused review')
    const task = (await getEngineeringStatus(options.root)).tasks[0]
    if (task === undefined) throw new Error('fixture task missing')
    const path = join(options.root, '.agent/tasks', task.task.id, 'AUTO.json')
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      completedWriterRevision: expect.any(Number), verifiedTreeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    await recoverEngineeringTask(options.root, task.task.id, true)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      steps: 0, roleCalls: 0, completedWriterRevision: null, verifiedTreeHash: null,
    })
  })

  it('preserves accepted state and budgets when recovery is requested', async () => {
    const options = await fixture()
    const accepted = await runEngineeringTask(options)
    const directory = join(options.root, '.agent/tasks', accepted.taskId)
    const journal = await readFile(join(directory, 'AUTO.json'), 'utf8')
    const state = await readFile(join(directory, 'STATE.json'), 'utf8')
    await expect(recoverEngineeringTask(options.root, accepted.taskId, true)).rejects.toThrow('accepted tasks are terminal')
    expect(await readFile(join(directory, 'AUTO.json'), 'utf8')).toBe(journal)
    expect(await readFile(join(directory, 'STATE.json'), 'utf8')).toBe(state)
  })

  it('bounds repeated verification failures and replans after two failed attempts', async () => {
    const options = await fixture()
    const transitions: string[] = []
    await writeFile(join(options.root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 12, maxRoleCalls: 30, commandTimeoutMs: 30000 }))
    await expect(runEngineeringTask({ ...options, onProgress: state => { transitions.push(state.state) }, executeRole: async input => input.role === 'implementer' ? { summary: 'Claimed success without writing' } : options.executeRole(input) })).rejects.toThrow('step budget exhausted')
    expect(transitions).toContain('REPLAN')
    expect(transitions).not.toContain('ACCEPTED')
    await expect(runEngineeringTask(options)).rejects.toThrow('step budget exhausted')
  }, 30000)

  it('rejects missing required adapters before dispatching a model', async () => {
    const options = await fixture()
    await writeFile(join(options.root, '.agent/adapters/test.yaml'), 'adapters: {}\n')
    await expect(runEngineeringTask({ ...options, executeRole: async () => { throw new Error('unexpected model dispatch') } })).rejects.toThrow('missing required verification adapter')
  })

  it('bounds rejected plans without granting a writer lease', async () => {
    const options = await fixture()
    await writeFile(join(options.root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 40, maxRoleCalls: 5, commandTimeoutMs: 30000 }))
    const result = await runEngineeringTask({ ...options, executeRole: async input => input.role === 'challenger' ? { decision: 'REVISE', summary: 'Acceptance is underspecified', findings: ['Specify target'] } : options.executeRole(input) })
    expect(result).toMatchObject({ status: 'BUDGET_EXHAUSTED', nextAction: 'INCREASE_BUDGET' })
    expect((await getEngineeringStatus(options.root)).tasks[0]?.state).toMatchObject({ state: 'BUDGET_EXHAUSTED', writer: null })
    expect(JSON.parse(await readFile(join(options.root, '.agent/tasks', result.taskId, 'LIFECYCLE.json'), 'utf8'))).toMatchObject({ counts: { logicalInvocations: 5 } })
  })

  it('blocks invalid structured role output and preserves the investigation checkpoint', async () => {
    const options = await fixture()
    const result = await runEngineeringTask({ ...options, executeRole: async input => input.role === 'architect' ? { selectedApproach: 'Do it' } : options.executeRole(input) })
    expect(result.status).toBe('BLOCKED')
    expect(result.state!.state).toBe('BLOCKED')
    expect(result.summary).toContain('architect returned invalid output')
    expect((await getEngineeringStatus(options.root)).tasks[0]?.state.state).toBe('BLOCKED')
    expect(JSON.parse(await readFile(join(options.root, '.agent/tasks', result.taskId, 'INVESTIGATION.json'), 'utf8'))).toMatchObject({ schemaVersion: 1 })
  })

  it('refuses acceptance when a resumed verification omits the required gates', async () => {
    const options = await fixture()
    await expect(runEngineeringTask({ ...options, executeRole: async input => {
      if (input.role === 'reviewer') {
        const filename = join(options.root, '.agent/tasks', input.taskId, 'VERIFY.json')
        const verification = JSON.parse(await readFile(filename, 'utf8'))
        verification.checks = []
        await writeFile(filename, JSON.stringify(verification))
      }
      return options.executeRole(input)
    } })).rejects.toThrow('verification artifact is invalid: /checks')
    expect((await getEngineeringStatus(options.root)).tasks[0]?.state.state).toBe('REVIEWED')
  })

  it('does not reuse verification evidence after the worktree changes', async () => {
    const options = await fixture()
    await expect(runEngineeringTask({ ...options, executeRole: async input => {
      if (input.role === 'reviewer') throw new Error('paused before review')
      return options.executeRole(input)
    } })).rejects.toThrow('paused before review')
    const task = (await getEngineeringStatus(options.root)).tasks[0]
    if (task === undefined) throw new Error('fixture task missing')
    expect(task.state.state).toBe('VERIFIED')
    await writeFile(join(options.root, 'answer.txt'), 'changed after verification')
    await expect(runEngineeringTask({ ...options, taskId: task.task.id, request: '' })).rejects.toThrow('source or required-set identity changed')
    expect((await getEngineeringStatus(options.root, task.task.id)).tasks[0]?.state.state).toBe('VERIFIED')
    await expect(recoverEngineeringTask(options.root, task.task.id, false)).rejects.toThrow('requires confirmation')
    await expect(recoverEngineeringTask(options.root, task.task.id, true)).resolves.toMatchObject({ state: 'REPLAN' })
  })

  it('does not reuse verification evidence after HEAD changes to the same verified files', async () => {
    const options = await fixture()
    await expect(runEngineeringTask({ ...options, executeRole: async input => {
      if (input.role === 'reviewer') throw new Error('paused before review')
      return options.executeRole(input)
    } })).rejects.toThrow('paused before review')
    const task = (await getEngineeringStatus(options.root)).tasks[0]
    if (task === undefined) throw new Error('fixture task missing')
    await exec('git', ['add', 'answer.txt'], { cwd: options.root })
    await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'move verified content into HEAD'], { cwd: options.root })
    await expect(runEngineeringTask({ ...options, taskId: task.task.id, request: '' })).rejects.toThrow('repository HEAD changed')
  })

  it.each(['small-feature', 'synthetic-compiler'])('recovers the same %s pending task when initial state creation was interrupted', async profile => {
    const options = await fixture(profile)
    const create = vi.spyOn(TaskRepository.prototype, 'createTask').mockRejectedValueOnce(new Error('interrupted initial state write'))
    try {
      await expect(runEngineeringTask(options)).rejects.toThrow('interrupted initial state write')
    } finally {
      create.mockRestore()
    }
    const status = await getEngineeringStatus(options.root)
    expect(status.tasks).toEqual([])
    expect(status.pendingTasks).toHaveLength(1)
    expect(status.pendingTasks[0]?.profile).toBe(profile)
    const result = await runEngineeringTask(options)
    expect(result.taskId).toBe(status.pendingTasks[0]?.id)
    expect(result.state!.state).toBe('ACCEPTED')
  })

  it('requires an explicit replan before changing an existing frozen task request', async () => {
    const options = await fixture()
    await expect(runEngineeringTask({ ...options, executeRole: async input => {
      if (input.role === 'implementer') throw new Error('paused implementation')
      return options.executeRole(input)
    } })).rejects.toThrow('paused implementation')
    const task = (await getEngineeringStatus(options.root)).tasks[0]
    if (task === undefined) throw new Error('fixture task missing')
    const changed = { ...options, taskId: task.task.id, request: 'Also inspect the surrounding files' }
    await expect(runEngineeringTask(changed)).rejects.toThrow('request differs')
    await new TaskRepository(options.root).replan(task.task.id, task.state.revision)
    const requests: string[] = []
    const result = await runEngineeringTask({ ...changed, executeRole: async input => { requests.push(input.request); return options.executeRole(input) } })
    expect(result.state!.state).toBe('ACCEPTED')
    expect(requests[0]).toContain(options.request)
    expect(requests[0]).toContain(changed.request)
  })
})

describe('role route fallback', () => {
  function routeAttemptPath(root: string, taskId: string, role: string) {
    return join(root, '.agent/tasks', taskId, `ROUTE_ATTEMPTS.${role}.jsonl`)
  }

  async function readRouteAttempts(root: string, taskId: string, role: string) {
    const source = await readFile(routeAttemptPath(root, taskId, role), 'utf8')
    return source.trim().split('\n').map(line => JSON.parse(line))
  }

  it.each(['provider-before-tools', 'provider-after-mutation', 'schema-after-mutation', 'fallback-after-mutation'] as const)('guards implementer fallback for %s', async failure => {
    const options = await fixture()
    const dispatches: number[] = []
    const result = await runEngineeringTask({ ...options, executeRole: async input => {
      if (input.role !== 'implementer') return options.executeRole(input)
      dispatches.push(input.attemptIndex)
      if (input.attemptIndex === 1 || failure === 'fallback-after-mutation') {
        if (failure !== 'provider-before-tools' && (failure !== 'fallback-after-mutation' || input.attemptIndex === 2)) input.markMutationStarted?.()
        if (failure === 'schema-after-mutation') return { invalid: true }
        throw new RoleInvocationError('Writer provider failed', 'PROVIDER_REQUEST_FAILURE', true)
      }
      return options.executeRole(input)
    } })
    expect(dispatches).toEqual(failure === 'provider-before-tools' || failure === 'fallback-after-mutation' ? [1, 2] : [1])
    expect(result.status).toBe(failure === 'provider-before-tools' ? 'ACCEPTED' : 'BLOCKED')
    const attempts = await readRouteAttempts(options.root, result.taskId, 'implementer')
    expect(attempts.at(-1)?.failureClass).toBe(failure === 'provider-before-tools' ? undefined : 'NON_FALLBACKABLE')
  })

  it('keeps a successful primary route and never starts its fallback', async () => {
    const options = await fixture()
    const dispatches: Array<{ role: string; routeId: string }> = []
    const result = await runEngineeringTask({ ...options, executeRole: async input => {
      dispatches.push({ role: input.role, routeId: input.route.routeId })
      return options.executeRole(input)
    } })
    expect(result.status).toBe('ACCEPTED')
    expect(dispatches.filter(entry => entry.routeId === 'worker-secondary-fallback')).toEqual([])
    expect(dispatches.filter(entry => entry.role === 'scout-secondary').map(entry => entry.routeId)).toEqual(['worker-secondary'])
    expect(dispatches.filter(entry => entry.role === 'challenger').map(entry => entry.routeId)).toEqual(['worker-secondary'])
  })

  it.each(['scout-secondary', 'challenger'])('runs a bounded %s fallback once after a classified primary route failure', async role => {
    const options = await fixture()
    const dispatches: Array<{ role: string; routeId: string; attemptIndex: number; state: RoleInvocation['state'] }> = []
    const result = await runEngineeringTask({ ...options, executeRole: async input => {
      dispatches.push({ role: input.role, routeId: input.route.routeId, attemptIndex: input.attemptIndex, state: { ...input.state } })
      if (input.role === role && input.route.routeId === 'worker-secondary') {
        throw new RoleInvocationError('injected GLM provider failure', 'PROVIDER_REQUEST_FAILURE', true)
      }
      return options.executeRole(input)
    } })
    expect(result.status).toBe('ACCEPTED')
    const roleDispatches = dispatches.filter(entry => entry.role === role)
    expect(roleDispatches.map(entry => entry.routeId)).toEqual(['worker-secondary', 'worker-secondary-fallback'])
    expect(roleDispatches.map(entry => entry.attemptIndex)).toEqual([1, 2])
    expect(roleDispatches[1]!.state).toEqual(roleDispatches[0]!.state)
    expect(roleDispatches[0]!.state.fixAttempts).toBe(0)
    expect(result.state?.fixAttempts).toBe(0)
    const attemptLog = await readFile(routeAttemptPath(options.root, result.taskId, role), 'utf8')
    const attempts = attemptLog.trim().split('\n').map(line => JSON.parse(line))
    expect(attempts).toHaveLength(2)
    expect(attemptLog.endsWith('\n')).toBe(true)
    expect(attempts).toEqual([
      {
        schemaVersion: 1, role, attemptIndex: 1, routeId: 'worker-secondary', provider: 'magpie',
        model: options.deployment.routes['worker-secondary']!.model, reasoningEffort: 'off',
        startedAt: expect.any(String), endedAt: expect.any(String), outcome: 'FAILED',
        failureClass: 'PROVIDER_REQUEST_FAILURE', fallbackReason: 'injected GLM provider failure',
      },
      {
        schemaVersion: 1, role, attemptIndex: 2, routeId: 'worker-secondary-fallback', provider: 'magpie',
        model: options.deployment.routes['worker-secondary-fallback']!.model, reasoningEffort: 'off',
        startedAt: expect.any(String), endedAt: expect.any(String), outcome: 'SUCCESS',
      },
    ])
  })

  it.each(['scout-secondary', 'challenger'])('blocks once when all %s routes fail and records every attempt', async role => {
    const options = await fixture()
    const result = await runEngineeringTask({ ...options, executeRole: async input => {
      if (input.role !== role) return options.executeRole(input)
      const model = input.route.routeId === 'worker-secondary' ? 'MiMo' : input.route.routeId === 'worker-secondary-fallback' ? 'GLM' : 'Qwen'
      const message = `injected ${model} provider failure`
      throw new RoleInvocationError(message, 'PROVIDER_REQUEST_FAILURE', true)
    } })
    expect(result.status).toBe('BLOCKED')
    expect(result.state!.state).toBe('BLOCKED')
    expect(result.summary).toContain('injected Qwen provider failure')
    const attempts = await readRouteAttempts(options.root, result.taskId, role)
    expect(attempts).toHaveLength(3)
    expect(attempts.map(attempt => attempt.routeId)).toEqual(['worker-secondary', 'worker-secondary-fallback', 'worker-fallback'])
    expect(attempts.every(attempt => attempt.outcome === 'FAILED')).toBe(true)
    const repeated = await runEngineeringTask({ ...options, taskId: result.taskId, request: '', executeRole: async () => { throw new Error('unexpected repeated role') } })
    expect(repeated.state?.revision).toBe(result.state?.revision)
    expect(await readRouteAttempts(options.root, result.taskId, role)).toEqual(attempts)
  })

  it.each(['scout-secondary', 'challenger'])('tries Qwen after both MiMo and GLM fail for %s', async role => {
    const options = await fixture()
    const result = await runEngineeringTask({ ...options, executeRole: async input => {
      if (input.role === role && input.route.routeId !== 'worker-fallback') {
        throw new RoleInvocationError('provider unavailable', 'PROVIDER_REQUEST_FAILURE', true)
      }
      return options.executeRole(input)
    } })
    expect(result.status).toBe('ACCEPTED')
    const attempts = await readRouteAttempts(options.root, result.taskId, role)
    expect(attempts.map(attempt => ({ routeId: attempt.routeId, outcome: attempt.outcome }))).toEqual([
      { routeId: 'worker-secondary', outcome: 'FAILED' },
      { routeId: 'worker-secondary-fallback', outcome: 'FAILED' },
      { routeId: 'worker-fallback', outcome: 'SUCCESS' },
    ])
  })

  it('runs one bounded fallback after the runtime maps a stable route-resolution failure', async () => {
    const options = await fixture()
    const dispatches: Array<{ role: string; routeId: string }> = []
    const result = await runEngineeringTask({ ...options, executeRole: async input => {
      dispatches.push({ role: input.role, routeId: input.route.routeId })
      if (input.role === 'scout-secondary' && input.route.routeId === 'worker-secondary') {
        const failure = roleInvocationErrorForLlmCode('NO_ADAPTER', 'primary route could not resolve an adapter')
        if (failure === undefined) throw new Error('NO_ADAPTER was not classified')
        throw failure
      }
      return options.executeRole(input)
    } })
    expect(result.status).toBe('ACCEPTED')
    expect(dispatches.filter(entry => entry.role === 'scout-secondary').map(entry => entry.routeId))
      .toEqual(['worker-secondary', 'worker-secondary-fallback'])
    const attempts = await readRouteAttempts(options.root, result.taskId, 'scout-secondary')
    expect(attempts.map(attempt => ({ routeId: attempt.routeId, failureClass: attempt.failureClass }))).toEqual([
      { routeId: 'worker-secondary', failureClass: 'ROUTE_EXECUTION_FAILURE' },
      { routeId: 'worker-secondary-fallback', failureClass: undefined },
    ])
  })

  it.each(['scout-secondary', 'challenger'])('falls back once when primary %s structured output is invalid', async role => {
    const options = await fixture()
    const dispatches: Array<{ role: string; routeId: string }> = []
    const result = await runEngineeringTask({ ...options, executeRole: async input => {
      dispatches.push({ role: input.role, routeId: input.route.routeId })
      if (input.role === role && input.route.routeId === 'worker-secondary') return { findings: ['incomplete'] }
      return options.executeRole(input)
    } })
    expect(result.status).toBe('ACCEPTED')
    expect(dispatches.filter(entry => entry.role === role).map(entry => entry.routeId)).toEqual(['worker-secondary', 'worker-secondary-fallback'])
    const attempts = await readRouteAttempts(options.root, result.taskId, role)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toMatchObject({ routeId: 'worker-secondary', outcome: 'FAILED', failureClass: 'SCHEMA_INVALID' })
  })

  it.each(['worker-secondary-fallback', 'worker-secondary'])('never dispatches the policy-forbidden %s route', async deniedRoute => {
    const options = await fixture()
    const projectPath = join(options.root, '.agent/config/project.yaml')
    await writeFile(projectPath, dump({ ...load(await readFile(projectPath, 'utf8')) as object, dataClass: 'internal' }))
    const deployment = { ...options.deployment, routes: { ...options.deployment.routes,
      [deniedRoute]: { ...options.deployment.routes[deniedRoute]!, maxDataClass: 'public' as const },
    } }
    const routes: string[] = []
    await expect(runEngineeringTask({ ...options, deployment, executeRole: async input => {
      routes.push(input.route.routeId)
      if (input.role === 'scout-secondary') throw new RoleInvocationError('primary failed', 'PROVIDER_REQUEST_FAILURE', true)
      return options.executeRole(input)
    } })).rejects.toThrow(`route ${deniedRoute} does not allow internal data`)
    expect(routes).not.toContain(deniedRoute)
    if (deniedRoute === 'worker-secondary') expect(routes).not.toContain('worker-secondary-fallback')
  })

  it.each(['repository invariant violation', 'writer lease changed'])('does not fallback or block on an unclassified %s', async message => {
    const options = await fixture()
    const routes: string[] = []
    await expect(runEngineeringTask({ ...options, executeRole: async input => {
      if (input.role === 'scout-secondary') {
        routes.push(input.route.routeId)
        throw new Error(message)
      }
      return options.executeRole(input)
    } })).rejects.toThrow(message)
    expect(routes).toEqual(['worker-secondary'])
    expect((await getEngineeringStatus(options.root)).tasks[0]?.state.state).not.toBe('BLOCKED')
  })

  it('never starts a fallback after cancellation', async () => {
    const options = await fixture()
    const controller = new AbortController()
    const dispatches: Array<{ role: string; routeId: string }> = []
    try {
      await expect(runEngineeringTask({ ...options, signal: controller.signal, executeRole: async input => {
        dispatches.push({ role: input.role, routeId: input.route.routeId })
        if (input.role === 'scout-secondary' && input.route.routeId === 'worker-secondary') {
          controller.abort()
          throw new Error('stopped')
        }
        return options.executeRole(input)
      } })).rejects.toThrow('stopped')
      expect(dispatches.filter(entry => entry.role === 'scout-secondary').map(entry => entry.routeId)).toEqual(['worker-secondary'])
    } finally {
      controller.abort()
    }
  })

  it('does not turn a fallbackable failure into BLOCKED after cancellation', async () => {
    const options = await fixture()
    const controller = new AbortController()
    const cancellation = new Error('Parent cancelled the investigation')
    const routes: string[] = []
    await expect(runEngineeringTask({ ...options, signal: controller.signal, executeRole: async input => {
      if (input.role === 'scout-primary') {
        await new Promise<void>(resolve => {
          if (input.signal.aborted) resolve()
          else input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        input.signal.throwIfAborted()
      }
      if (input.role === 'scout-secondary') {
        routes.push(input.route.routeId)
        controller.abort(cancellation)
        throw new RoleInvocationError('provider failed after cancellation', 'PROVIDER_REQUEST_FAILURE', true)
      }
      return options.executeRole(input)
    } })).rejects.toBe(cancellation)
    expect(routes).toEqual(['worker-secondary'])
    expect((await getEngineeringStatus(options.root)).tasks[0]?.state.state).not.toBe('BLOCKED')
  })

  it('never starts any role work after parent shutdown', async () => {
    const options = await fixture()
    const controller = new AbortController()
    controller.abort()
    const dispatches: Array<{ role: string; routeId: string }> = []
    await expect(runEngineeringTask({ ...options, signal: controller.signal, executeRole: async input => {
      dispatches.push({ role: input.role, routeId: input.route.routeId })
      return options.executeRole(input)
    } })).rejects.toThrow()
    expect(dispatches).toEqual([])
  })
})
