/** Native Linux descriptor scopes reject escapes and retain opened-object ownership. */
import { fstatSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openLinuxReadRoot } from '../src/root-read-linux.ts'

it.skipIf(process.platform !== 'linux')('deny-alias root never resolves a harmless name into a sensitive target', async () => {
  await fixture(async (directory) => {
    await mkdir(join(directory, '.ssh'))
    await writeFile(join(directory, '.ssh', 'secret'), 'SECRET')
    await symlink('.ssh', join(directory, 'innocent'))
    const scope = await openLinuxReadRoot(directory, undefined, {}, { aliasPolicy: 'deny' })
    try {
      expect(scope.aliasPolicy).toBe('deny')
      await expect(scope.stat(['innocent'])).rejects.toThrow()
      await expect(scope.listDir(['innocent'])).rejects.toThrow()
      await expect(scope.readText(['innocent', 'secret'], 6)).rejects.toThrow()
      await expect(scope.readText(['.ssh', 'secret'], 6)).resolves.toBe('SECRET')
    } finally {
      await scope.close()
    }
  })
})

it.skipIf(process.platform !== 'linux')('deny-alias traversal rejects a link installed before the next component opens', async () => {
  await fixture(async (directory) => {
    await mkdir(join(directory, 'parent', 'innocent'), { recursive: true })
    await mkdir(join(directory, '.ssh'))
    await writeFile(join(directory, '.ssh', 'secret'), 'SECRET')
    const scope = await openLinuxReadRoot(directory, undefined, {
      afterComponentOpen: async (index) => {
        if (index !== 0) return
        await rename(join(directory, 'parent', 'innocent'), join(directory, 'retained'))
        await symlink('../.ssh', join(directory, 'parent', 'innocent'))
      },
    }, { aliasPolicy: 'deny' })
    try {
      await expect(scope.readText(['parent', 'innocent', 'secret'], 6)).rejects.toThrow()
    } finally {
      await scope.close()
    }
  })
})
import type { LinuxReadRootInternals } from '../src/root-read-linux.ts'

async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-linux-root-'))
  try {
    await run(directory)
  } finally {
    expect(relative(resolve(tmpdir()), resolve(directory))).toMatch(/^dsh-linux-root-[^/]+$/u)
    await rm(directory, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform !== 'linux')('Linux native read root', () => {
  it('reads contained absolute and relative aliases and enumerates the opened directory', async () => {
    await fixture(async (directory) => {
      await mkdir(join(directory, 'actual'))
      await writeFile(join(directory, 'actual', 'value.txt'), 'INSIDE')
      await symlink('actual', join(directory, 'relative'))
      await symlink(join(directory, 'actual'), join(directory, 'absolute'))
      const scope = await openLinuxReadRoot(directory)
      try {
        for (const alias of ['actual', 'relative', 'absolute']) {
          expect(await scope.readText([alias, 'value.txt'], 6)).toBe('INSIDE')
          expect(await scope.stat([alias, 'value.txt'])).toEqual({ type: 'file', size: 6 })
          expect(await scope.listDir([alias])).toEqual([{ name: 'value.txt', type: 'file' }])
        }
        expect(await scope.stat(['absent'])).toBeUndefined()
        await expect(scope.readText(['actual', 'value.txt'], 5)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
      } finally {
        await scope.close()
      }
      await scope.close()
      await expect(scope.stat([])).rejects.toMatchObject({ code: 'FS_ABORTED' })
    })
  })

  it('rejects escaping aliases and malformed components', async () => {
    await fixture(async (directory) => {
      await mkdir(join(directory, 'root'))
      await writeFile(join(directory, 'secret'), 'OUTSIDE')
      await symlink('../secret', join(directory, 'root', 'escape'))
      const scope = await openLinuxReadRoot(join(directory, 'root'))
      try {
        await expect(scope.readText(['escape'], 100)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
        for (const invalid of ['', '.', '..', 'a/b', 'a\\b', '\0']) {
          await expect(scope.stat([invalid])).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
        }
      } finally {
        await scope.close()
      }
    })
  })

  it('rejects a replacement at the original root locator', async () => {
    await fixture(async (directory) => {
      const root = join(directory, 'root')
      await mkdir(root)
      const scope = await openLinuxReadRoot(root)
      try {
        await rename(root, join(directory, 'pinned'))
        await mkdir(root)
        await writeFile(join(root, 'value.txt'), 'OUTSIDE')
        await expect(scope.readText(['value.txt'], 100)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      } finally {
        await scope.close()
      }
    })
  })

  it.each(['canonical', 'component', 'file', 'directory'] as const)(
    'does not follow namespace replacement at the %s barrier', async (phase) => {
      await fixture(async (directory) => {
        const root = join(directory, 'root')
        const nested = join(root, 'nested')
        const outside = join(directory, 'outside')
        await mkdir(nested, { recursive: true })
        await mkdir(outside)
        await writeFile(join(nested, 'inside.txt'), 'INSIDE')
        await writeFile(join(outside, 'inside.txt'), 'OUTSIDE')
        await writeFile(join(outside, 'secret.txt'), 'SECRET')
        const replace = async () => {
          await rename(nested, join(root, 'pinned'))
          await symlink(outside, nested)
        }
        const internals: LinuxReadRootInternals = phase === 'canonical'
          ? { afterCanonicalResolve: replace }
          : phase === 'component' ? { afterComponentOpen: replace } : { afterTargetOpen: replace }
        const scope = await openLinuxReadRoot(root, undefined, internals)
        try {
          if (phase === 'canonical') {
            await expect(scope.readText(['nested', 'inside.txt'], 100)).rejects.toMatchObject({ code: 'FS_NOT_DIRECTORY' })
          } else if (phase === 'directory') {
            expect(await scope.listDir(['nested'])).toEqual([{ name: 'inside.txt', type: 'file' }])
          } else {
            expect(await scope.readText(['nested', 'inside.txt'], 100)).toBe('INSIDE')
          }
        } finally {
          await scope.close()
        }
      })
    },
  )

  it('closes an operation descriptor after cancellation at the open barrier', async () => {
    await fixture(async (directory) => {
      await writeFile(join(directory, 'value.txt'), 'INSIDE')
      const cancellation = new AbortController()
      let observed: number | undefined
      const scope = await openLinuxReadRoot(directory, undefined, {
        afterTargetOpen: (descriptor) => {
          observed = descriptor
          cancellation.abort()
          return Promise.resolve()
        },
      })
      try {
        await expect(scope.readText(['value.txt'], 6, cancellation.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
        const descriptor = observed
        if (descriptor === undefined) throw new Error('No operation descriptor')
        expect(() => fstatSync(descriptor)).toThrow(expect.objectContaining({ code: 'EBADF' }))
      } finally {
        await scope.close()
      }
    })
  })

  it('joins an opened operation before closing and rejects new operations', async () => {
    await fixture(async (directory) => {
      await writeFile(join(directory, 'value.txt'), 'INSIDE')
      const entered = Promise.withResolvers<number>()
      const release = Promise.withResolvers<undefined>()
      const scope = await openLinuxReadRoot(directory, undefined, {
        afterTargetOpen: async (descriptor) => {
          entered.resolve(descriptor)
          await release.promise
        },
      })
      const operation = scope.readText(['value.txt'], 6)
      const rejected = expect(operation).rejects.toMatchObject({ code: 'FS_ABORTED' })
      try {
        const descriptor = await entered.promise
        const closing = scope.close()
        expect(scope.close()).toBe(closing)
        expect(fstatSync(descriptor).isFile()).toBe(true)
        await expect(scope.stat([])).rejects.toMatchObject({ code: 'FS_ABORTED' })
        release.resolve(undefined)
        await rejected
        await closing
        expect(() => fstatSync(descriptor)).toThrow(expect.objectContaining({ code: 'EBADF' }))
      } finally {
        release.resolve(undefined)
        await Promise.allSettled([operation, rejected, scope.close()])
      }
    })
  })

  it('rejects growth, binary text and unsupported byte ceilings', async () => {
    await fixture(async (directory) => {
      const file = join(directory, 'value.txt')
      await writeFile(file, '')
      const scope = await openLinuxReadRoot(directory)
      let growing: Awaited<ReturnType<typeof openLinuxReadRoot>> | undefined
      try {
        expect(await scope.readText(['value.txt'], 0)).toBe('')
        await writeFile(file, 'A')
        await expect(scope.readText(['value.txt'], 0)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
        await expect(scope.readText(['value.txt'], Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
        growing = await openLinuxReadRoot(directory, undefined, { afterSizeCheck: () => appendFile(file, 'B') })
        await expect(growing.readText(['value.txt'], 1)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
        await writeFile(file, Buffer.from([0]))
        await expect(scope.readText(['value.txt'], 1)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
        await writeFile(file, Buffer.from([0xff]))
        await expect(scope.readText(['value.txt'], 1)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
      } finally {
        await growing?.close()
        await scope.close()
      }
    })
  })
})
