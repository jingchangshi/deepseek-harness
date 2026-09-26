/** Native HANDLE-to-fd ownership prerequisite; this does not test root confinement. */
import { close as closeDescriptor, closeSync, read, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, toNamespacedPath } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

describe.skipIf(process.platform !== 'win32')('Windows root-read HANDLE ABI', () => {
  it('opens a child relative to the pinned root after the root pathname is replaced', async () => {
    const koffi = (await import('koffi')).default
    const kernel = koffi.load('kernel32.dll')
    const ntdll = koffi.load('ntdll.dll')
    const runtime = koffi.load(process.execPath)
    const unicode = koffi.struct('DshRootReadAbiUnicode', { Length: 'uint16', MaximumLength: 'uint16', Buffer: 'void*' })
    const attributes = koffi.struct('DshRootReadAbiAttributes', {
      Length: 'uint32', RootDirectory: 'intptr', ObjectName: koffi.pointer(unicode),
      Attributes: 'uint32', SecurityDescriptor: 'void*', SecurityQualityOfService: 'void*',
    })
    const status = koffi.struct('DshRootReadAbiStatus', { Status: 'intptr', Information: 'uintptr' })
    const create = kernel.func('intptr __stdcall CreateFileW(const char16_t *path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, intptr template)') as (path: string, access: number, share: number, security: null, disposition: number, flags: number, template: number) => number
    const close = kernel.func('int __stdcall CloseHandle(intptr handle)') as (handle: number) => number
    const transfer = runtime.func('int uv_open_osfhandle(intptr handle)') as (handle: number) => number
    const openRelative = ntdll.func('__stdcall', 'NtCreateFile', 'int32', [
      koffi.out(koffi.pointer('intptr')), 'uint32', koffi.pointer(attributes), koffi.out(koffi.pointer(status)),
      'void*', 'uint32', 'uint32', 'uint32', 'uint32', 'void*', 'uint32',
    ])
    const temporaryRoot = resolve(tmpdir())
    const directory = await mkdtemp(join(temporaryRoot, 'dsh-root-relative-abi-'))
    let rootHandle: number | undefined
    let fileHandle: number | undefined
    let descriptor: number | undefined
    try {
      const rootPath = join(directory, 'root')
      await mkdir(rootPath)
      await writeFile(join(rootPath, 'value.txt'), 'ORIGINAL_ROOT')
      const opened = create(toNamespacedPath(rootPath), 0x120089, 7, null, 3, 0x02200000, 0)
      expect(opened).not.toBe(-1)
      rootHandle = opened
      await rename(rootPath, join(directory, 'moved-root'))
      await mkdir(rootPath)
      await writeFile(join(rootPath, 'value.txt'), 'REPLACEMENT_ROOT')
      const name = Buffer.from('value.txt\0', 'utf16le')
      const result = [0]
      const code = openRelative(result, 0x120089, {
        Length: koffi.sizeof(attributes), RootDirectory: rootHandle,
        ObjectName: { Length: name.length - 2, MaximumLength: name.length, Buffer: name },
        Attributes: 0, SecurityDescriptor: null, SecurityQualityOfService: null,
      }, { Status: 0, Information: 0 }, null, 0, 7, 1, 0x00200060, null, 0) as number
      expect(code).toBeGreaterThanOrEqual(0)
      fileHandle = result[0]!
      const transferred = transfer(fileHandle)
      expect(transferred).toBeGreaterThanOrEqual(0)
      descriptor = transferred
      fileHandle = undefined
      expect(readFileSync(descriptor, 'utf8')).toBe('ORIGINAL_ROOT')
      expect(await readFile(join(rootPath, 'value.txt'), 'utf8')).toBe('REPLACEMENT_ROOT')
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      if (fileHandle !== undefined) expect(close(fileHandle)).not.toBe(0)
      if (rootHandle !== undefined) expect(close(rootHandle)).not.toBe(0)
      const allocatedName = relative(temporaryRoot, resolve(directory))
      expect(allocatedName.startsWith('dsh-root-relative-abi-')).toBe(true)
      expect(allocatedName).not.toMatch(/[\\/]/u)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('asynchronously reads the transferred object after replacement and transfers close ownership', async () => {
    const koffi = (await import('koffi')).default
    const kernel = koffi.load('kernel32.dll')
    const runtime = koffi.load(process.execPath)
    const create = kernel.func('intptr __stdcall CreateFileW(const char16_t *path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, intptr template)') as (path: string, access: number, share: number, security: null, disposition: number, flags: number, template: number) => number
    const close = kernel.func('int __stdcall CloseHandle(intptr handle)') as (handle: number) => number
    const finalPath = kernel.func('uint32_t __stdcall GetFinalPathNameByHandleW(intptr handle, void *buffer, uint32_t length, uint32_t flags)') as (handle: number, buffer: Buffer, length: number, flags: number) => number
    const transfer = runtime.func('int uv_open_osfhandle(intptr handle)') as (handle: number) => number
    const temporaryRoot = resolve(tmpdir())
    const directory = await mkdtemp(join(temporaryRoot, 'dsh-root-read-abi-'))
    let handle: number | undefined
    let descriptor: number | undefined
    try {
      const candidate = join(directory, 'value.txt')
      await writeFile(candidate, 'ORIGINAL')
      const opened = create(toNamespacedPath(candidate), 0x80000000, 7, null, 3, 0x80, 0)
      expect(opened).not.toBe(-1)
      handle = opened
      const buffer = Buffer.alloc(65536)
      const length = finalPath(handle, buffer, buffer.length / 2, 0)
      expect(length).toBeGreaterThan(0)
      expect(length).toBeLessThan(buffer.length / 2)
      expect(buffer.subarray(0, length * 2).toString('utf16le')).toBe(toNamespacedPath(candidate))
      const transferred = transfer(handle)
      expect(transferred).toBeGreaterThanOrEqual(0)
      descriptor = transferred
      handle = undefined
      await rename(candidate, join(directory, 'original.txt'))
      await writeFile(candidate, 'REPLACEMENT')
      const bytes = Buffer.alloc(8)
      const { bytesRead } = await promisify(read)(descriptor, bytes, 0, bytes.length, null)
      expect(bytesRead).toBe(8)
      expect(bytes.toString('utf8')).toBe('ORIGINAL')
      expect(await readFile(candidate, 'utf8')).toBe('REPLACEMENT')
      await promisify(closeDescriptor)(descriptor)
      descriptor = undefined
      expect(finalPath(opened, buffer, buffer.length / 2, 0)).toBe(0)
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      if (handle !== undefined) expect(close(handle)).not.toBe(0)
      const allocatedName = relative(temporaryRoot, resolve(directory))
      expect(allocatedName.startsWith('dsh-root-read-abi-')).toBe(true)
      expect(allocatedName).not.toMatch(/[\\/]/u)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
