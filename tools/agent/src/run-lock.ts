/** Read-only validation of a contended engineering writer lock. */

import { lstat, readFile } from 'node:fs/promises'

/**
 * Confirm that a timeout names a private regular lock with a live PID record.
 * @param error - the rejected lock operation.
 * @param filename - the lock target, without its `.lock` suffix.
 * @returns Whether the exact timed-out lock has a validated live owner.
 */
export async function isLiveWriterLockTimeout(error: unknown, filename: string): Promise<boolean> {
  const lockPath = `${filename}.lock`
  if (!(error instanceof Error)
    || error.message !== `atomic-write: timed out waiting for the writer lock at ${lockPath}`) return false
  try {
    const before = await lstat(lockPath)
    if (!before.isFile() || before.nlink !== 1) return false
    if (process.platform !== 'win32' && process.geteuid !== undefined
      && (before.uid !== process.geteuid() || (before.mode & 0o077) !== 0)) return false
    const record = await readFile(lockPath, 'utf8')
    const after = await lstat(lockPath)
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) return false
    if (!/^[1-9]\d*\n$/.test(record)) return false
    const pid = Number(record.slice(0, -1))
    if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (probeError: unknown) {
      // EPERM proves the process exists but cannot be signalled by this user.
      return (probeError as NodeJS.ErrnoException).code === 'EPERM'
    }
  } catch (inspectionError: unknown) {
    // Unreadable or replaced lock state cannot establish a live owner.
    void inspectionError
    return false
  }
}
