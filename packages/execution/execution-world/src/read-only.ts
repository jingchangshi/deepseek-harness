/** Lifecycle-bound root reads and file-effect-confined processes over explicitly paired providers. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import { supportsRootRead } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsReadRoot, FsTarget, FsReadRootAliasPolicy } from '@deepseek-ai/dsh-fs'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type ExecutionWorldIdentity from './index.ts'
import type { ReadOnlyExecutionFs, ReadOnlyExecutionWorld } from './read-only-types.ts'

const requiredServices = ['executionWorldIdentity', 'fs', 'subprocess', 'sandbox'] as const

function segments(path: string): string[] {
  if (path === '') return []
  const parts = path.split('/')
  if (path.includes('\0') || path.includes('\\')
    || parts.some(part => part === '' || part === '.' || part === '..' || /^[a-z]:/iu.test(part))) {
    throw new Error('execution path must be root-relative without empty, dot, drive or backslash segments')
  }
  return parts
}

/**
 * Capture explicitly injected identity, filesystem, subprocess and sandbox provider generations.
 * Matching live affinity and identity's exact filesystem dependency are required before root I/O.
 * File reads require provider-held root handles; unsupported providers reject binding.
 * Subprocess confinement restricts file effects, not reads or networking.
 * @param ctx - owning plugin context with all four required service injections.
 * @param root - directory interpreted only by the injected filesystem provider.
 * @param signal - optional cancellation for setup and the binding lifetime.
 * @param aliasPolicy - immutable root-scope policy acknowledged before publication.
 * @returns ephemeral capabilities disposed with the caller's plugin generation.
 */
export async function bindReadOnlyExecutionWorld(ctx: Context, root: string, signal?: AbortSignal, aliasPolicy: FsReadRootAliasPolicy = 'follow-contained'): Promise<ReadOnlyExecutionWorld> {
  signal?.throwIfAborted()
  const store = ctx.fiber.store
  for (const name of requiredServices) {
    if (!Object.hasOwn(ctx.fiber.inject, name) || store?.[name] === undefined) {
      throw new Error(`read-only execution binding requires explicit injection: ${name}`)
    }
  }
  const identityImpl = store?.executionWorldIdentity
  const fsImpl = store?.fs
  const subprocessImpl = store?.subprocess
  const sandboxImpl = store?.sandbox
  if (!identityImpl || !fsImpl || !subprocessImpl || !sandboxImpl) throw new Error('execution providers unavailable')
  if (identityImpl.fiber.store?.fs !== fsImpl) throw new Error('execution identity belongs to a different filesystem generation')
  const identity = identityImpl.value as ExecutionWorldIdentity
  const filesystem = fsImpl.value as FileSystem
  const subprocess = subprocessImpl.value as SubprocessRuntime
  const sandbox = sandboxImpl.value as SandboxProvider
  if (filesystem.executionWorldAffinity !== subprocess.executionWorldAffinity
    || filesystem.executionWorldAffinity !== sandbox.executionWorldAffinity) {
    throw new Error('execution providers belong to different execution worlds')
  }
  if (!supportsRootRead(filesystem)) throw new Error('execution filesystem has no secure root reader')
  const owners = new Set([identityImpl.fiber, fsImpl.fiber, subprocessImpl.fiber, sandboxImpl.fiber])
  const lifetime = new AbortController()
  const bindingSignal = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
  const operations = new Set<Promise<unknown>>()
  const processes = new Set<SubprocessHandle>()
  let rootScope: FsReadRoot | undefined
  function track<Value>(operation: Promise<Value>): Promise<Value> {
    operations.add(operation)
    void operation.then(() => operations.delete(operation), () => operations.delete(operation))
    return operation
  }
  function active(caller?: AbortSignal): AbortSignal {
    const combined = caller === undefined ? bindingSignal : AbortSignal.any([caller, bindingSignal])
    combined.throwIfAborted()
    for (const owner of owners) {
      if (owner.state !== FiberState.ACTIVE) throw new Error('execution provider generation is no longer active')
    }
    return combined
  }
  let cleanupTask: Promise<void> | undefined
  const disposeEffect = ctx.effect(() => () => cleanupTask ??= cleanup())
  async function cleanup(): Promise<void> {
    signal?.removeEventListener('abort', disposeOnAbort)
    lifetime.abort(new Error('read-only execution binding disposed'))
    for (const handle of processes) handle.terminate()
    const cleanup = Promise.allSettled([
      ...[...processes].map(async (handle) => {
        const exited = await handle.waitForExit()
        if (!exited) throw new Error('execution process range did not reach quiescence')
      }),
    ])
    await Promise.allSettled([...operations])
    const cleanupFailures = [...await cleanup, ...await Promise.allSettled([rootScope?.close()])]
      .filter(result => result.status === 'rejected')
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures.map((result): unknown => result.reason), 'read-only execution cleanup failed')
    }
  }
  function disposeOnAbort(): void {
    void Promise.resolve().then(() => disposeEffect()).catch(() => undefined)
  }
  signal?.addEventListener('abort', disposeOnAbort, { once: true })
  const stopSelf = ctx.on('internal/plugin', (fiber) => {
    if (fiber === ctx.fiber && fiber.uid === null) lifetime.abort(new Error('read-only execution binding startup disposed'))
  }, { global: true })
  const stopDependency = ctx.on('internal/status', (fiber) => {
    if (owners.has(fiber) && fiber.state !== FiberState.ACTIVE) lifetime.abort(new Error('read-only execution binding startup dependency changed'))
  }, { global: true })
  try {
    const rootTarget = await track(filesystem.resolve(root, { signal: active() }))
    if ((await track(filesystem.stat(rootTarget, active())))?.type !== 'directory') {
      throw new Error('read-only execution binding requires an existing directory')
    }
    const rootPath = filesystem.processPath(rootTarget)
    const workspaceId = await track(identity.resolve(rootPath, active()))
    const scope = await track((async () => {
      rootScope = await filesystem.openReadRoot(rootTarget, active(), { aliasPolicy })
      if (rootScope.aliasPolicy !== aliasPolicy) throw new Error('execution root alias policy unavailable')
      return rootScope
    })())
    active()
    async function resolve(path: string, operationSignal: AbortSignal): Promise<FsTarget> {
      let target = rootTarget
      for (const segment of segments(path)) {
        operationSignal.throwIfAborted()
        target = await filesystem.resolve(segment, { cwd: filesystem.processPath(target), signal: operationSignal })
        operationSignal.throwIfAborted()
        if (!filesystem.contains(rootTarget, target)) throw new Error('execution path escapes its bound root')
      }
      return target
    }
    function read<Value>(
      path: string, caller: AbortSignal | undefined,
      operation: (parts: readonly string[], signal: AbortSignal) => Promise<Value>,
    ): Promise<Value> {
      return track((async () => {
        const operationSignal = active(caller)
        const parts = segments(path)
        operationSignal.throwIfAborted()
        const result = await operation(parts, operationSignal)
        operationSignal.throwIfAborted()
        return result
      })())
    }
    const fs: ReadOnlyExecutionFs = {
      stat: (path, caller) => read(path, caller, (parts, operationSignal) => scope.stat(parts, operationSignal)),
      readText: (path, maxBytes, caller) => read(path, caller,
        (parts, operationSignal) => scope.readText(parts, maxBytes, operationSignal)),
      listDir: (path, caller) => read(path, caller, async (parts, operationSignal) => {
        const entries = await scope.listDir(parts, operationSignal)
        return entries.map((entry) => {
          if (segments(entry.name).length !== 1) {
            throw new Error('execution directory child escapes its bound root')
          }
          return {
            path: path === '' ? entry.name : `${path}/${entry.name}`,
            name: entry.name,
            type: entry.type,
            ...(entry.size === undefined ? {} : { size: entry.size }),
          }
        })
      }),
    }
    active()
    return {
      workspaceId,
      fs,
      subprocess: {
        terminalEnvironment: caller => track((async () => {
          const operationSignal = active(caller)
          const environment = await subprocess.terminalEnvironment(operationSignal)
          active(operationSignal)
          return environment
        })()),
        start: spec => track((async () => {
          const operationSignal = active(spec.signal)
          const cwdTarget = await resolve(spec.cwd ?? '', operationSignal)
          if ((await filesystem.stat(cwdTarget, operationSignal))?.type !== 'directory') throw new Error('execution working directory must exist')
          operationSignal.throwIfAborted()
          if (spec.stdin !== 'ignore' && (!Number.isSafeInteger(spec.stdin.maxBytes) || spec.stdin.maxBytes < 0
            || Buffer.byteLength(spec.stdin.data, 'utf8') > spec.stdin.maxBytes)) throw new Error('execution input exceeds its byte ceiling')
          const executableEnv = spec.env === undefined ? undefined : Object.fromEntries(
            Object.entries(spec.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
          )
          const executable = await subprocess.resolveExecutable(spec.argv[0], executableEnv, operationSignal)
          operationSignal.throwIfAborted()
          const confinement = await sandbox.confine([executable, ...spec.argv.slice(1)], { mode: 'read-only', workspaceRoot: rootPath }, operationSignal)
          active(operationSignal)
          if (spec.requireFullEnforcement && confinement.enforcement !== 'full') throw new Error('execution requires full sandbox enforcement')
          const handle = subprocess.spawn({
            argv: confinement.argv,
            cwd: filesystem.processPath(cwdTarget),
            env: spec.env,
            stdio: { stdin: spec.stdin === 'ignore' ? 'ignore' : { data: spec.stdin.data }, stdout: spec.stdout, stderr: spec.stderr },
            graceMs: spec.graceMs,
            signal: operationSignal,
          })
          processes.add(handle)
          void handle.done.then(async () => {
            if (await handle.waitForExit()) processes.delete(handle)
          }, () => undefined).catch(() => undefined)
          return {
            handle, enforcement: confinement.enforcement,
            denialSignatures: confinement.denialSignatures, runnerFailureRules: confinement.runnerFailureRules,
          }
        })()),
      },
      dispose: async () => { await disposeEffect(); await cleanupTask },
    }
  } catch (error) {
    await disposeEffect()
    await cleanupTask
    throw error
  } finally {
    stopSelf()
    stopDependency()
  }
}
