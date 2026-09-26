/** Platform selection and typed failures for the optional local root reader. */
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsReadRoot, FsRootReadable } from '@deepseek-ai/dsh-fs'
import { openLinuxReadRoot } from './root-read-linux.ts'
import { openWin32ReadRoot } from './root-read-win32.ts'

async function normalized<Result>(operation: Promise<Result>): Promise<Result> {
  try {
    return await operation
  } catch (error) {
    if (error instanceof FsError) throw error
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    const mapped = error instanceof Error && error.name === 'AbortError' ? 'FS_ABORTED'
      : code === 'ENOENT' ? 'FS_NOT_FOUND'
        : code === 'ENOTDIR' ? 'FS_NOT_DIRECTORY'
          : code === 'EACCES' || code === 'EPERM' ? 'FS_PERMISSION_DENIED'
            : code === 'ELOOP' ? 'FS_SANDBOX_DENIED' : 'FS_IO_ERROR'
    throw new FsError('Local root read failed', mapped, { cause: error })
  }
}

/** Optional native reader; absent where no handle-relative implementation exists. */
export const localRootReader: FsRootReadable['openReadRoot'] | undefined =
  process.platform === 'win32' || process.platform === 'linux'
    ? async (root, signal, options) => {
      const open = process.platform === 'win32' ? openWin32ReadRoot : openLinuxReadRoot
      const scope = await normalized(open(String(root.targetKey), signal, {}, options))
      let closing: Promise<void> | undefined
      const result: FsReadRoot = {
        aliasPolicy: scope.aliasPolicy,
        stat: (segments, caller) => normalized(scope.stat(segments, caller)),
        readText: (segments, maxBytes, caller) => normalized(scope.readText(segments, maxBytes, caller)),
        listDir: (segments, caller) => normalized(scope.listDir(segments, caller)),
        close: () => closing ??= normalized(scope.close()),
      }
      return result
    }
    : undefined
