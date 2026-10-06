/** Runner parsing, environment isolation, and independently observed process teardown. */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  executeRunnerCommand, resolveRunner, resolveRunnerCommand,
  type DockerRunner, type RunnerCommand, type RunnerContext, type RunnerExecutionOptions,
} from '../src/runner.ts'

const roots: string[] = []
const executions = new Set<Promise<unknown>>()
const controllers: AbortController[] = []
const options: RunnerExecutionOptions = { timeoutMs: 10000, terminationTimeoutMs: 300, outputLimitBytes: 4096 }
const emptyEnv = { set: {}, inherit: [] }

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-runner-'))
  roots.push(root)
  return root
}

function context(root: string): RunnerContext {
  return { projectRoot: root, baseRevision: 'base revision', changedFiles: ['src/with space.ts', '$(touch nope)'], selectedTests: ['one.spec.ts', 'two.spec.ts'] }
}

function command(script: string): RunnerCommand {
  return { executable: process.execPath, args: ['-e', script], env: emptyEnv }
}

function local(root: string, script: string) {
  return resolveRunnerCommand(resolveRunner({ kind: 'local', workingDirectory: '.' }), command(script), context(root), {})
}

function docker(executable: string): DockerRunner {
  return { kind: 'docker', executable, container: 'test-container', user: '1000:1000', home: '/home/test user', workingDirectory: '/work/project' }
}

function controller(): AbortController {
  const cancellation = new AbortController()
  controllers.push(cancellation)
  return cancellation
}

function tracked<Result>(execution: Promise<Result>): Promise<Result> {
  executions.add(execution)
  return execution
}

async function ready(filename: string): Promise<string> {
  let content = ''
  await vi.waitFor(async () => { content = await readFile(filename, 'utf8'); expect(content).not.toBe('') }, { timeout: 8000, interval: 10 })
  return content
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

afterEach(async () => {
  for (const cancellation of controllers.splice(0)) cancellation.abort()
  await Promise.allSettled(executions)
  executions.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('runner configuration', () => {
  it('copies complete local and Docker configurations', () => {
    expect(resolveRunner({ kind: 'local', workingDirectory: '.' })).toEqual({ kind: 'local', workingDirectory: '.' })
    const input = docker(process.execPath)
    expect(resolveRunner(input)).toEqual(input)
    expect(resolveRunner(input)).not.toBe(input)
  })

  it.each(['ssh', 'remote', 'remote-device', 'slurm', undefined])('rejects unsupported provider %s', kind => {
    expect(() => resolveRunner({ kind })).toThrow('unsupported runner kind')
  })

  it.each([
    null, [], 'local', { kind: 'local' }, { kind: 'local', workingDirectory: '' },
    { kind: 'local', workingDirectory: '.', typo: true },
    { ...docker(process.execPath), executable: 'docker' },
    { ...docker(process.execPath), container: '-injected' },
    { ...docker(process.execPath), user: '' },
    { ...docker(process.execPath), user: '-root' },
    { ...docker(process.execPath), home: 'relative' },
    { ...docker(process.execPath), workingDirectory: 'relative' },
    { ...docker(process.execPath), container: 'bad\0container' },
    { ...docker(process.execPath), args: [] },
  ])('rejects incomplete or malformed config %j', config => {
    expect(() => resolveRunner(config)).toThrow()
  })

  it.each(['executable', 'container', 'user', 'home', 'workingDirectory'])('requires Docker %s', field => {
    const config: Record<string, unknown> = { ...docker(process.execPath) }
    delete config[field]
    expect(() => resolveRunner(config)).toThrow()
  })
})

describe('typed argv and structured env', () => {
  it('expands scalars and lists as exact tokens, retaining empty argv and shell metacharacters', async () => {
    const root = await fixture()
    const resolved = resolveRunnerCommand({ kind: 'local', workingDirectory: '.' }, {
      executable: process.execPath,
      args: ['', '{{PROJECT_ROOT}}', '{{BASE_REVISION}}', '{{CHANGED_FILES}}', '{{SELECTED_TESTS}}', '; echo never', '--x=a b'],
      env: emptyEnv,
    }, context(root), {})
    expect(resolved.args).toEqual(['', root, 'base revision', 'src/with space.ts', '$(touch nope)', 'one.spec.ts', 'two.spec.ts', '; echo never', '--x=a b'])
    expect(resolved.workingDirectory).toBe(root)
    const empty = resolveRunnerCommand({ kind: 'local', workingDirectory: '.' }, {
      executable: 'test', args: ['before', '{{CHANGED_FILES}}', '{{SELECTED_TESTS}}', 'after'], env: emptyEnv,
    }, { ...context(root), changedFiles: [], selectedTests: [] }, {})
    expect(empty.args).toEqual(['before', 'after'])
  })

  it.each(['prefix{{PROJECT_ROOT}}', '{{BASE_REVISION}}suffix', '{{CHANGED_FILES}} {{SELECTED_TESTS}}', '{{UNKNOWN}}', '{{PROJECT_ROOT', 'bad}}'])('rejects placeholder %s', argument => {
    expect(() => resolveRunnerCommand({ kind: 'local', workingDirectory: '.' }, {
      executable: 'test', args: [argument], env: emptyEnv,
    }, context(process.cwd()), {})).toThrow('placeholders')
  })

  it('copies only allowlisted host variables, never ambient credentials', async () => {
    const root = await fixture()
    const host = { PATH: '/explicit/path', HOST_SECRET: 'never-copy', API_KEY: 'never-copy', UNREQUESTED: 'never-copy' }
    const resolved = resolveRunnerCommand({ kind: 'local', workingDirectory: '.' }, {
      ...command('process.stdout.write(JSON.stringify(process.env))'),
      env: { set: { USE_ASCEND: 'ON', USE_CUDA: 'OFF', EMPTY: '' }, inherit: ['PATH'] },
    }, context(root), host)
    expect(resolved.env).toEqual({ PATH: '/explicit/path', USE_ASCEND: 'ON', USE_CUDA: 'OFF', EMPTY: '' })
    const result = await tracked(executeRunnerCommand(resolved, options))
    const observed = JSON.parse(result.stdout)
    expect(observed).toMatchObject(resolved.env)
    expect(observed.HOST_SECRET).toBeUndefined()
    expect(observed.API_KEY).toBeUndefined()
    expect(observed.UNREQUESTED).toBeUndefined()
    expect(result).toMatchObject({ status: 'PASS', timedOut: false, quiescence: process.platform === 'win32' ? 'UNCERTAIN' : 'CONFIRMED' })
  })

  it.each(['API_KEY', 'secret', 'AUTH_TOKEN', 'Password', '1INVALID', 'BAD=NAME', 'BAD\0NAME'])('rejects env name %s in both assignment and inheritance', name => {
    for (const env of [{ set: { [name]: 'value' }, inherit: [] }, { set: {}, inherit: [name] }]) {
      expect(() => resolveRunnerCommand({ kind: 'local', workingDirectory: '.' }, { ...command(''), env }, context(process.cwd()), { [name]: 'value' })).toThrow(/env name|env\.inherit/)
    }
  })

  it.each([
    { set: {}, inherit: ['MISSING'] }, { set: { PATH: 'set' }, inherit: ['PATH'] },
    { set: {}, inherit: ['PATH', 'PATH'] }, { set: { PATH: 'one', Path: 'two' }, inherit: [] },
  ])('rejects missing and conflicting env inheritance %j', env => {
    expect(() => resolveRunnerCommand({ kind: 'local', workingDirectory: '.' }, { ...command(''), env }, context(process.cwd()), { PATH: 'host' })).toThrow()
  })

  it('validates all resolution inputs rather than supplying missing values', () => {
    const runner = { kind: 'local' as const, workingDirectory: '.' }
    const valid = context(process.cwd())
    expect(() => resolveRunnerCommand(runner, { ...command(''), args: ['bad\0arg'] }, valid, {})).toThrow()
    expect(() => resolveRunnerCommand(runner, { ...command(''), executable: '{{PROJECT_ROOT}}' }, valid, {})).toThrow()
    expect(() => resolveRunnerCommand(runner, { ...command(''), env: { set: { GOOD: 'bad\0value' }, inherit: [] } }, valid, {})).toThrow()
    expect(() => resolveRunnerCommand(runner, command(''), { ...valid, projectRoot: 'relative' }, {})).toThrow()
    expect(() => resolveRunnerCommand(runner, command(''), { ...valid, changedFiles: ['bad\0file'] }, {})).toThrow()
    expect(() => resolveRunnerCommand(runner, command(''), { ...valid, selectedTests: ['bad\0test'] }, {})).toThrow()
  })

  it('accepts empty base revisions for non-Git commands and rejects only their explicit expansion', () => {
    const runner = { kind: 'local' as const, workingDirectory: '.' }
    const plain = { ...context(process.cwd()), baseRevision: '' }
    expect(resolveRunnerCommand(runner, command(''), plain, {}).args).toEqual(['-e', ''])
    expect(() => resolveRunnerCommand(runner, { ...command(''), args: ['{{BASE_REVISION}}'] }, plain, {})).toThrow('requires a nonempty context.baseRevision')
  })

  it('builds Docker exec argv with explicit container identity, user, HOME and working directory', () => {
    const resolved = resolveRunnerCommand(docker(process.execPath), {
      executable: 'pytest', args: ['{{SELECTED_TESTS}}', 'literal; never execute'],
      env: { set: { USE_ASCEND: 'ON' }, inherit: ['LD_LIBRARY_PATH'] },
    }, context('/work/project'), { LD_LIBRARY_PATH: '/toolkit/lib path', API_KEY: 'never-copy' })
    expect(resolved.args).toEqual([
      'exec', '--user', '1000:1000', '--workdir', '/work/project', '--env', 'HOME=/home/test user',
      '--env', 'LD_LIBRARY_PATH=/toolkit/lib path', '--env', 'USE_ASCEND=ON',
      '--', 'test-container', 'pytest', 'one.spec.ts', 'two.spec.ts', 'literal; never execute',
    ])
    expect(resolved.env).toEqual({ LD_LIBRARY_PATH: '/toolkit/lib path', USE_ASCEND: 'ON' })
    expect(resolved.workingDirectory).toBe('/work/project')
    expect(() => resolveRunnerCommand(docker(process.execPath), { ...command(''), env: { set: { HOME: '/ambiguous' }, inherit: [] } }, context('/work/project'), {})).toThrow('runner.home')
  })
})

describe('local execution and teardown', () => {
  it('reports ordinary exit facts and bounded stdout/stderr independently', async () => {
    const root = await fixture()
    const result = await tracked(executeRunnerCommand(local(root, 'process.stdout.write("a".repeat(100));process.stderr.write("b".repeat(100));process.exitCode=7'), { ...options, outputLimitBytes: 12 }))
    expect(result).toMatchObject({ status: 'FAIL', exitCode: 7, timedOut: false, stdout: 'a'.repeat(12), stderr: 'b'.repeat(12) })
    expect(result.quiescence).toBe(process.platform === 'win32' ? 'UNCERTAIN' : 'CONFIRMED')
  })

  it('returns a spawn failure without an invented exit code', async () => {
    const root = await fixture()
    const result = await tracked(executeRunnerCommand({ ...local(root, ''), executable: join(root, 'missing-executable') }, options))
    expect(result).toMatchObject({ status: 'FAIL', exitCode: null, timedOut: false, quiescence: 'CONFIRMED' })
    expect(result.stderr).toContain('ENOENT')
  })

  it('times out and waits for direct child exit', async () => {
    const root = await fixture()
    const filename = join(root, 'pid')
    const result = await tracked(executeRunnerCommand(local(root, `require('node:fs').writeFileSync(${JSON.stringify(filename)}, String(process.pid));setInterval(()=>{},1000)`), { ...options, timeoutMs: 1000 }))
    const pid = Number(await readFile(filename, 'utf8'))
    expect(alive(pid)).toBe(false)
    expect(result).toMatchObject({ status: 'FAIL', exitCode: null, timedOut: true, quiescence: process.platform === 'win32' ? 'UNCERTAIN' : 'CONFIRMED' })
  })

  it('cancels an independently launched local process only after its exit', async () => {
    const root = await fixture()
    const filename = join(root, 'pid')
    const cancellation = controller()
    const execution = tracked(executeRunnerCommand(local(root, `require('node:fs').writeFileSync(${JSON.stringify(filename)}, String(process.pid));setInterval(()=>{},1000)`), { ...options, signal: cancellation.signal }))
    const pid = Number(await ready(filename))
    expect(alive(pid)).toBe(true)
    cancellation.abort()
    const result = await execution
    expect(alive(pid)).toBe(false)
    expect(result).toMatchObject({ status: 'INCOMPLETE', exitCode: null, timedOut: false, quiescence: process.platform === 'win32' ? 'UNCERTAIN' : 'CONFIRMED' })
  })

  it('does not launch an already cancelled command', async () => {
    const root = await fixture()
    const filename = join(root, 'must-not-exist')
    const cancellation = controller()
    cancellation.abort()
    const result = await tracked(executeRunnerCommand(local(root, `require('node:fs').writeFileSync(${JSON.stringify(filename)}, 'launched')`), { ...options, signal: cancellation.signal }))
    await expect(readFile(filename)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result).toEqual({ status: 'INCOMPLETE', exitCode: null, timedOut: false, stdout: '', stderr: '', quiescence: 'CONFIRMED' })
  })

  it.runIf(process.platform === 'linux').each(['exit', 'cancel'])('stops double-fork setsid descendants before confirming local %s', async mode => {
    const root = await fixture()
    const runnerUrl = pathToFileURL(resolve(import.meta.dirname, '../src/runner.ts')).href
    const target = String.raw`
import json, os, sys, time
root, mode = sys.argv[1:]
parent = os.getpid()
intermediate = os.fork()
if intermediate:
    os.waitpid(intermediate, 0)
    while not os.path.exists(os.path.join(root, 'daemon-ready.json')):
        time.sleep(.01)
    if mode == 'exit':
        os._exit(0)
    while True:
        time.sleep(1)
os.setsid()
descendant = os.fork()
if descendant:
    os._exit(0)
descriptor = os.open('/dev/null', os.O_RDWR)
for descriptor_number in (0, 1, 2):
    os.dup2(descriptor, descriptor_number)
os.close(descriptor)
with open(os.path.join(root, 'daemon-ready.json'), 'w') as output:
    json.dump({'parent': parent, 'descendant': os.getpid(), 'session': os.getsid(0)}, output)
while not os.path.exists(os.path.join(root, 'release-write')):
    time.sleep(.01)
with open(os.path.join(root, 'late-write'), 'w') as output:
    output.write('descendant wrote after runner returned')
while True:
    time.sleep(1)
`
    const driver = `
import { executeRunnerCommand } from ${JSON.stringify(runnerUrl)};
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const [root, mode, python, target] = process.argv.slice(1);
const cancellation = new AbortController();
const execution = executeRunnerCommand({ kind: 'local', executable: python, args: ['-c', target, root, mode], workingDirectory: root, env: {} },
  { timeoutMs: 15000, terminationTimeoutMs: 5000, outputLimitBytes: 4096, signal: cancellation.signal });
try {
  let identities;
  const deadline = performance.now() + 10000;
  while (identities === undefined) {
    try { identities = JSON.parse(await readFile(root + '/daemon-ready.json', 'utf8')); }
    catch (error) { if (performance.now() >= deadline) throw error; await delay(10); }
  }
  if (mode === 'cancel') cancellation.abort();
  const result = await execution;
  let descendantRunningAtReturn = false;
  try {
    const stat = await readFile('/proc/' + identities.descendant + '/stat', 'utf8');
    descendantRunningAtReturn = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  await writeFile(root + '/release-write', 'released');
  if (descendantRunningAtReturn) {
    const writeDeadline = performance.now() + 2000;
    while (true) {
      try { await readFile(root + '/late-write'); break; }
      catch (error) { if (performance.now() >= writeDeadline) throw error; await delay(10); }
    }
  }
  console.log(JSON.stringify({ result, identities, descendantRunningAtReturn }));
} finally {
  cancellation.abort();
  await execution;
}
`
    const supervisor = String.raw`
import ctypes, json, os, signal, subprocess, sys, time
node, root, mode, driver, target = sys.argv[1:]
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER failed')
reaped = []
with open(os.path.join(root, 'driver.stdout'), 'w+') as stdout, open(os.path.join(root, 'driver.stderr'), 'w+') as stderr:
    child = subprocess.Popen([node, '--import', 'tsx/esm', '--input-type=module', '-e', driver, root, mode, sys.executable, target], stdout=stdout, stderr=stderr)
    try:
        deadline = time.monotonic() + 25
        while child.poll() is None:
            if os.path.exists(os.path.join(root, 'stop-supervisor')) or time.monotonic() >= deadline:
                raise TimeoutError('runner driver did not settle')
            time.sleep(.01)
    finally:
        deadline = time.monotonic() + 5
        while True:
            try:
                while True:
                    waited, status = os.waitpid(-1, os.WNOHANG)
                    if waited == 0:
                        break
                    reaped.append(waited)
            except ChildProcessError:
                break
            with open('/proc/self/task/' + str(os.getpid()) + '/children') as children:
                owned = [int(value) for value in children.read().split()]
            for owned_pid in owned:
                try:
                    os.kill(owned_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if time.monotonic() >= deadline:
                raise TimeoutError('supervisor descendants were not reaped')
            time.sleep(.01)
        child.wait()
    stdout.seek(0)
    stderr.seek(0)
    print(json.dumps({'exitCode': child.returncode, 'stdout': stdout.read(), 'stderr': stderr.read(), 'reaped': reaped}))
`
    const child = spawn('python3', ['-c', supervisor, process.execPath, root, mode, driver, target], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const completion = tracked(new Promise<number | null>((settle, reject) => {
      child.once('error', reject)
      child.once('close', settle)
    }))
    try {
      expect(await completion, stderr).toBe(0)
      const report = JSON.parse(stdout)
      expect(report.exitCode, report.stderr).toBe(0)
      const observation = JSON.parse(report.stdout)
      expect(observation.identities.session).not.toBe(observation.identities.descendant)
      expect(observation.result).toMatchObject({ status: mode === 'exit' ? 'PASS' : 'INCOMPLETE', timedOut: false, quiescence: 'CONFIRMED' })
      expect(observation.descendantRunningAtReturn).toBe(false)
      expect(report.reaped).toContain(observation.identities.descendant)
      expect(alive(observation.identities.parent)).toBe(false)
      expect(alive(observation.identities.descendant)).toBe(false)
      await expect(readFile(join(root, 'late-write'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await writeFile(join(root, 'stop-supervisor'), 'stop')
      await Promise.allSettled([completion])
    }
  }, 40000)

  it.runIf(process.platform === 'linux')('kills the process group and never confirms unreaped descendants', async () => {
    const root = await fixture()
    const filename = join(root, 'descendant-pid')
    const cancellation = controller()
    const script = `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.on('spawn',()=>require('node:fs').writeFileSync(${JSON.stringify(filename)},String(child.pid)));setInterval(()=>{},1000)`
    const execution = tracked(executeRunnerCommand(local(root, script), { ...options, signal: cancellation.signal }))
    const pid = Number(await ready(filename))
    expect(alive(pid)).toBe(true)
    cancellation.abort()
    const result = await execution
    let state: string | undefined
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error
    }
    expect(state === undefined || state === 'Z').toBe(true)
    expect(result.quiescence).toBe(state === undefined ? 'CONFIRMED' : 'UNCERTAIN')
    expect(result.status).toBe('INCOMPLETE')
  })

  it.each([0, -1, NaN, Infinity, 1.5, 2147483648])('rejects invalid execution limits %s before spawn', async limit => {
    const root = await fixture()
    for (const field of ['timeoutMs', 'terminationTimeoutMs', 'outputLimitBytes']) {
      await expect(executeRunnerCommand(local(root, ''), { ...options, [field]: limit })).rejects.toThrow(field)
    }
  })

  it('revalidates a resolved invocation instead of trusting unsafe serialized inputs', async () => {
    const root = await fixture()
    await expect(executeRunnerCommand({ ...local(root, ''), env: { API_KEY: 'secret' } }, options)).rejects.toThrow('secret-bearing')
    await expect(executeRunnerCommand({ ...local(root, ''), args: ['bad\0arg'] }, options)).rejects.toThrow('NUL-free')
    await expect(executeRunnerCommand({ ...local(root, ''), workingDirectory: 'relative' }, options)).rejects.toThrow('absolute')
  })
})

describe.runIf(process.platform !== 'win32')('independent fake Docker execution', () => {
  async function driver(root: string, script: string): Promise<string> {
    const filename = join(root, 'fake-docker')
    await writeFile(filename, `#!${process.execPath}\n${script}\n`, { mode: 0o700 })
    return filename
  }

  it('executes the real resolver argv without shell interpretation or host secrets', async () => {
    const root = await fixture()
    const executable = await driver(root, 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),env:process.env}))')
    const resolved = resolveRunnerCommand(docker(executable), { executable: 'test', args: ['{{CHANGED_FILES}}'], env: { set: { USE_ASCEND: 'ON' }, inherit: [] } }, context(root), { API_KEY: 'hidden' })
    const result = await tracked(executeRunnerCommand(resolved, options))
    const output = JSON.parse(result.stdout)
    expect(output.args).toEqual(resolved.args)
    expect(output.env.API_KEY).toBeUndefined()
    expect(result).toMatchObject({ status: 'PASS', exitCode: 0, timedOut: false, quiescence: 'CONFIRMED' })
  })

  it('keeps Docker cancellation UNCERTAIN even after confirming the local driver exited', async () => {
    const root = await fixture()
    const filename = join(root, 'driver-pid')
    const executable = await driver(root, `require('node:fs').writeFileSync(${JSON.stringify(filename)},String(process.pid));setInterval(()=>{},1000)`)
    const cancellation = controller()
    const resolved = resolveRunnerCommand(docker(executable), command(''), context(root), {})
    const execution = tracked(executeRunnerCommand(resolved, { ...options, signal: cancellation.signal }))
    const pid = Number(await ready(filename))
    expect(alive(pid)).toBe(true)
    cancellation.abort()
    const result = await execution
    expect(alive(pid)).toBe(false)
    expect(result).toMatchObject({ status: 'INCOMPLETE', exitCode: null, timedOut: false, quiescence: 'UNCERTAIN' })
  })

  it('keeps Docker timeout UNCERTAIN even when the host driver is dead', async () => {
    const root = await fixture()
    const executable = await driver(root, 'setInterval(()=>{},1000)')
    const resolved = resolveRunnerCommand(docker(executable), command(''), context(root), {})
    const result = await tracked(executeRunnerCommand(resolved, { ...options, timeoutMs: 50 }))
    expect(result).toMatchObject({ status: 'FAIL', exitCode: null, timedOut: true, quiescence: 'UNCERTAIN' })
  })
})
