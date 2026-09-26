import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, FiberState } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import ExecutionWorldIdentity from '../src/index.ts'
import { withAllocationLock } from '../src/allocation-lock.ts'
import { open } from './fixtures/harness.ts'

async function fixture(test: { onTestFinished(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-world-identity-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'workspace'))
  return root
}

it('reopens durable identity with fresh services and expires the old service', async (test) => {
  const root = await fixture(test)
  const first = await open(root)
  const old = first.ctx.executionWorldIdentity
  let workspaceId
  try {
    workspaceId = await old.resolve(join(root, 'workspace'))
    expect(workspaceId).toMatch(/^[0-9a-f-]{36}$/u)
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => old.resolve(join(root, 'workspace', '.'))))
    expect(new Set(concurrent)).toEqual(new Set([workspaceId]))
  } finally { await first.close() }
  await expect(old.resolve(join(root, 'workspace'))).rejects.toThrow(/disposed/u)
  const second = await open(root)
  try {
    expect(await second.ctx.executionWorldIdentity.resolve(join(root, 'workspace'))).toBe(workspaceId)
  } finally { await second.close() }
  const persisted = await readFile(join(root, 'storage', 'execution_world_identity.json'), 'utf8')
  expect(persisted).not.toContain(root)
  expect(persisted).not.toContain('targetKey')
  expect(persisted).not.toContain('displayPath')
})

it('separates deployments at the same root and reuses a deployment after restart', async (test) => {
  const root = await fixture(test)
  const ids: string[] = []
  for (const deploymentId of ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001']) {
    const harness = await open(root, { mode: 'deployment', deploymentId })
    try { ids.push(await harness.ctx.executionWorldIdentity.resolve(join(root, 'workspace'))) }
    finally { await harness.close() }
  }
  expect(ids[0]).not.toBe(ids[1])
  expect(ids[2]).toBe(ids[0])
})

it('reuses durable identity across separate Node processes', async (test) => {
  const root = await fixture(test)
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  const run = () => promisify(execFile)(process.execPath, [
    '--import', 'tsx/esm', fileURLToPath(new URL('./fixtures/restart.ts', import.meta.url)), root,
  ], {
    cwd: repoRoot,
    env: { ...process.env, TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.host.json') },
    timeout: 30_000,
    maxBuffer: 8192,
  })
  const first = JSON.parse((await run()).stdout) as { workspaceId: string; pid: number }
  const second = JSON.parse((await run()).stdout) as { workspaceId: string; pid: number }
  expect(first.workspaceId).toMatch(/^[0-9a-f-]{36}$/u)
  expect(second.workspaceId).toBe(first.workspaceId)
  expect(first.pid).not.toBe(process.pid)
  expect(second.pid).not.toBe(process.pid)
})

it('uses provider canonical keys rather than host path parsing', async (test) => {
  const root = await fixture(test)
  const harness = await open(root)
  try {
    const target = await harness.ctx.fs.resolve(join(root, 'workspace'))
    const resolve = vi.spyOn(harness.ctx.fs, 'resolve').mockResolvedValue(target)
    expect(await harness.ctx.executionWorldIdentity.resolve('/remote/alias')).toBe(await harness.ctx.executionWorldIdentity.resolve('/remote/canonical'))
    expect(resolve.mock.calls[0]?.[0]).toBe('/remote/alias')
    expect(resolve.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  } finally { await harness.close() }
})

it('separates independent local stores with identical canonical target keys', async (test) => {
  const firstRoot = await fixture(test)
  const secondRoot = await fixture(test)
  const first = await open(firstRoot)
  try {
    const second = await open(secondRoot)
    try {
      const target = await first.ctx.fs.resolve(join(firstRoot, 'workspace'))
      vi.spyOn(first.ctx.fs, 'resolve').mockResolvedValue(target)
      vi.spyOn(second.ctx.fs, 'resolve').mockResolvedValue(target)
      vi.spyOn(second.ctx.fs, 'stat').mockResolvedValue(await first.ctx.fs.stat(target))
      const firstId = await first.ctx.executionWorldIdentity.resolve('/same/root')
      const secondId = await second.ctx.executionWorldIdentity.resolve('/same/root')
      expect(secondId).not.toBe(firstId)
    } finally { await second.close() }
  } finally { await first.close() }
})

it('shares real directory aliases without merging distinct roots', async (test) => {
  const root = await fixture(test)
  const workspace = join(root, 'workspace')
  const alias = join(root, 'alias')
  await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await mkdir(join(root, 'other'))
  const harness = await open(root)
  try {
    const original = await harness.ctx.executionWorldIdentity.resolve(workspace)
    expect(await harness.ctx.executionWorldIdentity.resolve(alias)).toBe(original)
    expect(await harness.ctx.executionWorldIdentity.resolve(join(root, 'other'))).not.toBe(original)
  } finally { await harness.close() }
})

it('rejects absent roots, regular files and cancelled calls', async (test) => {
  const root = await fixture(test)
  await writeFile(join(root, 'file'), 'data')
  const harness = await open(root)
  try {
    await expect(harness.ctx.executionWorldIdentity.resolve(join(root, 'missing'))).rejects.toThrow(/existing directory/u)
    await expect(harness.ctx.executionWorldIdentity.resolve(join(root, 'file'))).rejects.toThrow(/existing directory/u)
    await expect(harness.ctx.executionWorldIdentity.resolve(root, AbortSignal.abort())).rejects.toThrow()
  } finally { await harness.close() }
})

it('joins a blocked stat on disposal without publishing an identity', async (test) => {
  const root = await fixture(test)
  const harness = await open(root)
  const target = await harness.ctx.fs.resolve(join(root, 'workspace'))
  const info = await harness.ctx.fs.stat(target)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  vi.spyOn(harness.ctx.fs, 'stat').mockImplementation(async (_target, signal) => {
    signal?.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    entered.resolve(undefined)
    await release.promise
    return info
  })
  const rejected = expect(harness.ctx.executionWorldIdentity.resolve(join(root, 'workspace'))).rejects.toThrow(/disposed/u)
  await entered.promise
  let closed = false
  const closing = harness.close().then(() => { closed = true })
  try {
    await aborted.promise
    expect(closed).toBe(false)
  } finally {
    release.resolve(undefined)
    await closing
    await rejected
  }
})

it('fails activation on a genuine allocation timeout', async (test) => {
  const root = await fixture(test)
  const harness = await open(root, { mode: 'persisted-local' }, false)
  const allocationLockPath = join(root, 'identity.lock')
  try {
    await withAllocationLock(allocationLockPath, 30_000, new AbortController().signal, async () => {
      const fiber = harness.ctx.plugin(ExecutionWorldIdentity, { mode: 'persisted-local', allocationLockPath, lockWaitMs: 1 })
      try {
        await expect(fiber).rejects.toThrow('identity allocation lock wait timed out')
        expect(fiber.state).not.toBe(FiberState.ACTIVE)
        expect(harness.ctx.get('executionWorldIdentity')).toBeUndefined()
      } finally { await fiber.dispose() }
    })
  } finally { await harness.close() }
})

it('disposes pending activation without waiting for allocation ownership', async (test) => {
  const root = await fixture(test)
  const harness = await open(root, { mode: 'persisted-local' }, false)
  const config = { mode: 'persisted-local' as const, allocationLockPath: join(root, 'identity.lock') }
  try {
    await withAllocationLock(config.allocationLockPath, 30_000, new AbortController().signal, async () => {
      const fiber = harness.ctx.plugin(ExecutionWorldIdentity, config)
      const activation = fiber.await().then(() => 'activated', () => 'rejected')
      try {
        await vi.waitFor(() => {
          expect(fiber.state).toBe(FiberState.LOADING)
          expect(harness.ctx.get('executionWorldIdentity', false)).toBeDefined()
        })
        await fiber.dispose()
        await activation
        expect(harness.ctx.get('executionWorldIdentity')).toBeUndefined()
      } finally { await fiber.dispose() }
    })
    const fresh = harness.ctx.plugin(ExecutionWorldIdentity, config)
    try {
      await fresh.await()
      expect(await harness.ctx.executionWorldIdentity.resolve(join(root, 'workspace'))).toMatch(/^[0-9a-f-]{36}$/u)
    } finally { await fresh.dispose() }
  } finally { await harness.close() }
})

it.for(['fs', 'storageDomain'] as const)('restarts pending activation after replacing %s', async (dependency, test) => {
  const root = await fixture(test)
  const harness = await open(root, { mode: 'persisted-local' }, false)
  const config = { mode: 'persisted-local' as const, allocationLockPath: join(root, 'identity.lock') }
  const fiber = harness.ctx.plugin(ExecutionWorldIdentity, config)
  try {
    await withAllocationLock(config.allocationLockPath, 30_000, new AbortController().signal, async () => {
      await vi.waitFor(() => {
        expect(fiber.state).toBe(FiberState.LOADING)
        expect(harness.ctx.get('executionWorldIdentity', false)).toBeDefined()
      })
      await harness.dependencies[dependency].dispose()
      await vi.waitFor(() => {
        expect(fiber.state).toBe(FiberState.PENDING)
        expect(fiber.inertia).toBeUndefined()
      })
      expect(harness.ctx.get('executionWorldIdentity')).toBeUndefined()
      await harness.restoreDependency(dependency)
      await vi.waitFor(() => { expect(fiber.state).toBe(FiberState.LOADING) })
    })
    await fiber.await()
    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(await harness.ctx.executionWorldIdentity.resolve(join(root, 'workspace'))).toMatch(/^[0-9a-f-]{36}$/u)
  } finally {
    await fiber.dispose()
    await harness.close()
  }
})

it('disposes allocations waiting for ownership without publishing queued roots', async (test) => {
  const root = await fixture(test)
  const harness = await open(root)
  const storagePath = join(root, 'storage', 'execution_world_identity.json')
  const before = await readFile(storagePath, 'utf8')
  const bothStatted = Promise.withResolvers<undefined>()
  const originalStat = harness.ctx.fs.stat.bind(harness.ctx.fs)
  let calls = 0
  vi.spyOn(harness.ctx.fs, 'stat').mockImplementation(async (...args) => {
    const info = await originalStat(...args)
    calls += 1
    if (calls === 2) bothStatted.resolve(undefined)
    return info
  })
  try {
    await withAllocationLock(join(root, 'identity.lock'), 30_000, new AbortController().signal, async () => {
      const first = expect(harness.ctx.executionWorldIdentity.resolve(join(root, 'workspace'))).rejects.toThrow()
      const second = expect(harness.ctx.executionWorldIdentity.resolve(root)).rejects.toThrow()
      await bothStatted.promise
      await harness.close()
      await Promise.all([first, second])
    })
    expect(await readFile(storagePath, 'utf8')).toBe(before)
  } finally { await harness.close() }
})

it('retains a committed mapping when the caller cancels at durability acknowledgement', async (test) => {
  const root = await fixture(test)
  const harness = await open(root)
  const controller = new AbortController()
  let committed: unknown
  const unsubscribe = harness.ctx.on('domain/changed', (change) => {
    if (change.domain === 'execution_world_identity' && change.table === 'roots' && change.operation === 'put') {
      committed = change.value
      controller.abort(new Error('cancelled after commit'))
    }
  })
  try {
    await expect(harness.ctx.executionWorldIdentity.resolve(join(root, 'workspace'), controller.signal)).rejects.toThrow('cancelled after commit')
    const workspaceId = await harness.ctx.executionWorldIdentity.resolve(join(root, 'workspace'))
    expect(committed).toEqual({ workspaceId })
  } finally {
    unsubscribe()
    await harness.close()
  }
  const reopened = await open(root)
  try {
    expect(committed).toEqual({ workspaceId: await reopened.ctx.executionWorldIdentity.resolve(join(root, 'workspace')) })
  } finally { await reopened.close() }
})

it('rejects missing or malformed deployment IDs and local-mode overrides', () => {
  const allocationLockPath = join(tmpdir(), 'identity-config-validation.lock')
  expect(() => new ExecutionWorldIdentity(new Context(), { mode: 'deployment', allocationLockPath })).toThrow()
  expect(() => new ExecutionWorldIdentity(new Context(), { mode: 'deployment', deploymentId: 'host.example', allocationLockPath })).toThrow()
  expect(() => new ExecutionWorldIdentity(new Context(), { mode: 'persisted-local', deploymentId: '00000000-0000-4000-8000-000000000001', allocationLockPath })).toThrow()
  expect(() => new ExecutionWorldIdentity(new Context(), { mode: 'persisted-local', allocationLockPath: 'relative.lock' })).toThrow()
  if (process.platform === 'win32') {
    expect(() => new ExecutionWorldIdentity(new Context(), { mode: 'persisted-local', allocationLockPath: '\\locks\\identity.lock' })).toThrow()
  }
})

it('joins provider resolution on disposal and prevents a late stat or allocation', async (test) => {
  const root = await fixture(test)
  const harness = await open(root)
  const target = await harness.ctx.fs.resolve(join(root, 'workspace'))
  const pending = Promise.withResolvers<FsTarget>()
  const aborted = Promise.withResolvers<undefined>()
  vi.spyOn(harness.ctx.fs, 'resolve').mockImplementation(async (_path, options) => {
    options?.signal?.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    return pending.promise
  })
  const stat = vi.spyOn(harness.ctx.fs, 'stat')
  const operation = harness.ctx.executionWorldIdentity.resolve('/remote/root')
  const rejected = expect(operation).rejects.toThrow(/disposed/u)
  let closed = false
  const closing = harness.close().then(() => { closed = true })
  try {
    await aborted.promise
    expect(closed).toBe(false)
  } finally {
    pending.resolve(target)
    await closing
    await rejected
  }
  expect(stat).not.toHaveBeenCalled()
})
