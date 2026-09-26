/** Real Linux helper scope ownership over the existing administrative transport. */
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { Context, Service } from '@deepseek-ai/cordis'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { supportsRootRead } from '@deepseek-ai/dsh-fs'
import type { FsReadRoot, FsTarget } from '@deepseek-ai/dsh-fs'
import { z } from 'zod'
import { createHelperHarness as helper } from './fixtures/helper.ts'
import { readRootIdSchema, rootEntriesSchema, rootInfoSchema, targetSchema } from '../src/schemas.ts'
import { SSH_MAX_READ_ROOTS } from '../src/protocol.ts'

async function observedHelper() {
  const observation = vi.spyOn(LocalFileSystem.prototype, 'resolve')
  try {
    const test = await helper()
    const filesystem = observation.mock.contexts.find((context: unknown): context is LocalFileSystem => context instanceof LocalFileSystem)
    if (filesystem === undefined || !supportsRootRead(filesystem)) {
      await test.close()
      throw new Error('Helper did not mount a native read root provider')
    }
    return { ...test, filesystem }
  } finally { observation.mockRestore() }
}

describe.skipIf(process.platform !== 'linux')('SSH helper native read roots', () => {
  it('enforces the requested deny-alias policy in the native helper', async () => {
    const test = await helper()
    try {
      await writeFile(join(test.root, '.env'), 'SECRET')
      await symlink('.env', join(test.root, 'innocent'))
      const target = await test.client.request('fs.resolve', { path: '.' }, targetSchema)
      const id = await test.client.request('fs.rootOpen', { target, aliasPolicy: 'deny' }, readRootIdSchema)
      await expect(test.client.request('fs.rootReadText', { id, segments: ['innocent'], maxBytes: 6 }, z.string())).rejects.toThrow()
      await expect(test.client.request('fs.rootReadText', { id, segments: ['.env'], maxBytes: 6 }, z.string())).resolves.toBe('SECRET')
      await test.client.request('fs.rootClose', { id }, z.null())
    } finally {
      await test.close()
    }
  })

  it('closes an unpublished scope when its provider ignores alias policy', async () => {
    const test = await observedHelper()
    const nativeOpen = test.filesystem.openReadRoot
    let close = vi.fn(async () => {})
    const intercept = vi.spyOn(test.filesystem, 'openReadRoot').mockImplementation(async (target, signal) => {
      const scope = await nativeOpen(target, signal)
      close = vi.fn(() => scope.close())
      return { ...scope, close }
    })
    try {
      const target = await test.client.request('fs.resolve', { path: '.' }, targetSchema)
      await expect(test.client.request('fs.rootOpen', { target, aliasPolicy: 'deny' }, readRootIdSchema)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      intercept.mockRestore()
      await test.close()
    }
  })

  it('rejects helper cleanup acknowledgement when a root close fails', async () => {
    const test = await observedHelper()
    const nativeOpen = test.filesystem.openReadRoot
    const intercept = vi.spyOn(test.filesystem, 'openReadRoot').mockImplementation(async (target: FsTarget, signal?: AbortSignal) => {
      const scope = await nativeOpen(target, signal)
      const nativeClose = scope.close.bind(scope)
      scope.close = async () => { await nativeClose(); throw new Error('Injected shutdown close failure') }
      return scope
    })
    try {
      const target = await test.client.request('fs.resolve', { path: '.' }, targetSchema)
      await test.client.request('fs.rootOpen', { target, aliasPolicy: 'follow-contained' }, readRootIdSchema)
      await expect(test.client.request('close', {}, z.null())).rejects.toThrow('read root cleanup failed')
    } finally {
      await expect(test.close()).rejects.toThrow('read root cleanup failed')
      intercept.mockRestore()
    }
  })

  it.each(['pending', 'failed'] as const)('retains ownership while close is %s', async (kind) => {
    const test = await observedHelper()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const nativeOpen = test.filesystem.openReadRoot
    let calls = 0
    const intercept = vi.spyOn(test.filesystem, 'openReadRoot').mockImplementation(async (target: FsTarget, signal?: AbortSignal) => {
      const scope = await nativeOpen(target, signal)
      const nativeClose = scope.close.bind(scope)
      scope.close = async () => {
        calls += 1
        entered.resolve(undefined)
        if (kind === 'failed' && calls === 1) throw new Error('Injected close failure')
        await release.promise
        await nativeClose()
      }
      return scope
    })
    const pending: Promise<unknown>[] = []
    try {
      const target = await test.client.request('fs.resolve', { path: '.' }, targetSchema)
      const id = await test.client.request('fs.rootOpen', { target, aliasPolicy: 'follow-contained' }, readRootIdSchema)
      const first = test.client.request('fs.rootClose', { id }, z.null())
      pending.push(first)
      if (kind === 'failed') await expect(first).rejects.toThrow('Injected close failure')
      else await entered.promise
      let settled = false
      const second = test.client.request('fs.rootClose', { id }, z.null()).then(() => { settled = true })
      pending.push(second)
      await test.client.request('heartbeat', {}, z.null())
      expect(calls).toBe(2)
      expect(settled).toBe(false)
      release.resolve(undefined)
      await second
      if (kind === 'pending') await first
      await expect(test.client.request('fs.rootStat', { id, segments: [] }, rootInfoSchema)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    } finally {
      release.resolve(undefined)
      await Promise.allSettled(pending)
      if (kind === 'failed') await expect(test.close()).rejects.toThrow('read root cleanup failed')
      else await test.close()
      intercept.mockRestore()
    }
  })

  it('reclaims a published root when cancellation wins before response delivery', async () => {
    const test = await observedHelper()
    class Connection extends Service {
      constructor(ctx: Context) { super(ctx, 'ssh') }
      request = test.connection.request
    }
    class Policy extends Service {
      constructor(ctx: Context) { super(ctx, 'sandboxPolicy') }
    }
    const context = new Context()
    const fibers = [await context.plugin(Connection), await context.plugin(Policy), await context.plugin(SshFileSystem)]
    const filesystem = context.fs
    if (!supportsRootRead(filesystem)) throw new Error('Missing SSH root reader')
    const withheld = Promise.withResolvers<Buffer>()
    const released = Promise.withResolvers<undefined>()
    const nativeOpen = test.filesystem.openReadRoot
    const observe = vi.spyOn(test.filesystem, 'openReadRoot').mockImplementation(async (target: FsTarget, signal?: AbortSignal) => {
      const scope = await nativeOpen(target, signal)
      const nativeClose = scope.close.bind(scope)
      scope.close = async () => { await nativeClose(); released.resolve(undefined) }
      return scope
    })
    const originalWrite = test.output.write.bind(test.output)
    let intercept: { mockRestore(): void } | undefined
    const cancellation = new AbortController()
    let pending: Promise<unknown> | undefined
    try {
      const target = await filesystem.resolve('.')
      intercept = vi.spyOn(test.output, 'write').mockImplementation((chunk: unknown) => {
        if (!Buffer.isBuffer(chunk)) throw new Error('Expected one framed helper response')
        intercept?.mockRestore()
        withheld.resolve(Buffer.from(chunk))
        return true
      })
      pending = filesystem.openReadRoot(target, cancellation.signal)
      const rejected = expect(pending).rejects.toThrow()
      const response = await withheld.promise
      await test.client.request('heartbeat', {}, z.null())
      cancellation.abort()
      originalWrite(response)
      await rejected
      await released.promise
    } finally {
      intercept?.mockRestore()
      await test.close()
      await pending?.catch(() => undefined)
      for (const fiber of fibers.reverse()) await fiber.dispose()
      observe.mockRestore()
    }
  })

  it.each(['caller', 'transport'] as const)('joins an unpublished root after %s cancellation', async (kind) => {
    const test = await observedHelper()
    const entered = Promise.withResolvers<FsReadRoot>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const closed = Promise.withResolvers<undefined>()
    const nativeOpen = test.filesystem.openReadRoot
    if (nativeOpen === undefined) throw new Error('Missing native reader')
    const intercept = vi.spyOn(test.filesystem, 'openReadRoot').mockImplementation(async (target: FsTarget, signal?: AbortSignal) => {
      const scope = await nativeOpen(target, signal)
      const nativeClose = scope.close.bind(scope)
      scope.close = async () => { await nativeClose(); closed.resolve(undefined) }
      signal?.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      entered.resolve(scope)
      await release.promise
      return scope
    })
    const caller = new AbortController()
    let request: Promise<unknown> | undefined
    try {
      const target = await test.client.request('fs.resolve', { path: '.' }, targetSchema)
      request = test.client.request('fs.rootOpen', { target, aliasPolicy: 'follow-contained' }, readRootIdSchema, caller.signal)
      const rejected = expect(request).rejects.toThrow()
      const scope = await entered.promise
      if (kind === 'caller') caller.abort()
      else test.controller.abort()
      await aborted.promise
      release.resolve(undefined)
      await rejected
      await closed.promise
      await expect(scope.stat([])).rejects.toMatchObject({ code: 'FS_ABORTED' })
    } finally {
      release.resolve(undefined)
      await test.close()
      await request?.catch(() => undefined)
      intercept.mockRestore()
    }
  })

  it('joins published scope cleanup before transport shutdown completes', async () => {
    const test = await observedHelper()
    const closing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const nativeOpen = test.filesystem.openReadRoot
    if (nativeOpen === undefined) throw new Error('Missing native reader')
    const intercept = vi.spyOn(test.filesystem, 'openReadRoot').mockImplementation(async (target: FsTarget, signal?: AbortSignal) => {
      const scope = await nativeOpen(target, signal)
      const nativeClose = scope.close.bind(scope)
      scope.close = async () => {
        closing.resolve(undefined)
        await release.promise
        await nativeClose()
      }
      return scope
    })
    try {
      const target = await test.client.request('fs.resolve', { path: '.' }, targetSchema)
      await test.client.request('fs.rootOpen', { target, aliasPolicy: 'follow-contained' }, readRootIdSchema)
      let settled = false
      const shutdown = test.close().then(() => { settled = true })
      await closing.promise
      expect(settled).toBe(false)
      release.resolve(undefined)
      await shutdown
    } finally {
      release.resolve(undefined)
      await test.close()
      intercept.mockRestore()
    }
  })

  it('reads contained aliases, rejects escapes, and revokes explicitly closed scopes', async () => {
    const test = await helper()
    try {
      const root = join(test.root, 'scope')
      await mkdir(root)
      await writeFile(join(root, 'inside.txt'), 'INSIDE')
      await writeFile(join(test.root, 'outside.txt'), 'OUTSIDE')
      await symlink('inside.txt', join(root, 'alias'))
      await symlink('../outside.txt', join(root, 'escape'))
      const target = await test.client.request('fs.resolve', { path: root }, targetSchema)
      const id = await test.client.request('fs.rootOpen', { target, aliasPolicy: 'follow-contained' }, readRootIdSchema)
      expect(await test.client.request('fs.rootReadText', { id, segments: ['alias'], maxBytes: 6 }, z.string())).toBe('INSIDE')
      expect(await test.client.request('fs.rootStat', { id, segments: ['inside.txt'] }, rootInfoSchema)).toMatchObject({ type: 'file', size: 6 })
      expect(await test.client.request('fs.rootStat', { id, segments: ['missing'] }, z.null())).toBeNull()
      expect((await test.client.request('fs.rootList', { id, segments: [] }, rootEntriesSchema)).map(entry => entry.name))
        .toEqual(['alias', 'escape', 'inside.txt'])
      await expect(test.client.request('fs.rootReadText', { id, segments: ['escape'], maxBytes: 7 }, z.string()))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(test.client.request('fs.rootReadText', { id, segments: ['inside.txt'], maxBytes: 5 }, z.string()))
        .rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
      await expect(test.client.request('fs.rootStat', { id, segments: ['..'] }, z.unknown())).rejects.toThrow()
      await test.client.request('fs.rootClose', { id }, z.null())
      await test.client.request('fs.rootClose', { id }, z.null())
      await expect(test.client.request('fs.rootStat', { id, segments: [] }, z.unknown())).rejects.toMatchObject({ code: 'FS_ABORTED' })
    } finally { await test.close() }
  })

  it('bounds retained scopes and reclaims capacity after close', async () => {
    const test = await helper()
    try {
      const target = await test.client.request('fs.resolve', { path: '.' }, targetSchema)
      const roots = []
      for (let index = 0; index < SSH_MAX_READ_ROOTS; index++) {
        roots.push(await test.client.request('fs.rootOpen', { target, aliasPolicy: 'follow-contained' }, readRootIdSchema))
      }
      await expect(test.client.request('fs.rootOpen', { target, aliasPolicy: 'follow-contained' }, readRootIdSchema)).rejects.toThrow('read root limit')
      await test.client.request('fs.rootClose', { id: roots[0] }, z.null())
      const replacement = await test.client.request('fs.rootOpen', { target, aliasPolicy: 'follow-contained' }, readRootIdSchema)
      expect(roots).not.toContain(replacement)
    } finally { await test.close() }
  })
})
