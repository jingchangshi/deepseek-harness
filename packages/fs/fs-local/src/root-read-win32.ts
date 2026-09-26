/** HANDLE-relative Windows reads; callers supply canonical root-relative components. */
import { close, read } from 'node:fs'
import { constants as bufferConstants } from 'node:buffer'
import { join, toNamespacedPath } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { promisify } from 'node:util'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsReadRoot, FsReadRootInfo, FsReadRootEntry, FsReadRootOpenOptions } from '@deepseek-ai/dsh-fs'
import { resolveLocalTarget } from './fsio.ts'

const readDescriptor = promisify(read)
const closeDescriptor = promisify(close)
const maxTextBytes = Math.min(bufferConstants.MAX_LENGTH, bufferConstants.MAX_STRING_LENGTH)

/** Instance-local barriers for native namespace and ownership regression tests. */
export interface Win32ReadRootInternals {
  /** Runs after canonical lookup and root identity validation. */
  afterCanonicalResolve?: () => Promise<void>
  /** Runs after an intermediate directory has been pinned. */
  afterComponentOpen?: (index: number) => Promise<void>
  /** Runs while the operation owns the final HANDLE, before inspecting or reading it. */
  afterTargetOpen?: () => Promise<void>
  /** Runs after same-handle size validation, before descriptor ownership transfer. */
  afterSizeCheck?: () => Promise<void>
  /** Runs after fd ownership transfer, inside the descriptor cleanup scope. */
  afterHandleTransfer?: (descriptor: number) => Promise<void>
}

/**
 * Compare complete FILE_ID_INFO records without truncating volume or file identifiers.
 * @param left - native 64-bit volume serial followed by the 128-bit file identifier.
 * @param right - another native FILE_ID_INFO record.
 * @returns whether both complete records identify the same object.
 */
export function sameWin32RootIdentity(left: Buffer, right: Buffer): boolean {
  return left.length === 24 && right.length === 24 && left.equals(right)
}

async function loadApi() {
  const koffi = (await import('koffi')).default
  const kernel = koffi.load('kernel32.dll')
  const ntdll = koffi.load('ntdll.dll')
  const runtime = koffi.load(process.execPath)
  const unicode = koffi.struct({ Length: 'uint16', MaximumLength: 'uint16', Buffer: 'void*' })
  const attributes = koffi.struct({
    Length: 'uint32', RootDirectory: 'intptr', ObjectName: koffi.pointer(unicode),
    Attributes: 'uint32', SecurityDescriptor: 'void*', SecurityQualityOfService: 'void*',
  })
  const status = koffi.struct({ Status: 'intptr', Information: 'uintptr' })
  return {
    create: kernel.func('intptr __stdcall CreateFileW(const char16_t *path, uint32 access, uint32 share, void *security, uint32 disposition, uint32 flags, intptr template)'),
    close: kernel.func('int __stdcall CloseHandle(intptr handle)'),
    info: kernel.func('int __stdcall GetFileInformationByHandle(intptr handle, void *info)'),
    list: kernel.func('int __stdcall GetFileInformationByHandleEx(intptr handle, int infoClass, void *info, uint32 size)'),
    finalPath: kernel.func('uint32 __stdcall GetFinalPathNameByHandleW(intptr handle, void *buffer, uint32 length, uint32 flags)'),
    lastError: kernel.func('uint32 __stdcall GetLastError()'),
    transfer: runtime.func('int uv_open_osfhandle(intptr handle)'),
    open: ntdll.func('__stdcall', 'NtCreateFile', 'int32', [
      koffi.out(koffi.pointer('intptr')), 'uint32', koffi.pointer(attributes), koffi.out(koffi.pointer(status)),
      'void*', 'uint32', 'uint32', 'uint32', 'uint32', 'void*', 'uint32',
    ]),
    attributesSize: koffi.sizeof(attributes),
  }
}

let apiPromise: ReturnType<typeof loadApi> | undefined

function denied(): never {
  throw new FsError('Root read rejected a namespace escape', 'FS_SANDBOX_DENIED')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new FsError('Root read aborted', 'FS_ABORTED', { cause: signal.reason })
}

function nativeError(code: number): FsError {
  if (code === 2 || code === 3 || code === 0xc0000034 || code === 0xc000003a) {
    return new FsError('Root-relative object is absent', 'FS_NOT_FOUND')
  }
  if (code === 5 || code === 0xc0000022) return new FsError('Root read access denied', 'FS_PERMISSION_DENIED')
  if (code === 0xc0000103) return new FsError('Root read requires a directory', 'FS_NOT_DIRECTORY')
  return new FsError(`Root read native operation failed (${code})`, 'FS_IO_ERROR')
}

function validate(segments: readonly string[]): void {
  for (const segment of segments) {
    if (!segment || segment.length > 32766 || segment === '.' || segment === '..' || /[\\/:\0]/u.test(segment)) denied()
  }
}

/**
 * Open the exact canonical directory and retain its native owner until close.
 * @param root - canonical absolute Windows directory path.
 * @param signal - cancellation before the scope is published.
 * @param internals - instance-local native-operation test barriers.
 * @param options - immutable descendant alias policy.
 * @returns a scope that refuses reparse points on every opened component.
 */
export async function openWin32ReadRoot(
  root: string, signal?: AbortSignal, internals: Win32ReadRootInternals = {},
  options: FsReadRootOpenOptions = {},
): Promise<FsReadRoot> {
  const aliasPolicy = options.aliasPolicy ?? 'follow-contained'
  const api = await (apiPromise ??= loadApi())
  throwIfAborted(signal)
  const rootHandle = api.create(toNamespacedPath(root), 0x120089, 7, null, 3, 0x02200000, 0) as number
  if (rootHandle === -1) throw nativeError(api.lastError() as number)
  let closing: Promise<void> | undefined
  const cancellation = new AbortController()
  const operations = new Set<Promise<unknown>>()

  function inspect(handle: number) {
    const buffer = Buffer.alloc(52)
    if (!api.info(handle, buffer)) throw new FsError('Cannot inspect opened object', 'FS_IO_ERROR')
    const flags = buffer.readUInt32LE(0)
    if (flags & 0x400) denied()
    return {
      type: flags & 0x10 ? 'directory' as const : 'file' as const,
      size: BigInt(buffer.readUInt32LE(32)) * 0x100000000n + BigInt(buffer.readUInt32LE(36)),
    }
  }

  function info(handle: number): FsReadRootInfo {
    const metadata = inspect(handle)
    return { type: metadata.type, ...(metadata.size <= BigInt(Number.MAX_SAFE_INTEGER) ? { size: Number(metadata.size) } : {}) }
  }

  function rootLocator(): string {
    const buffer = Buffer.alloc(65536)
    const length = api.finalPath(rootHandle, buffer, buffer.length / 2, 0) as number
    if (!length || length >= buffer.length / 2) throw new FsError('Cannot locate read root', 'FS_IO_ERROR')
    return buffer.subarray(0, length * 2).toString('utf16le')
  }

  function verifyLocator(locator: string): void {
    const candidate = api.create(locator, 0x120089, 7, null, 3, 0x02200000, 0) as number
    if (candidate === -1) denied()
    try {
      if (inspect(candidate).type !== 'directory') denied()
      const identity = Buffer.alloc(24)
      const pinnedIdentity = Buffer.alloc(24)
      if (!api.list(candidate, 18, identity, identity.length)
        || !api.list(rootHandle, 18, pinnedIdentity, pinnedIdentity.length)) {
        throw new FsError('Full native root identity is unavailable', 'FS_IO_ERROR')
      }
      if (!sameWin32RootIdentity(identity, pinnedIdentity)) denied()
    } finally {
      api.close(candidate)
    }
  }

  async function canonicalize(segments: readonly string[]): Promise<readonly string[]> {
    validate(segments)
    const locator = rootLocator()
    verifyLocator(locator)
    const resolved = await resolveLocalTarget(locator, segments.length ? join(...segments) : '.')
    const canonical = toNamespacedPath(String(resolved.targetKey))
    const prefix = locator.endsWith('\\') ? locator : `${locator}\\`
    if (canonical !== locator && !canonical.startsWith(prefix)) denied()
    verifyLocator(locator)
    await internals.afterCanonicalResolve?.()
    return canonical === locator ? [] : canonical.slice(prefix.length).split('\\')
  }

  async function open(segments: readonly string[], operationSignal: AbortSignal): Promise<number> {
    validate(segments)
    let parent = rootHandle
    try {
      for (const [index, segment] of (segments.length ? segments : ['']).entries()) {
        throwIfAborted(operationSignal)
        const name = Buffer.from(`${segment}\0`, 'utf16le')
        const result: [number] = [0]
        const code = api.open(result, 0x120089, {
          Length: api.attributesSize, RootDirectory: parent,
          ObjectName: { Length: name.length - 2, MaximumLength: name.length, Buffer: name },
          Attributes: 0, SecurityDescriptor: null, SecurityQualityOfService: null,
        }, { Status: 0, Information: 0 }, null, 0, 7, 1, 0x00200020, null, 0) as number
        if (code < 0) {
          throw nativeError(code >>> 0)
        }
        if (parent !== rootHandle) api.close(parent)
        parent = result[0]
        if (info(parent).type !== 'directory' && index < segments.length - 1) {
          throw new FsError('Intermediate object is not a directory', 'FS_NOT_DIRECTORY')
        }
        if (index < segments.length - 1) await internals.afterComponentOpen?.(index)
      }
      return parent
    } catch (error) {
      if (parent !== rootHandle) api.close(parent)
      throw error
    }
  }

  function run<Result>(
    segments: readonly string[], caller: AbortSignal | undefined,
    work: (handle: number, signal: AbortSignal, transfer: () => number) => Promise<Result>,
  ): Promise<Result> {
    const combined = caller ? AbortSignal.any([caller, cancellation.signal]) : cancellation.signal
    const operation = Promise.resolve().then(async () => {
      throwIfAborted(combined)
      const canonical = aliasPolicy === 'deny' ? segments : await canonicalize(segments)
      throwIfAborted(combined)
      const handle = await open(canonical, combined)
      const owner = { native: true }
      try {
        await internals.afterTargetOpen?.()
        throwIfAborted(combined)
        return await work(handle, combined, () => {
          const descriptor = api.transfer(handle) as number
          if (descriptor < 0) throw new FsError('Cannot transfer read handle', 'FS_IO_ERROR')
          owner.native = false
          return descriptor
        })
      } finally {
        if (owner.native) api.close(handle)
      }
    })
    operations.add(operation)
    void operation.then(() => operations.delete(operation), () => operations.delete(operation))
    return operation
  }

  try {
    if (info(rootHandle).type !== 'directory') throw new FsError('Read root is not a directory', 'FS_NOT_DIRECTORY')
    verifyLocator(toNamespacedPath(root))
    throwIfAborted(signal)
  } catch (error) {
    api.close(rootHandle)
    throw error
  }

  return {
    aliasPolicy,
    async stat(segments, caller) {
      try {
        return await run(segments, caller, handle => Promise.resolve(info(handle)))
      } catch (error) {
        if (error instanceof FsError && error.code === 'FS_NOT_FOUND') return undefined
        throw error
      }
    },
    readText(segments, maxBytes, caller) {
      return run(segments, caller, async (handle, operationSignal, transfer) => {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > maxTextBytes) {
          throw new FsError('Invalid read byte limit', 'FS_TOO_LARGE')
        }
        const metadata = inspect(handle)
        if (metadata.type !== 'file') throw new FsError('Read requires a regular file', 'FS_NOT_REGULAR_FILE')
        if (metadata.size > BigInt(maxBytes)) throw new FsError('Read exceeds byte limit', 'FS_TOO_LARGE')
        await internals.afterSizeCheck?.()
        throwIfAborted(operationSignal)
        const descriptor = transfer()
        const chunks: Buffer[] = []
        let total = 0
        try {
          await internals.afterHandleTransfer?.(descriptor)
          for (;;) {
            throwIfAborted(operationSignal)
            const buffer = Buffer.alloc(Math.min(65536, maxBytes - total + 1))
            const { bytesRead: count } = await readDescriptor(descriptor, buffer, 0, buffer.length, null)
            throwIfAborted(operationSignal)
            if (!count) break
            total += count
            if (total > maxBytes) throw new FsError('Read exceeds byte limit', 'FS_TOO_LARGE')
            chunks.push(buffer.subarray(0, count))
          }
        } finally {
          await closeDescriptor(descriptor)
        }
        const bytes = Buffer.concat(chunks)
        if (bytes.includes(0)) throw new FsError('File contains binary data', 'FS_NOT_TEXT')
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch (error) {
          throw new FsError('File is not UTF-8 text', 'FS_NOT_TEXT', { cause: error })
        }
      })
    },
    listDir(segments, caller) {
      return run(segments, caller, async (handle, operationSignal) => {
        if (info(handle).type !== 'directory') throw new FsError('List requires a directory', 'FS_NOT_DIRECTORY')
        const entries: FsReadRootEntry[] = []
        const buffer = Buffer.alloc(65536)
        for (;;) {
          throwIfAborted(operationSignal)
          if (!api.list(handle, 10, buffer, buffer.length)) {
            if (api.lastError() === 18) break
            throw new FsError('Cannot enumerate opened directory', 'FS_IO_ERROR')
          }
          let offset = 0
          for (;;) {
            const next = buffer.readUInt32LE(offset)
            const flags = buffer.readUInt32LE(offset + 56)
            const length = buffer.readUInt32LE(offset + 60)
            const name = buffer.subarray(offset + 104, offset + 104 + length).toString('utf16le')
            if (name !== '.' && name !== '..') entries.push({ name, type: flags & 0x400 ? 'other' : flags & 0x10 ? 'directory' : 'file' })
            if (!next) break
            offset += next
          }
          await setImmediate()
        }
        return entries.sort((left, right) => left.name.localeCompare(right.name))
      })
    },
    close() {
      closing ??= (async () => {
        cancellation.abort(new FsError('Read root closed', 'FS_ABORTED'))
        await Promise.allSettled([...operations])
        if (!api.close(rootHandle)) throw new FsError('Cannot close read root', 'FS_IO_ERROR')
      })()
      return closing
    },
  }
}
