import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import ExecutionWorldIdentity from '../../src/index.ts'
import type { Config } from '../../src/index.ts'

export async function open(root: string, config: Omit<Config, 'allocationLockPath'> = { mode: 'persisted-local' }, mountIdentity = true) {
  const ctx = new Context()
  const storage = ctx.plugin(Storage)
  const fibers = [storage]
  const close = async () => { for (const fiber of [...fibers].reverse()) await fiber.dispose() }
  try {
    await storage.await()
    const json = ctx.plugin(JsonStorage, { root: join(root, 'storage') })
    fibers.push(json)
    await json.await()
    const storageDomain = ctx.plugin(StorageDomain, { backend: 'json' })
    fibers.push(storageDomain)
    await storageDomain.await()
    const fs = ctx.plugin(LocalFileSystem, { cwd: root })
    fibers.push(fs)
    await fs.await()
    if (mountIdentity) {
      const identity = ctx.plugin(ExecutionWorldIdentity, { ...config, allocationLockPath: join(root, 'identity.lock') })
      fibers.push(identity)
      await identity.await()
    }
    const restoreDependency = async (name: 'fs' | 'storageDomain') => {
      const fiber = name === 'fs'
        ? ctx.plugin(LocalFileSystem, { cwd: root })
        : ctx.plugin(StorageDomain, { backend: 'json' })
      fibers.push(fiber)
      await fiber.await()
    }
    return { ctx, close, dependencies: { fs, storageDomain }, restoreDependency }
  } catch (error) {
    await close()
    throw error
  }
}
