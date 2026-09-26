/** Native root scopes retain directory ownership across namespace replacement. */
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { fstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { openWin32ReadRoot, sameWin32RootIdentity } from '../src/root-read-win32.ts'
import type { Win32ReadRootInternals } from '../src/root-read-win32.ts'

describe.skipIf(process.platform !== 'win32')('Windows native read root', () => {
  it('deny-alias traversal rejects a junction installed before the next component opens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-deny-alias-'))
    await mkdir(join(directory, 'parent', 'innocent'), { recursive: true })
    await mkdir(join(directory, '.ssh'))
    await writeFile(join(directory, '.ssh', 'secret'), 'SECRET')
    const scope = await openWin32ReadRoot(directory, undefined, {
      afterComponentOpen: async (index) => {
        if (index !== 0) return
        await rename(join(directory, 'parent', 'innocent'), join(directory, 'retained'))
        await symlink(join(directory, '.ssh'), join(directory, 'parent', 'innocent'), 'junction')
      },
    }, { aliasPolicy: 'deny' })
    try {
      await expect(scope.readText(['parent', 'innocent', 'secret'], 6)).rejects.toThrow()
    } finally {
      await scope.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('includes every volume and 128-bit file identifier byte in root equality', () => {
    const identity = Buffer.alloc(24, 1)
    expect(sameWin32RootIdentity(identity, Buffer.from(identity))).toBe(true)
    for (let index = 0; index < identity.length; index += 1) {
      const changed = Buffer.from(identity)
      changed[index] = 2
      expect(sameWin32RootIdentity(identity, changed)).toBe(false)
    }
    expect(sameWin32RootIdentity(identity.subarray(0, 16), identity.subarray(0, 16))).toBe(false)
  })

  it('closes the transferred fd after caller cancellation without scheduling reads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-native-root-'))
    await writeFile(join(directory, 'value.txt'), 'INSIDE')
    const cancellation = new AbortController()
    let transferred: number | undefined
    const scope = await openWin32ReadRoot(directory, undefined, {
      afterHandleTransfer: (descriptor) => {
        transferred = descriptor
        expect(fstatSync(descriptor).isFile()).toBe(true)
        cancellation.abort()
        return Promise.resolve()
      },
    })
    try {
      await expect(scope.readText(['value.txt'], 6, cancellation.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
      expect(transferred).toBeDefined()
      const descriptor = transferred
      if (descriptor === undefined) throw new Error('Descriptor was not transferred')
      expect(() => fstatSync(descriptor)).toThrow(expect.objectContaining({ code: 'EBADF' }))
    } finally {
      await scope.close()
      expect(relative(resolve(tmpdir()), resolve(directory))).toMatch(/^dsh-native-root-[^\\/]+$/u)
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('follows contained junctions using canonical exact-case components', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-native-root-'))
    await mkdir(join(directory, 'ActualCase'))
    await writeFile(join(directory, 'ActualCase', 'Value.txt'), 'INSIDE')
    await symlink(join(directory, 'ActualCase'), join(directory, 'Alias'), 'junction')
    const scope = await openWin32ReadRoot(directory)
    try {
      expect(await scope.readText(['Alias', 'Value.txt'], 6)).toBe('INSIDE')
      expect(await scope.stat(['Alias'])).toMatchObject({ type: 'directory' })
      expect(await scope.listDir(['Alias'])).toEqual([{ name: 'Value.txt', type: 'file' }])
    } finally {
      await scope.close()
      expect(relative(resolve(tmpdir()), resolve(directory))).toMatch(/^dsh-native-root-[^\\/]+$/u)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(['canonical', 'component', 'file', 'directory'] as const)(
    'does not follow namespace replacement at the %s barrier', async (phase) => {
      const directory = await mkdtemp(join(tmpdir(), 'dsh-native-root-'))
      const root = join(directory, 'root')
      const nested = join(root, 'nested')
      const outside = join(directory, 'outside')
      await mkdir(nested, { recursive: true })
      await mkdir(outside)
      await writeFile(join(nested, 'inside.txt'), 'INSIDE')
      await writeFile(join(outside, 'inside.txt'), 'OUTSIDE')
      await writeFile(join(outside, 'outside-only.txt'), 'SECRET')
      const replace = async () => {
        if (phase === 'file') {
          await rename(join(nested, 'inside.txt'), join(nested, 'original.txt'))
          await writeFile(join(nested, 'inside.txt'), 'OUTSIDE')
          return
        }
        await rename(nested, join(root, 'pinned'))
        await symlink(outside, nested, 'junction')
      }
      const internals: Win32ReadRootInternals = phase === 'canonical'
        ? { afterCanonicalResolve: replace }
        : phase === 'component' ? { afterComponentOpen: replace } : { afterTargetOpen: replace }
      const scope = await openWin32ReadRoot(root, undefined, internals)
      try {
        if (phase === 'directory') {
          expect(await scope.listDir(['nested'])).toEqual([{ name: 'inside.txt', type: 'file' }])
        } else if (phase === 'canonical') {
          await expect(scope.readText(['nested', 'inside.txt'], 100)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
        } else {
          expect(await scope.readText(['nested', 'inside.txt'], 100)).toBe('INSIDE')
        }
      } finally {
        await scope.close()
        expect(relative(resolve(tmpdir()), resolve(directory))).toMatch(/^dsh-native-root-[^\\/]+$/u)
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it('rejects growth after size validation and unsupported allocation ceilings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-native-root-'))
    const file = join(directory, 'value.txt')
    await writeFile(file, '')
    const scope = await openWin32ReadRoot(directory)
    let growing: Awaited<ReturnType<typeof openWin32ReadRoot>> | undefined
    try {
      expect(await scope.readText(['value.txt'], 0)).toBe('')
      await writeFile(file, 'A')
      await expect(scope.readText(['value.txt'], 0)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
      await expect(scope.readText(['value.txt'], Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
      growing = await openWin32ReadRoot(directory, undefined, { afterSizeCheck: () => appendFile(file, 'B') })
      await expect(growing.readText(['value.txt'], 1)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    } finally {
      await growing?.close()
      await scope.close()
      expect(relative(resolve(tmpdir()), resolve(directory))).toMatch(/^dsh-native-root-[^\\/]+$/u)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('closes an opened object when caller cancellation arrives before fd transfer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-native-root-'))
    await writeFile(join(directory, 'value.txt'), 'INSIDE')
    const cancellation = new AbortController()
    const scope = await openWin32ReadRoot(directory, undefined, {
      afterTargetOpen: () => {
        cancellation.abort()
        return Promise.resolve()
      },
    })
    try {
      await expect(scope.readText(['value.txt'], 6, cancellation.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    } finally {
      await scope.close()
      expect(relative(resolve(tmpdir()), resolve(directory))).toMatch(/^dsh-native-root-[^\\/]+$/u)
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('reads and enumerates the pinned root after its pathname is replaced', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-native-root-'))
    const root = join(directory, 'root')
    await mkdir(root)
    await writeFile(join(root, 'value.txt'), 'ORIGINAL')
    const scope = await openWin32ReadRoot(root)
    try {
      await rename(root, join(directory, 'pinned'))
      await mkdir(root)
      await writeFile(join(root, 'value.txt'), 'OUTSIDE')
      expect(await scope.readText(['value.txt'], 8)).toBe('ORIGINAL')
      expect(await scope.stat(['value.txt'])).toEqual({ type: 'file', size: 8 })
      expect(await scope.listDir([])).toEqual([{ name: 'value.txt', type: 'file' }])
      expect(await scope.listDir([])).toEqual([{ name: 'value.txt', type: 'file' }])
      await expect(scope.readText(['value.txt'], 7)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
      expect(await scope.stat(['absent'])).toBeUndefined()
    } finally {
      await scope.close()
      expect(relative(resolve(tmpdir()), resolve(directory))).toMatch(/^dsh-native-root-[^\\/]+$/u)
      await rm(directory, { recursive: true, force: true })
    }
    await expect(scope.readText(['value.txt'], 8)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await scope.close()
  })

  it('refuses outside junctions and invalid logical components', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-native-root-'))
    const root = join(directory, 'root')
    const outside = join(directory, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'OUTSIDE_SENTINEL')
    await symlink(outside, join(root, 'alias'), 'junction')
    const scope = await openWin32ReadRoot(root)
    try {
      await expect(scope.readText(['alias', 'secret.txt'], 100)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      for (const segment of ['', '.', '..', 'C:', 'value:stream', 'a/b', 'a\\b', '\0']) {
        await expect(scope.stat([segment])).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      }
    } finally {
      await scope.close()
      expect(relative(resolve(tmpdir()), resolve(directory))).toMatch(/^dsh-native-root-[^\\/]+$/u)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('joins active reads on close and rejects non-text and oversized content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-native-root-'))
    await writeFile(join(directory, 'large.txt'), Buffer.alloc(1024 * 1024, 65))
    await writeFile(join(directory, 'binary'), Buffer.from([0]))
    await writeFile(join(directory, 'invalid'), Buffer.from([0xff]))
    const scope = await openWin32ReadRoot(directory)
    try {
      await expect(scope.readText(['binary'], 1)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
      await expect(scope.readText(['invalid'], 1)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
      await expect(scope.readText([], 1)).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
      await expect(scope.readText(['large.txt'], -1)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
      const pending = scope.readText(['large.txt'], 1024 * 1024)
      const rejected = expect(pending).rejects.toMatchObject({ code: 'FS_ABORTED' })
      await setImmediate()
      await scope.close()
      await rejected
      await rename(join(directory, 'large.txt'), join(directory, 'closed.txt'))
    } finally {
      await scope.close()
      expect(relative(resolve(tmpdir()), resolve(directory))).toMatch(/^dsh-native-root-[^\\/]+$/u)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('enumerates more than one native page without dropping or repeating names', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-native-root-'))
    const names = Array.from({ length: 600 }, (_, index) => `${String(index).padStart(4, '0')}-${'x'.repeat(40)}.txt`)
    let scope: Awaited<ReturnType<typeof openWin32ReadRoot>> | undefined
    try {
      for (let offset = 0; offset < names.length; offset += 20) {
        await Promise.all(names.slice(offset, offset + 20).map(name => writeFile(join(directory, name), '')))
      }
      scope = await openWin32ReadRoot(directory)
      expect((await scope.listDir([])).map(entry => entry.name)).toEqual(names)
      expect((await scope.listDir([])).map(entry => entry.name)).toEqual(names)
    } finally {
      await scope?.close()
      expect(relative(resolve(tmpdir()), resolve(directory))).toMatch(/^dsh-native-root-[^\\/]+$/u)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
