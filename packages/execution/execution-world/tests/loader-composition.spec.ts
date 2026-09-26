import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { expect, it } from 'vitest'
import ExecutionWorldIdentity from '../src/index.ts'
import { withAllocationLock } from '../src/allocation-lock.ts'

async function load(test: { onTestFinished(fn: () => Promise<void>): void }, invalid = false, existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'dsh-world-loader-'))
  const ctx = new Context()
  test.onTestFinished(async () => {
    await ctx.fiber.dispose()
    if (existingRoot === undefined) await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, 'workspace'), { recursive: true })
  const allocationLockPath = join(root, 'identity.lock')
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', JsonStorage],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-session-projection', SessionProjections],
    ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicy],
    ['@deepseek-ai/dsh-fs-sandbox', SandboxedFileSystem],
    ['@deepseek-ai/dsh-execution-world', ExecutionWorldIdentity],
  ])
  const entries = [
    { id: 'storage', name: '@deepseek-ai/dsh-storage' },
    { id: 'json', name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'storage') } },
    { id: 'domain', name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { id: 'projections', name: '@deepseek-ai/dsh-session-projection' },
    { id: 'policy', name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: 'read-only', workspaceRoot: root } },
    { id: 'filesystem', name: '@deepseek-ai/dsh-fs-sandbox', config: { cwd: root } },
    { id: 'identity', name: '@deepseek-ai/dsh-execution-world', config: { mode: invalid ? 'deployment' : 'persisted-local', allocationLockPath } },
  ]
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(entries))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const identityEntry = [...ctx.loader.entries()].find(entry => entry.options.id === 'identity')
  if (identityEntry === undefined) throw new Error('missing identity Loader entry')
  return { ctx, root, allocationLockPath, identityEntry }
}

it('preserves identity through Loader reload and sandbox filesystem and storage replacement', async (test) => {
  const { ctx, root, allocationLockPath, identityEntry } = await load(test)
  expect([...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
  expect(identityEntry.fiber?.state).toBe(FiberState.ACTIVE)
  expect(ctx.fs.sandboxMode).toBe('read-only')
  const workspaceRoot = join(root, 'workspace')
  const workspaceId = await ctx.executionWorldIdentity.resolve(workspaceRoot)
  const alias = join(root, 'alias')
  await symlink(workspaceRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(await ctx.executionWorldIdentity.resolve(alias)).toBe(workspaceId)
  for (const id of ['identity', 'filesystem', 'domain']) {
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === id)
    if (entry === undefined) throw new Error(`missing Loader entry: ${id}`)
    const previous = ctx.executionWorldIdentity
    await entry.update({ disabled: true })
    await ctx.loader.await()
    expect(ctx.get('executionWorldIdentity')).toBeUndefined()
    await expect(previous.resolve(workspaceRoot)).rejects.toThrow(/disposed/u)
    await entry.update({ disabled: false })
    await ctx.loader.await()
    expect(identityEntry.fiber?.state).toBe(FiberState.ACTIVE)
    expect(ctx.executionWorldIdentity).not.toBe(previous)
    expect(await ctx.executionWorldIdentity.resolve(workspaceRoot)).toBe(workspaceId)
  }
  await ctx.fiber.dispose()
  await expect(withAllocationLock(allocationLockPath, 1000, new AbortController().signal, async () => 'released')).resolves.toBe('released')
  const reopened = await load(test, false, root)
  try {
    expect(await reopened.ctx.executionWorldIdentity.resolve(workspaceRoot)).toBe(workspaceId)
  } finally { await reopened.ctx.fiber.dispose() }
})

it('leaves malformed deployment configuration unusable in a Loader composition', async (test) => {
  const { ctx, identityEntry } = await load(test, true)
  expect(identityEntry.fiber?.state).not.toBe(FiberState.ACTIVE)
  expect(ctx.get('executionWorldIdentity')).toBeUndefined()
  expect(identityEntry.fiber).toBeDefined()
  await expect(identityEntry.fiber?.await()).rejects.toThrow()
})
