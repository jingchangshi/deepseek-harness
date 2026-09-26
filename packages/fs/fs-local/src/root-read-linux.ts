/** Linux root-scoped reads using pinned descriptors and no-follow openat traversal. */
import { constants, close, fstat, read } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { constants as bufferConstants } from 'node:buffer'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { promisify } from 'node:util'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsReadRoot, FsReadRootInfo, FsReadRootEntry, FsReadRootOpenOptions } from '@deepseek-ai/dsh-fs'
import { resolveLocalTarget } from './fsio.ts'

const closeDescriptor = promisify(close)
const readDescriptor = promisify(read)
const maxTextBytes = Math.min(bufferConstants.MAX_LENGTH, bufferConstants.MAX_STRING_LENGTH)
const closeOnExec = 0x80000

/** Instance-local barriers for namespace replacement and descriptor cleanup tests. */
export interface LinuxReadRootInternals {
  /** Runs after canonical lookup and root identity validation. */
  afterCanonicalResolve?: () => Promise<void>
  /** Runs after an intermediate directory descriptor has been pinned. */
  afterComponentOpen?: (index: number) => Promise<void>
  /** Runs while the operation owns its final descriptor. */
  afterTargetOpen?: (descriptor: number) => Promise<void>
  /** Runs after same-descriptor size validation, before content I/O. */
  afterSizeCheck?: () => Promise<void>
}

async function loadApi() {
  const koffi = (await import('koffi')).default
  const libc = koffi.load('libc.so.6')
  return {
    openat: libc.func('int openat(int dirfd, const char *path, int flags)'),
    fdopendir: libc.func('void *fdopendir(int fd)'),
    readdir: libc.func('void *readdir64(void *directory)'),
    closedir: libc.func('int closedir(void *directory)'),
    koffi,
  }
}

let apiPromise: ReturnType<typeof loadApi> | undefined

function denied(): never {
  throw new FsError('Root read rejected a namespace escape', 'FS_SANDBOX_DENIED')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FsError('Root read aborted', 'FS_ABORTED', { cause: signal.reason })
}

function nativeError(code: number): FsError {
  if (code === 2) return new FsError('Root-relative object is absent', 'FS_NOT_FOUND')
  if (code === 13 || code === 1) return new FsError('Root read access denied', 'FS_PERMISSION_DENIED')
  if (code === 40) return new FsError('Root read refuses substituted symlink', 'FS_SANDBOX_DENIED')
  if (code === 20) return new FsError('Root read requires a directory', 'FS_NOT_DIRECTORY')
  return new FsError(`Root read native operation failed (${code})`, 'FS_IO_ERROR')
}

function inspect(descriptor: number): Promise<BigIntStats> {
  return new Promise((fulfill, reject) => {
    fstat(descriptor, { bigint: true }, (error, metadata) => {
      if (error) reject(error)
      else fulfill(metadata)
    })
  })
}

function information(metadata: BigIntStats): FsReadRootInfo {
  return {
    type: metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'other',
    ...(metadata.size <= BigInt(Number.MAX_SAFE_INTEGER) ? { size: Number(metadata.size) } : {}),
  }
}

/**
 * Pin a Linux directory for canonical-alias reads using no-follow descriptor-relative opens.
 * @param root - canonical absolute directory locator; replacement invalidates canonical lookup.
 * @param signal - opening cancellation; unpublished descriptors are closed.
 * @param internals - instance-local native-operation test barriers.
 * @param options - immutable descendant alias policy.
 * @returns a caller-owned root scope; unsupported native primitives fail closed.
 */
export async function openLinuxReadRoot(
  root: string, signal?: AbortSignal, internals: LinuxReadRootInternals = {},
  options: FsReadRootOpenOptions = {},
): Promise<FsReadRoot> {
  const aliasPolicy = options.aliasPolicy ?? 'follow-contained'
  throwIfAborted(signal)
  const api = await (apiPromise ??= loadApi())
  throwIfAborted(signal)
  const locator = resolve(root)
  const expected = await stat(locator, { bigint: true })
  const rootFile = await open(locator, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const pending = new Set<Promise<unknown>>()
  const cancellation = new AbortController()
  let closing: Promise<void> | undefined
  let identity: BigIntStats
  try {
    identity = await rootFile.stat({ bigint: true })
    if (!identity.isDirectory() || expected.dev !== identity.dev || expected.ino !== identity.ino) denied()
    throwIfAborted(signal)
  } catch (error) {
    await rootFile.close()
    throw error
  }

  async function verifyLocator(): Promise<void> {
    const observed = await stat(locator, { bigint: true })
    if (observed.dev !== identity.dev || observed.ino !== identity.ino) denied()
  }

  async function canonicalize(segments: readonly string[]): Promise<string[]> {
    for (const segment of segments) {
      if (!segment || segment === '.' || segment === '..' || /[\\/\0]/u.test(segment)) denied()
    }
    if (aliasPolicy === 'deny') return [...segments]
    await verifyLocator()
    const target = await resolveLocalTarget(locator, segments.length ? join(...segments) : '.')
    const path = relative(locator, String(target.targetKey))
    if (isAbsolute(path) || path === '..' || path.startsWith('../')) denied()
    await verifyLocator()
    await internals.afterCanonicalResolve?.()
    return path ? path.split('/') : []
  }

  async function openTarget(segments: readonly string[], operationSignal: AbortSignal): Promise<number> {
    let parent = rootFile.fd
    try {
      for (const [index, segment] of (segments.length ? segments : ['.']).entries()) {
        throwIfAborted(operationSignal)
        const intermediate = index < segments.length - 1
        const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec
          | (intermediate ? constants.O_DIRECTORY : 0)
        const descriptor = api.openat(parent, segment, flags) as number
        if (descriptor < 0) throw nativeError(api.koffi.errno())
        const previous = parent
        parent = descriptor
        if (previous !== rootFile.fd) await closeDescriptor(previous)
        if (intermediate) await internals.afterComponentOpen?.(index)
      }
      return parent
    } catch (error) {
      if (parent !== rootFile.fd) await closeDescriptor(parent)
      throw error
    }
  }

  function run<Result>(
    segments: readonly string[], caller: AbortSignal | undefined,
    work: (descriptor: number, signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    const combined = caller ? AbortSignal.any([caller, cancellation.signal]) : cancellation.signal
    const operation = Promise.resolve().then(async () => {
      throwIfAborted(combined)
      const canonical = await canonicalize(segments)
      throwIfAborted(combined)
      const descriptor = await openTarget(canonical, combined)
      try {
        await internals.afterTargetOpen?.(descriptor)
        throwIfAborted(combined)
        return await work(descriptor, combined)
      } finally {
        await closeDescriptor(descriptor)
      }
    })
    pending.add(operation)
    void operation.then(() => pending.delete(operation), () => pending.delete(operation))
    return operation
  }

  return {
    aliasPolicy,
    async stat(segments, caller) {
      try {
        return await run(segments, caller, async descriptor => information(await inspect(descriptor)))
      } catch (error) {
        if (error instanceof FsError && error.code === 'FS_NOT_FOUND') return undefined
        throw error
      }
    },
    readText(segments, maxBytes, caller) {
      return run(segments, caller, async (descriptor, operationSignal) => {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > maxTextBytes) {
          throw new FsError('Invalid read byte limit', 'FS_TOO_LARGE')
        }
        const metadata = await inspect(descriptor)
        if (!metadata.isFile()) throw new FsError('Read requires a regular file', 'FS_NOT_REGULAR_FILE')
        if (metadata.size > BigInt(maxBytes)) throw new FsError('Read exceeds byte limit', 'FS_TOO_LARGE')
        await internals.afterSizeCheck?.()
        const chunks: Buffer[] = []
        let total = 0
        for (;;) {
          throwIfAborted(operationSignal)
          const buffer = Buffer.alloc(Math.min(65536, maxBytes - total + 1))
          const { bytesRead } = await readDescriptor(descriptor, buffer, 0, buffer.length, null)
          throwIfAborted(operationSignal)
          if (!bytesRead) break
          total += bytesRead
          if (total > maxBytes) throw new FsError('Read exceeds byte limit', 'FS_TOO_LARGE')
          chunks.push(buffer.subarray(0, bytesRead))
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
      return run(segments, caller, async (descriptor, operationSignal) => {
        if (!(await inspect(descriptor)).isDirectory()) throw new FsError('List requires a directory', 'FS_NOT_DIRECTORY')
        const duplicate = api.openat(descriptor, '.', constants.O_RDONLY | constants.O_DIRECTORY | closeOnExec) as number
        if (duplicate < 0) throw nativeError(api.koffi.errno())
        const directory: unknown = api.fdopendir(duplicate)
        if (!directory) {
          const error = nativeError(api.koffi.errno())
          await closeDescriptor(duplicate)
          throw error
        }
        try {
          const entries: FsReadRootEntry[] = []
          for (;;) {
            throwIfAborted(operationSignal)
            api.koffi.errno(0)
            const entry: unknown = api.readdir(directory)
            if (!entry) {
              const error = api.koffi.errno()
              if (error) throw nativeError(error)
              break
            }
            const length = api.koffi.decode(entry, 16, 'uint16') as number
            const type = api.koffi.decode(entry, 18, 'uint8') as number
            if (length <= 19) throw new FsError('Invalid native directory entry', 'FS_IO_ERROR')
            const name = (api.koffi.decode(entry, 19, 'char', length - 19) as string).split('\0')[0]
            if (name && name !== '.' && name !== '..') {
              entries.push({ name, type: type === 4 ? 'directory' : type === 8 ? 'file' : 'other' })
            }
            await setImmediate()
          }
          return entries.sort((left, right) => left.name.localeCompare(right.name))
        } finally {
          if (api.closedir(directory) !== 0) throw nativeError(api.koffi.errno())
        }
      })
    },
    close() {
      closing ??= (async () => {
        cancellation.abort(new FsError('Read root closed', 'FS_ABORTED'))
        await Promise.allSettled([...pending])
        await rootFile.close()
      })()
      return closing
    },
  }
}
