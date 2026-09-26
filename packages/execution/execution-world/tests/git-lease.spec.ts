import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { supportsRootRead, type FsReadRoot } from '@deepseek-ai/dsh-fs'
import { HOST_EXECUTION_WORLD_AFFINITY } from '@deepseek-ai/dsh-execution-world-affinity'
import { SandboxProvider, type ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { bindExecutionGitLease, ExecutionGitCleanupError, type ExecutionGitLease } from '../src/git-lease.ts'
import { open } from './fixtures/harness.ts'

class TestSandbox extends SandboxProvider {
  override readonly executionWorldAffinity = HOST_EXECUTION_WORLD_AFFINITY
  override async confine(argv: readonly string[]): Promise<ConfinedArgv> {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-lease-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  execFileSync('git', ['init', '-q', workspace])
  await writeFile(join(workspace, 'REMOTE_ONLY.txt'), 'remote only\n')
  const harness = await open(root)
  onTestFinished(() => harness.close())
  const subprocess = await harness.ctx.plugin(LocalSubprocessRuntime)
  onTestFinished(() => subprocess.dispose())
  const sandbox = await harness.ctx.plugin(TestSandbox)
  onTestFinished(() => sandbox.dispose())
  const mount = async (signal?: AbortSignal, root = workspace) => {
    let lease!: ExecutionGitLease
    const consumer = harness.ctx.plugin({
      name: 'git-lease-test-consumer',
      inject: ['executionWorldIdentity', 'fs', 'subprocess', 'sandbox'],
      async apply(ctx: Context) { lease = await bindExecutionGitLease(ctx, root, signal) },
    })
    onTestFinished(() => consumer.dispose())
    await consumer
    return { lease, consumer }
  }
  return { harness, workspace, subprocess, mount }
}

const statusArgv = ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all']
const limits = (signal: AbortSignal) => ({ maxBytes: 4096, timeoutMs: 20_000, signal })

describe('provider Git lease', () => {
  it('runs fixed Git in the bound workspace and exposes no generic subprocess', async () => {
    const { mount } = await fixture()
    const { lease } = await mount()
    expect(Object.keys(lease).sort()).toEqual(['dispose', 'git', 'workspaceId'])
    expect(Object.keys(lease.git).sort()).toEqual(['emptyFile', 'execute', 'signal', 'workspaceId'])
    expect(lease.git.workspaceId).toBe(lease.workspaceId)
    const result = await lease.git.execute(statusArgv, limits(new AbortController().signal))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('REMOTE_ONLY.txt')
    await expect(lease.git.execute(['--no-optional-locks', '-c', 'core.fsmonitor=false', 'show', 'HEAD'], limits(new AbortController().signal))).rejects.toThrow('not authorized')
    await expect(lease.git.execute(statusArgv, { ...limits(new AbortController().signal), maxBytes: 4 * 1024 * 1024 + 1 })).rejects.toThrow('limits')
    await expect(lease.git.execute(statusArgv, { ...limits(new AbortController().signal), timeoutMs: 20_001 })).rejects.toThrow('limits')
    await expect(lease.git.execute(statusArgv, { ...limits(new AbortController().signal), maxBytes: 1 })).rejects.toThrow('byte ceiling')
    await expect(lease.git.execute(statusArgv, limits(AbortSignal.abort(new Error('cancelled'))))).rejects.toThrow('cancelled')
    await lease.dispose()
    await lease.dispose()
    await expect(lease.git.execute(statusArgv, limits(new AbortController().signal))).rejects.toThrow()
  })

  it('closes the unpublished root if provider platform inspection fails', async () => {
    const { harness, mount } = await fixture()
    if (!supportsRootRead(harness.ctx.fs)) throw new Error('Missing native root reader')
    const nativeOpen = harness.ctx.fs.openReadRoot.bind(harness.ctx.fs)
    let scope: FsReadRoot | undefined
    let close: ReturnType<typeof vi.fn> | undefined
    vi.spyOn(harness.ctx.fs, 'openReadRoot').mockImplementation(async (target, signal, options) => {
      scope = await nativeOpen(target, signal, options)
      close = vi.spyOn(scope, 'close')
      return scope
    })
    vi.spyOn(harness.ctx.subprocess, 'terminalEnvironment').mockRejectedValue(new Error('platform unavailable'))
    await expect(mount()).rejects.toThrow('platform unavailable')
    expect(scope).toBeDefined()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('reports failed acquisition and failed cleanup together', async () => {
    const { harness, mount } = await fixture()
    if (!supportsRootRead(harness.ctx.fs)) throw new Error('Missing native root reader')
    const nativeOpen = harness.ctx.fs.openReadRoot.bind(harness.ctx.fs)
    vi.spyOn(harness.ctx.fs, 'openReadRoot').mockImplementation(async (target, signal, options) => {
      const scope = await nativeOpen(target, signal, options)
      const nativeClose = scope.close.bind(scope)
      vi.spyOn(scope, 'close').mockImplementation(async () => {
        await nativeClose()
        throw new Error('remote cleanup unknown')
      })
      return scope
    })
    vi.spyOn(harness.ctx.subprocess, 'terminalEnvironment').mockRejectedValue(new Error('platform unavailable'))
    const failure = await mount().then(() => undefined, (error: unknown) => error as ExecutionGitCleanupError)
    expect(failure).toBeInstanceOf(ExecutionGitCleanupError)
    expect(failure?.message).toBe('Git execution workspace cleanup could not be confirmed')
    expect(failure?.cause).toMatchObject({
      errors: [expect.objectContaining({ message: 'platform unavailable' }), expect.objectContaining({ message: 'read-only execution cleanup failed' })],
    })
  })

  it('rejects partial confinement before starting Git', async () => {
    const { harness, mount } = await fixture()
    vi.spyOn(harness.ctx.sandbox, 'confine').mockResolvedValue({
      argv: ['git', ...statusArgv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [],
    })
    const spawn = vi.spyOn(harness.ctx.subprocess, 'spawn')
    const { lease } = await mount()
    await expect(lease.git.execute(statusArgv, limits(new AbortController().signal))).rejects.toThrow('full sandbox enforcement')
    expect(spawn).not.toHaveBeenCalled()
    await lease.dispose()
  })

  it('rejects an ancestor repository outside the bound root', async () => {
    const { workspace, mount } = await fixture()
    const nested = join(workspace, 'nested')
    await mkdir(nested)
    await expect(mount(undefined, nested)).rejects.toThrow('metadata must be inside')
  })

  it('rejects mismatched provider affinity before acquiring a root', async () => {
    const { harness, mount } = await fixture()
    Object.defineProperty(harness.ctx.sandbox, 'executionWorldAffinity', { value: Symbol('different provider') })
    await expect(mount()).rejects.toThrow('different execution worlds')
  })

  it('revokes commands when the captured subprocess provider is disposed', async () => {
    const { subprocess, mount } = await fixture()
    const { lease } = await mount()
    await subprocess.dispose()
    await expect(lease.git.execute(statusArgv, limits(new AbortController().signal))).rejects.toThrow()
    await lease.dispose()
  })

  it('ignores ambient repository selectors, injected config and tracing', async () => {
    const { harness, mount } = await fixture()
    const decoy = await mkdtemp(join(tmpdir(), 'dsh-git-decoy-'))
    onTestFinished(() => rm(decoy, { recursive: true, force: true }))
    execFileSync('git', ['init', '-q', decoy])
    await writeFile(join(decoy, 'HOST_ONLY.txt'), 'host only')
    const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_TRACE', 'GIT_NAMESPACE', 'GIT_LITERAL_PATHSPECS'] as const
    const prior = names.map(name => process.env[name])
    onTestFinished(() => {
      names.forEach((name, index) => {
        if (prior[index] === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = prior[index]
      })
    })
    const trace = join(decoy, 'trace.log')
    Object.assign(process.env, {
      GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: decoy,
      GIT_TRACE: trace, GIT_NAMESPACE: 'ambient-namespace', GIT_LITERAL_PATHSPECS: '1',
    })
    const spawn = vi.spyOn(harness.ctx.subprocess, 'spawn')
    const { lease } = await mount()
    const result = await lease.git.execute(statusArgv, limits(new AbortController().signal))
    expect(result.stdout).toContain('REMOTE_ONLY.txt')
    expect(result.stdout).not.toContain('HOST_ONLY.txt')
    expect(spawn.mock.calls[0]?.[0].env).toMatchObject({
      GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_NAMESPACE: undefined,
      GIT_LITERAL_PATHSPECS: undefined, GIT_ATTR_NOSYSTEM: '1',
    })
    await expect(readFile(trace)).rejects.toMatchObject({ code: 'ENOENT' })
    await lease.dispose()
  })

  it('joins the process range after caller cancellation', async () => {
    const { harness, mount } = await fixture()
    let resolveDone!: (outcome: SubprocessOutcome) => void
    let resolveExit!: (exited: boolean) => void
    let notifySpawn!: () => void
    const done = new Promise<SubprocessOutcome>((resolve) => { resolveDone = resolve })
    const exited = new Promise<boolean>((resolve) => { resolveExit = resolve })
    const spawned = new Promise<void>((resolve) => { notifySpawn = resolve })
    const terminate = vi.fn()
    vi.spyOn(harness.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      spec.signal?.addEventListener('abort', () => { terminate(); resolveDone({ exitCode: 1, signal: null }) }, { once: true })
      notifySpawn()
      return {
        done, terminate, waitForExit: () => exited,
        collected: {
          stdout: { readFrom: () => ({ text: '', lossy: false }) },
          stderr: { readFrom: () => ({ text: '', lossy: false }) },
        },
      } as unknown as SubprocessHandle
    })
    const { lease } = await mount()
    const controller = new AbortController()
    let settled = false
    const execution = lease.git.execute(statusArgv, limits(controller.signal)).finally(() => { settled = true })
    await spawned
    controller.abort(new Error('caller cancelled'))
    await done
    expect(settled).toBe(false)
    resolveExit(true)
    await expect(execution).rejects.toThrow('caller cancelled')
    expect(terminate).toHaveBeenCalled()
    await lease.dispose()
  })

  it('waits for an active Git process before lease disposal settles', async () => {
    const { harness, mount } = await fixture()
    let resolveDone!: (outcome: SubprocessOutcome) => void
    let resolveExit!: (exited: boolean) => void
    let notifySpawn!: () => void
    const done = new Promise<SubprocessOutcome>((resolve) => { resolveDone = resolve })
    const exited = new Promise<boolean>((resolve) => { resolveExit = resolve })
    const spawned = new Promise<void>((resolve) => { notifySpawn = resolve })
    const terminate = vi.fn()
    vi.spyOn(harness.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      spec.signal?.addEventListener('abort', () => { terminate(); resolveDone({ exitCode: 1, signal: null }) }, { once: true })
      notifySpawn()
      return { done, terminate, waitForExit: () => exited, collected: {} } as unknown as SubprocessHandle
    })
    const { lease } = await mount()
    let executionSettled = false
    let disposalSettled = false
    const execution = lease.git.execute(statusArgv, limits(new AbortController().signal))
      .finally(() => { executionSettled = true })
    await spawned
    const disposal = lease.dispose().finally(() => { disposalSettled = true })
    await done
    expect(terminate).toHaveBeenCalled()
    expect(executionSettled).toBe(false)
    expect(disposalSettled).toBe(false)
    resolveExit(true)
    await expect(execution).rejects.toThrow('Git lease disposed')
    await disposal
    expect(disposalSettled).toBe(true)
  })

  it('rejects when a Git process range cannot be confirmed empty', async () => {
    const { harness, mount } = await fixture()
    vi.spyOn(harness.ctx.subprocess, 'spawn').mockImplementation(() => ({
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: vi.fn(), waitForExit: async () => false, collected: {},
    }) as unknown as SubprocessHandle)
    const { lease } = await mount()
    await expect(lease.git.execute(statusArgv, limits(new AbortController().signal))).rejects.toThrow('did not reach quiescence')
    await expect(lease.dispose()).rejects.toThrow('cleanup failed')
  })

  it('joins the process range after an actual timeout', async () => {
    const { harness, mount } = await fixture()
    let resolveDone!: (outcome: SubprocessOutcome) => void
    let resolveExit!: (exited: boolean) => void
    let notifySpawn!: () => void
    const done = new Promise<SubprocessOutcome>((resolve) => { resolveDone = resolve })
    const exited = new Promise<boolean>((resolve) => { resolveExit = resolve })
    const spawned = new Promise<void>((resolve) => { notifySpawn = resolve })
    const terminate = vi.fn()
    vi.spyOn(harness.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      spec.signal?.addEventListener('abort', () => { terminate(); resolveDone({ exitCode: 1, signal: null }) }, { once: true })
      notifySpawn()
      return { done, terminate, waitForExit: () => exited, collected: {} } as unknown as SubprocessHandle
    })
    const { lease } = await mount()
    let settled = false
    const execution = lease.git.execute(statusArgv, { ...limits(new AbortController().signal), timeoutMs: 20 })
      .finally(() => { settled = true })
    await spawned
    await done
    expect(terminate).toHaveBeenCalled()
    expect(settled).toBe(false)
    resolveExit(true)
    await expect(execution).rejects.toThrow()
    await lease.dispose()
  })

  it('rejects a failed process-range join', async () => {
    const { harness, mount } = await fixture()
    const spawn = vi.spyOn(harness.ctx.subprocess, 'spawn').mockImplementation(() => ({
      done: Promise.resolve({ exitCode: 0, signal: null }), terminate: vi.fn(),
      waitForExit: async () => { throw new Error('range join failed') }, collected: {},
    }) as unknown as SubprocessHandle)
    const { lease } = await mount()
    await expect(lease.git.execute(statusArgv, limits(new AbortController().signal))).rejects.toThrow('range join failed')
    await expect(lease.dispose()).rejects.toThrow('cleanup failed')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it.each(['stdout', 'stderr'] as const)('rejects lossy %s output', async (stream) => {
    const { harness, mount } = await fixture()
    vi.spyOn(harness.ctx.subprocess, 'spawn').mockImplementation(() => ({
      done: Promise.resolve({ exitCode: 0, signal: null }), terminate: vi.fn(), waitForExit: async () => true,
      collected: {
        stdout: { readFrom: () => ({ text: '', lossy: stream === 'stdout' }) },
        stderr: { readFrom: () => ({ text: '', lossy: stream === 'stderr' }) },
      },
    }) as unknown as SubprocessHandle)
    const { lease } = await mount()
    await expect(lease.git.execute(statusArgv, limits(new AbortController().signal))).rejects.toThrow('byte ceiling')
    await lease.dispose()
  })
})
