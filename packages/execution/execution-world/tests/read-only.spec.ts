import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { supportsRootRead, type FsReadRoot } from '@deepseek-ai/dsh-fs'
import { createExecutionWorldAffinity, HOST_EXECUTION_WORLD_AFFINITY } from '@deepseek-ai/dsh-execution-world-affinity'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { bindReadOnlyExecutionWorld } from '../src/read-only.ts'
import { bindExecutionReadLease } from '@deepseek-ai/dsh-execution-world/read-lease'
import type { ReadOnlyExecutionWorld, ReadOnlyExecutionStart } from '../src/read-only-types.ts'
import { open } from './fixtures/harness.ts'

class TestSandbox extends SandboxProvider {
  override readonly executionWorldAffinity = HOST_EXECUTION_WORLD_AFFINITY
  override async confine(argv: readonly string[]): Promise<ConfinedArgv> {
    return { argv: [...argv], enforcement: 'partial', denialSignatures: ['test-denial'], runnerFailureRules: [] }
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-read-only-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'nested'), { recursive: true })
  await writeFile(join(workspace, 'nested', 'file.txt'), 'hello\n')
  await mkdir(join(root, 'outside'))
  await writeFile(join(root, 'outside', 'secret.txt'), 'outside')
  const harness = await open(root)
  if (!supportsRootRead(harness.ctx.fs)) throw new Error('Missing native root reader')
  const nativeOpen = harness.ctx.fs.openReadRoot.bind(harness.ctx.fs)
  let scope!: FsReadRoot
  vi.spyOn(harness.ctx.fs, 'openReadRoot').mockImplementation(async (target, signal, options) => {
    scope = await nativeOpen(target, signal, options)
    return scope
  })
  onTestFinished(() => harness.close())
  const subprocess = await harness.ctx.plugin(LocalSubprocessRuntime)
  onTestFinished(() => subprocess.dispose())
  const sandbox = await harness.ctx.plugin(TestSandbox)
  onTestFinished(() => sandbox.dispose())
  let binding!: ReadOnlyExecutionWorld
  const mount = async (signal?: AbortSignal) => {
    const consumer = harness.ctx.plugin({
      name: 'read-only-test-consumer',
      inject: ['executionWorldIdentity', 'fs', 'subprocess', 'sandbox'],
      async apply(ctx: Context) { binding = await bindReadOnlyExecutionWorld(ctx, workspace, signal) },
    })
    onTestFinished(() => consumer.dispose())
    await consumer
    return { binding, consumer, scope }
  }
  const mountLease = async (signal?: AbortSignal) => {
    let lease!: Awaited<ReturnType<typeof bindExecutionReadLease>>
    const consumer = harness.ctx.plugin({
      name: 'public-read-lease-consumer',
      inject: ['executionWorldIdentity', 'fs', 'subprocess', 'sandbox'],
      async apply(ctx: Context) { lease = await bindExecutionReadLease(ctx, workspace, signal) },
    })
    onTestFinished(() => consumer.dispose())
    await consumer
    return { binding: lease, consumer, scope }
  }
  return { root, workspace, harness, mount, mountLease }
}

const command: ReadOnlyExecutionStart = {
  argv: [process.execPath, '-e', 'process.stdout.write("out");process.stderr.write("err")'],
  stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 }, graceMs: 1000,
}

describe('root-bound execution reads', () => {
  it('rejects contained directory aliases through the public lease while internal reads retain them', async () => {
    const state = await fixture()
    await symlink(join(state.workspace, 'nested'), join(state.workspace, 'innocent'), process.platform === 'win32' ? 'junction' : 'dir')
    const internal = await state.mount()
    await expect(internal.binding.fs.readText('innocent/file.txt', 6)).resolves.toBe('hello\n')
    const published = await state.mountLease()
    expect(published.scope.aliasPolicy).toBe('deny')
    await expect(published.binding.fs.stat('innocent')).rejects.toThrow()
    await expect(published.binding.fs.listDir('innocent')).rejects.toThrow()
    await expect(published.binding.fs.readText('innocent/file.txt', 6)).rejects.toThrow()
  })

  it('closes a provider scope that does not acknowledge the public alias policy', async () => {
    const state = await fixture()
    if (!supportsRootRead(state.harness.ctx.fs)) throw new Error('Missing native root reader')
    const nativeOpen = vi.spyOn(state.harness.ctx.fs, 'openReadRoot').getMockImplementation()
    if (nativeOpen === undefined) throw new Error('Missing fixture root reader')
    let close = vi.fn(async () => {})
    vi.spyOn(state.harness.ctx.fs, 'openReadRoot').mockImplementation(async (target, signal) => {
      const scope = await nativeOpen(target, signal)
      close = vi.fn(() => scope.close())
      return { ...scope, close }
    })
    await expect(state.mountLease()).rejects.toThrow('alias policy unavailable')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('publishes a file-only lease with joined idempotent disposal', async () => {
    const { mountLease } = await fixture()
    const { binding: lease, scope } = await mountLease()
    const close = vi.spyOn(scope, 'close')
    expect(Object.keys(lease).sort()).toEqual(['dispose', 'fs', 'workspaceId'])
    expect(Object.keys(lease.fs).sort()).toEqual(['listDir', 'readText', 'stat'])
    await expect(lease.fs.readText('nested/file.txt', 6)).resolves.toBe('hello\n')
    const closing = lease.dispose()
    expect(lease.dispose()).toBe(closing)
    await closing
    expect(close).toHaveBeenCalledTimes(1)
    await expect(lease.fs.readText('nested/file.txt', 6)).rejects.toThrow('disposed')
  })

  it.each(['internal', 'public'] as const)('%s acquisition closes a root returned after cancellation', async (surface) => {
    const state = await fixture()
    const { harness } = state
    const mount = surface === 'public' ? state.mountLease : state.mount
    if (!supportsRootRead(harness.ctx.fs)) throw new Error('Missing native root reader')
    const nativeOpen = vi.spyOn(harness.ctx.fs, 'openReadRoot').getMockImplementation()
    if (nativeOpen === undefined) throw new Error('Missing fixture root reader')
    const entered = Promise.withResolvers<FsReadRoot>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(harness.ctx.fs, 'openReadRoot').mockImplementation(async (target, signal, options) => {
      const scope = await nativeOpen(target, signal, options)
      entered.resolve(scope)
      await release.promise
      return scope
    })
    const cancellation = new AbortController()
    const pending = mount(cancellation.signal)
    const rejected = expect(pending).rejects.toThrow('acquisition cancelled')
    const scope = await entered.promise
    const close = vi.spyOn(scope, 'close')
    try {
      cancellation.abort(new Error('acquisition cancelled'))
    } finally {
      release.resolve(undefined)
      await rejected
    }
    await expect(scope.stat([])).rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it.each(['internal', 'public'] as const)('%s rejects missing root-read capability before resolving content', async (surface) => {
    const state = await fixture()
    const { harness } = state
    const mount = surface === 'public' ? state.mountLease : state.mount
    Object.defineProperty(harness.ctx.fs, 'openReadRoot', { value: undefined, configurable: true })
    const resolve = vi.spyOn(harness.ctx.fs, 'resolve')
    await expect(mount()).rejects.toThrow('no secure root reader')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('uses only captured root operations for file content', async () => {
    const { harness, mount } = await fixture()
    const { binding } = await mount()
    const resolve = vi.spyOn(harness.ctx.fs, 'resolve').mockRejectedValue(new Error('ordinary resolve forbidden'))
    const read = vi.spyOn(harness.ctx.fs, 'readText').mockRejectedValue(new Error('ordinary read forbidden'))
    const stat = vi.spyOn(harness.ctx.fs, 'stat').mockRejectedValue(new Error('ordinary stat forbidden'))
    const list = vi.spyOn(harness.ctx.fs, 'listDir').mockRejectedValue(new Error('ordinary list forbidden'))
    expect(await binding.fs.readText('nested/file.txt', 6)).toBe('hello\n')
    expect(await binding.fs.stat('nested/file.txt')).toMatchObject({ type: 'file', size: 6 })
    expect(await binding.fs.listDir('nested')).toMatchObject([{ name: 'file.txt' }])
    for (const operation of [resolve, read, stat, list]) expect(operation).not.toHaveBeenCalled()
  })

  it('reads and lists logical paths without exposing targets or mutations', async () => {
    const state = await fixture()
    const { binding } = await state.mount()
    expect(await binding.fs.readText('nested/file.txt', 6)).toBe('hello\n')
    expect(await binding.fs.stat('missing')).toBeUndefined()
    await expect(binding.fs.readText('nested/file.txt', 5)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    const entries = await binding.fs.listDir('nested')
    expect(entries).toMatchObject([{ name: 'file.txt', path: 'nested/file.txt', type: 'file' }])
    expect(entries[0]).not.toHaveProperty('target')
    expect(entries[0]).not.toHaveProperty('targetKey')
    expect(binding.fs).not.toHaveProperty('writeText')
    expect(binding.fs).not.toHaveProperty('processPath')
  })

  it.each(['../outside/secret.txt', '/absolute', 'nested//file.txt', './nested', 'nested/..', 'nested\\file.txt', 'C:drive', 'bad\0path'])(
    'rejects non-logical path %j before reading', async (path) => {
      const { mount, harness } = await fixture()
      const { binding } = await mount()
      const read = vi.spyOn(harness.ctx.fs, 'readText')
      await expect(binding.fs.readText(path, 6)).rejects.toThrow('root-relative')
      expect(read).not.toHaveBeenCalled()
    },
  )

  it('accepts contained aliases and rejects directory aliases escaping the root', async () => {
    const { root, workspace, mount } = await fixture()
    await symlink(join(workspace, 'nested'), join(workspace, 'inside'), 'junction')
    await symlink(join(root, 'outside'), join(workspace, 'escape'), 'junction')
    const { binding } = await mount()
    expect(await binding.fs.readText('inside/file.txt', 6)).toBe('hello\n')
    await expect(binding.fs.readText('escape/secret.txt', 100)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect((await binding.fs.listDir('')).map(entry => entry.name)).toContain('escape')
  })

  it('requires explicit dependency capture rather than ambient context access', async () => {
    const { harness, workspace } = await fixture()
    await expect(bindReadOnlyExecutionWorld(harness.ctx, workspace)).rejects.toThrow('explicit injection')
  })

  it('rejects mixed execution worlds before resolving the root', async () => {
    const { harness, mount } = await fixture()
    Object.defineProperty(harness.ctx.subprocess, 'executionWorldAffinity', { value: createExecutionWorldAffinity() })
    const resolve = vi.spyOn(harness.ctx.fs, 'resolve')
    await expect(mount()).rejects.toThrow('different execution worlds')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('expires reads and closes its root when the consumer unloads', async () => {
    const { mount } = await fixture()
    const { binding, consumer, scope } = await mount()
    await consumer.dispose()
    await expect(binding.fs.readText('nested/file.txt', 6)).rejects.toThrow('disposed')
    await expect(scope.stat([])).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it('invalidates captured capabilities when the filesystem provider unloads', async () => {
    const { harness, mount } = await fixture()
    const { binding } = await mount()
    await harness.dependencies.fs.dispose()
    await expect(binding.fs.readText('nested/file.txt', 6)).rejects.toThrow()
    await expect(binding.subprocess.start(command)).rejects.toThrow()
  })

  it.each(['caller', 'provider'] as const)('cancels pending binding when its %s unloads', async (owner) => {
    const { harness, workspace } = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const stopped = Promise.withResolvers<undefined>()
    vi.spyOn(harness.ctx.fs, 'resolve').mockImplementation((_path, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => { reject(new Error(String(options.signal?.reason))) }, { once: true })
      entered.resolve(undefined)
    }))
    const published = vi.fn()
    const consumer = harness.ctx.plugin({
      name: 'pending-binding-consumer',
      inject: ['executionWorldIdentity', 'fs', 'subprocess', 'sandbox'],
      async apply(ctx: Context) {
        try { published(await bindReadOnlyExecutionWorld(ctx, workspace)) }
        finally { stopped.resolve(undefined) }
      },
    })
    onTestFinished(() => consumer.dispose())
    const rejected = expect(Promise.resolve(consumer)).rejects.toThrow(/binding startup/u)
    await entered.promise
    await (owner === 'caller' ? consumer.dispose() : harness.dependencies.fs.dispose())
    await stopped.promise
    await rejected
    expect(published).not.toHaveBeenCalled()
  })

  it('closes its root when the outer lifetime signal aborts', async () => {
    const { mount } = await fixture()
    const controller = new AbortController()
    const { binding, scope } = await mount(controller.signal)
    const closed = Promise.withResolvers<undefined>()
    const nativeClose = scope.close.bind(scope)
    const close = vi.spyOn(scope, 'close').mockImplementation(async () => { await nativeClose(); closed.resolve(undefined) })
    controller.abort(new Error('binding lifetime cancelled'))
    await closed.promise
    await binding.dispose()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('joins cleanup already started by lifetime cancellation', async () => {
    const { mount } = await fixture()
    const controller = new AbortController()
    const { binding, scope } = await mount(controller.signal)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const nativeClose = scope.close.bind(scope)
    vi.spyOn(scope, 'close').mockImplementation(async () => { entered.resolve(undefined); await release.promise; await nativeClose() })
    controller.abort()
    await entered.promise
    let disposed = false
    const pending = binding.dispose().then(() => { disposed = true })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(disposed).toBe(false)
    } finally {
      release.resolve(undefined)
      await pending
    }
  })

  it('reports cancellation cleanup failures to later explicit disposal', async () => {
    const { mount } = await fixture()
    const controller = new AbortController()
    const { binding, scope } = await mount(controller.signal)
    const entered = Promise.withResolvers<undefined>()
    const nativeClose = scope.close.bind(scope)
    vi.spyOn(scope, 'close').mockImplementation(async () => { await nativeClose(); entered.resolve(undefined); throw new Error('root close failed') })
    controller.abort()
    await entered.promise
    await expect(binding.dispose()).rejects.toThrow('read-only execution cleanup failed')
    await expect(binding.dispose()).rejects.toThrow('read-only execution cleanup failed')
  })
})

describe('root-bound process setup', () => {
  it('waits for a running process range to exit when disposed', async () => {
    const { mount } = await fixture()
    const { binding } = await mount()
    const { handle } = await binding.subprocess.start({
      ...command,
      argv: [process.execPath, '-e', 'process.stdout.write("ready");setInterval(() => {}, 1000)'],
      stdout: 'pipe',
    })
    expect(handle.stdout).toBeDefined()
    const output = handle.stdout![Symbol.asyncIterator]()
    const chunk: unknown = (await output.next()).value
    expect(Buffer.isBuffer(chunk) ? chunk.toString() : chunk).toBe('ready')
    await binding.dispose()
    expect(await handle.waitForExit()).toBe(true)
    await handle.done
    await output.return?.()
    await expect(binding.subprocess.start(command)).rejects.toThrow('disposed')
  })

  it('rejects pre-cancelled binding before root resolution', async () => {
    const { harness, mount } = await fixture()
    const resolve = vi.spyOn(harness.ctx.fs, 'resolve')
    await expect(mount(AbortSignal.abort(new Error('binding cancelled')))).rejects.toThrow('binding cancelled')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not publish a binding cancelled during root resolution', async () => {
    const { harness, mount } = await fixture()
    const controller = new AbortController()
    const original = harness.ctx.fs.resolve.bind(harness.ctx.fs)
    vi.spyOn(harness.ctx.fs, 'resolve').mockImplementation(async (...args) => {
      const target = await original(...args)
      controller.abort(new Error('root resolution cancelled'))
      return target
    })
    const stat = vi.spyOn(harness.ctx.fs, 'stat')
    await expect(mount(controller.signal)).rejects.toThrow('root resolution cancelled')
    expect(stat).not.toHaveBeenCalled()
  })

  it('fails closed when confinement is unavailable', async () => {
    const { harness, mount } = await fixture()
    const { binding } = await mount()
    vi.spyOn(harness.ctx.sandbox, 'confine').mockRejectedValue(new Error('sandbox unavailable'))
    const spawn = vi.spyOn(harness.ctx.subprocess, 'spawn')
    await expect(binding.subprocess.start(command)).rejects.toThrow('sandbox unavailable')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does not confine or spawn after cancellation during executable lookup', async () => {
    const { harness, mount } = await fixture()
    const { binding } = await mount()
    const controller = new AbortController()
    vi.spyOn(harness.ctx.subprocess, 'resolveExecutable').mockImplementation(async () => {
      controller.abort(new Error('lookup cancelled'))
      return process.execPath
    })
    const confine = vi.spyOn(harness.ctx.sandbox, 'confine')
    const spawn = vi.spyOn(harness.ctx.subprocess, 'spawn')
    await expect(binding.subprocess.start({ ...command, signal: controller.signal })).rejects.toThrow('lookup cancelled')
    expect(confine).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('retains independent outputs and exact reported confinement facts', async () => {
    const { mount, workspace } = await fixture()
    const { binding } = await mount()
    const result = await binding.subprocess.start({ ...command, cwd: 'nested' })
    expect(result.enforcement).toBe('partial')
    expect(result.denialSignatures).toEqual(['test-denial'])
    expect(await result.handle.done).toEqual({ exitCode: 0, signal: null })
    expect(result.handle.collected.stdout?.readFrom(0)?.text).toBe('out')
    expect(result.handle.collected.stderr?.readFrom(0)?.text).toBe('err')
    expect(await readFile(join(workspace, 'nested/file.txt'), 'utf8')).toBe('hello\n')
  })

  it('does not spawn when cancellation arrives during confinement', async () => {
    const { harness, mount } = await fixture()
    const { binding } = await mount()
    const entered = Promise.withResolvers<undefined>()
    const confined = Promise.withResolvers<ConfinedArgv>()
    vi.spyOn(harness.ctx.sandbox, 'confine').mockImplementation(() => { entered.resolve(undefined); return confined.promise })
    const spawn = vi.spyOn(harness.ctx.subprocess, 'spawn')
    const controller = new AbortController()
    const pending = binding.subprocess.start({ ...command, signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('cancelled before spawn')
    await entered.promise
    controller.abort(new Error('cancelled before spawn'))
    confined.resolve({ argv: [...command.argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] })
    await rejected
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects an escaped cwd before executable lookup or confinement', async () => {
    const { harness, mount } = await fixture()
    const { binding } = await mount()
    const lookup = vi.spyOn(harness.ctx.subprocess, 'resolveExecutable')
    const confine = vi.spyOn(harness.ctx.sandbox, 'confine')
    await expect(binding.subprocess.start({ ...command, cwd: '..' })).rejects.toThrow('root-relative')
    expect(lookup).not.toHaveBeenCalled()
    expect(confine).not.toHaveBeenCalled()
  })
})
