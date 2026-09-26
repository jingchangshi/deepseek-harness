/** Same-host allocation exclusion; the kernel releases ownership when a process dies. */
import { mkdir, open, stat } from 'node:fs/promises'
import { dirname, toNamespacedPath } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'

type Release = () => void | Promise<void>

async function loadWindows() {
  const koffi = (await import('koffi')).default
  const kernel = koffi.load('kernel32.dll')
  return {
    create: kernel.func('__stdcall', 'CreateFileW', 'intptr', ['str16', 'uint', 'uint', 'void*', 'uint', 'uint', 'intptr']) as (path: string, access: number, share: number, security: null, disposition: number, flags: number, template: number) => number,
    lock: kernel.func('__stdcall', 'LockFileEx', 'int', ['intptr', 'uint', 'uint', 'uint', 'uint', 'void*']) as (handle: number, flags: number, reserved: number, low: number, high: number, overlapped: Buffer) => number,
    unlock: kernel.func('__stdcall', 'UnlockFileEx', 'int', ['intptr', 'uint', 'uint', 'uint', 'void*']) as (handle: number, reserved: number, low: number, high: number, overlapped: Buffer) => number,
    close: kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr']) as (handle: number) => number,
    error: kernel.func('__stdcall', 'GetLastError', 'uint', []) as () => number,
  }
}

let windows: ReturnType<typeof loadWindows> | undefined

async function attemptWindows(path: string): Promise<Release | undefined> {
  const api = await (windows ??= loadWindows())
  const handle = api.create(toNamespacedPath(path), 0xc0000000, 3, null, 4, 0, 0)
  if (handle === -1 || handle === 0) throw new Error(`identity allocation lock file open failed: ${api.error()}`)
  const overlapped = Buffer.alloc(process.arch === 'ia32' ? 20 : 32)
  if (api.lock(handle, 3, 0, 1, 0, overlapped) === 0) {
    const code = api.error()
    if (api.close(handle) === 0) throw new Error(`identity allocation handle close failed: ${api.error()}`)
    if (code === 33) return undefined
    throw new Error(`identity allocation file lock failed: ${code}`)
  }
  return () => {
    const released = api.unlock(handle, 0, 1, 0, overlapped)
    const code = released === 0 ? api.error() : undefined
    const closed = api.close(handle)
    if (released === 0 || closed === 0) throw new Error(`identity allocation file lock release failed: ${code ?? api.error()}`)
  }
}

async function attemptPosix(path: string): Promise<Release | undefined> {
  const handle = await open(path, 'a', 0o600)
  let retained = false
  try {
    try {
      await tryLockExclusive(handle.fd)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return undefined
      throw error
    }
    const held = await handle.stat({ bigint: true })
    const current = await stat(path, { bigint: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
      throw error
    })
    if (current === undefined || held.dev !== current.dev || held.ino !== current.ino) return undefined
    retained = true
    return () => handle.close()
  } finally {
    if (!retained) await handle.close()
  }
}

/**
 * Serialize one fresh-open/read/write/close transaction without retaining contender handles.
 * All processes sharing identity storage must use the same absolute coordination path.
 * @param path - Host coordination path, never an execution-world workspace root.
 * @param waitMs - maximum contention wait; no live owner is forcibly displaced.
 * @param signal - cancellation before acquisition and before the operation starts.
 * @param operation - transaction that closes its storage handle before returning.
 * @returns the transaction result after releasing kernel ownership.
 */
export async function withAllocationLock<Result>(
  path: string,
  waitMs: number,
  signal: AbortSignal,
  operation: () => Promise<Result>,
): Promise<Result> {
  signal.throwIfAborted()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const deadline = performance.now() + waitMs
  let delay = 1
  for (;;) {
    signal.throwIfAborted()
    const release = await (process.platform === 'win32' ? attemptWindows(path) : attemptPosix(path))
    if (release !== undefined) {
      try {
        signal.throwIfAborted()
        return await operation()
      } finally { await release() }
    }
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error('identity allocation lock wait timed out')
    await setTimeout(Math.min(delay, remaining), undefined, { signal })
    delay = Math.min(delay * 2, 50)
  }
}
