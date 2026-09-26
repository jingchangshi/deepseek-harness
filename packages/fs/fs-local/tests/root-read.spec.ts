/** Optional root reads through the mounted local filesystem provider. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError, supportsRootRead } from '@deepseek-ai/dsh-fs'
import { describe, expect, it } from 'vitest'
import { LocalFileSystem } from '../src/index.ts'

const supported = process.platform === 'win32' || process.platform === 'linux'

async function fixture(run: (filesystem: LocalFileSystem, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-root-provider-'))
  const context = new Context()
  try {
    const fiber = await context.plugin(LocalFileSystem, { cwd: directory })
    try {
      await run(context.fs as LocalFileSystem, directory)
    } finally {
      await fiber.dispose()
    }
  } finally {
    expect(relative(resolve(tmpdir()), resolve(directory))).toMatch(/^dsh-root-provider-[^/\\]+$/u)
    await rm(directory, { recursive: true, force: true })
  }
}

it('advertises root reads only on implemented native platforms', async () => {
  await fixture(async (filesystem) => {
    expect(supportsRootRead(filesystem)).toBe(supported)
    if (!supported) expect(filesystem.openReadRoot).toBeUndefined()
  })
})

describe.skipIf(!supported)('mounted native root reader', () => {
  it('reads and lists through the optional capability without changing ordinary reads', async () => {
    await fixture(async (filesystem, directory) => {
      const root = join(directory, 'root')
      await mkdir(root)
      await writeFile(join(root, 'inside.txt'), 'INSIDE')
      await writeFile(join(directory, 'outside.txt'), 'OUTSIDE')
      if (!supportsRootRead(filesystem)) throw new Error('Missing native root reader')
      const scope = await filesystem.openReadRoot(await filesystem.resolve(root))
      try {
        expect(await scope.readText(['inside.txt'], 6)).toBe('INSIDE')
        expect((await scope.listDir([])).map(entry => entry.name)).toEqual(['inside.txt'])
        expect(await scope.stat(['missing'])).toBeUndefined()
        await expect(scope.readText(['..', 'outside.txt'], 7)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
        expect(await filesystem.readText(await filesystem.resolve(join(directory, 'outside.txt')))).toBe('OUTSIDE')
      } finally {
        const closing = scope.close()
        expect(scope.close()).toBe(closing)
        await closing
      }
      await expect(scope.readText(['inside.txt'], 6)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    })
  })

  it('returns typed errors for missing roots and cancelled opening', async () => {
    await fixture(async (filesystem, directory) => {
      if (!supportsRootRead(filesystem)) throw new Error('Missing native root reader')
      await expect(filesystem.openReadRoot(await filesystem.resolve(join(directory, 'missing'))))
        .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
      const root = await filesystem.resolve(directory)
      await expect(filesystem.openReadRoot(root, AbortSignal.abort()))
        .rejects.toBeInstanceOf(FsError)
      await expect(filesystem.openReadRoot(root, AbortSignal.abort()))
        .rejects.toMatchObject({ code: 'FS_ABORTED' })
    })
  })
})
