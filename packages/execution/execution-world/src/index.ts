/** Durable opaque workspace identities resolved through the mounted execution filesystem. */
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, parse } from 'node:path'
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-fs'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { executionWorldDomain } from './spec.ts'
import { withAllocationLock } from './allocation-lock.ts'
import type { ExecutionWorkspaceId } from './types.ts'

export type { ExecutionWorkspaceId } from './types.ts'

/** Deployment identity selection; remote deployments must explicitly choose their own UUID. */
export interface Config {
  /** Local identity is persisted once; deployment identity is supplied by the operator. */
  mode: 'persisted-local' | 'deployment'
  /** Stable UUID shared by aliases of one remote world, never by different worlds. */
  deploymentId?: string
  /** Absolute Host coordination path shared by every process using this identity store. */
  allocationLockPath: string
  /** Maximum wait for another identity transaction, in milliseconds. */
  lockWaitMs?: number
}

const allocationConfig = {
  allocationLockPath: z.string().refine(path => isAbsolute(path) && (process.platform !== 'win32' || parse(path).root.length > 1), 'allocationLockPath must be fully qualified'),
  lockWaitMs: z.number().int().positive().max(2_147_483_647).default(30_000),
}
const configSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('persisted-local'), ...allocationConfig }).strict(),
  z.object({ mode: z.literal('deployment'), deploymentId: z.uuid(), ...allocationConfig }).strict(),
])

declare module '@deepseek-ai/cordis' {
  interface Context {
    executionWorldIdentity: ExecutionWorldIdentity
  }
}

/** Owns durable identity allocation, not execution handles or remote transport. */
export class ExecutionWorldIdentity extends Service {
  static inject = ['storageDomain', 'fs']
  static Config: schema<Config> = schema.object({
    mode: schema.union(['persisted-local', 'deployment']).required(),
    deploymentId: schema.string(),
    allocationLockPath: schema.string().required(),
    lockWaitMs: schema.number().min(1).max(2_147_483_647).step(1).default(30_000),
  })

  private readonly config: z.infer<typeof configSchema>
  private readonly lifetime = new AbortController()
  private worldId!: string
  private tail: Promise<unknown> = Promise.resolve()
  private readonly operations = new Set<Promise<ExecutionWorkspaceId>>()

  /**
   * @param ctx - owner with durable storage and the execution filesystem.
   * @param config - explicit local or deployment identity mode.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'executionWorldIdentity')
    this.config = configSchema.parse(config)
  }

  /** Open durable records before publishing this service. */
  protected async [Service.init](): Promise<void> {
    const startupAbort = new AbortController()
    const dependencyOwners = new Set(ExecutionWorldIdentity.inject.map((name) => {
      const implementation = this.ctx.fiber.store?.[name]
      if (implementation === undefined) throw new Error(`execution-world identity missing injected provider: ${name}`)
      return implementation.fiber
    }))
    const stopSelf = this.ctx.on('internal/plugin', (fiber) => {
      if (fiber === this.ctx.fiber && fiber.uid === null) startupAbort.abort(new Error('execution-world identity startup disposed'))
    }, { global: true })
    const stopDependency = this.ctx.on('internal/status', (fiber) => {
      if (dependencyOwners.has(fiber) && fiber.state !== FiberState.ACTIVE) startupAbort.abort(new Error('execution-world identity startup dependency changed'))
    }, { global: true })
    this.ctx.effect(() => async () => {
      this.lifetime.abort(new Error('execution-world identity provider disposed'))
      await Promise.allSettled([...this.operations])
    })
    try {
      this.worldId = await this.withDomain(AbortSignal.any([startupAbort.signal, this.lifetime.signal]), async (domain) => {
        if (this.config.mode === 'deployment') return this.config.deploymentId
        const stored = domain.global.get().localWorldId
        const worldId = stored ?? randomUUID()
        if (stored === null) await domain.global.set({ localWorldId: worldId })
        return worldId
      })
    } catch (error) {
      const reason = startupAbort.signal.reason as unknown
      if (!startupAbort.signal.aborted || (error !== reason && !(error instanceof Error && error.name === 'AbortError' && error.cause === reason))) throw error
    } finally {
      stopSelf()
      stopDependency()
    }
  }

  private withDomain<Result>(
    signal: AbortSignal,
    operation: (domain: Domain<typeof executionWorldDomain>) => Promise<Result>,
  ): Promise<Result> {
    return withAllocationLock(this.config.allocationLockPath, this.config.lockWaitMs, signal, async () => {
      const domain = await this.ctx.storageDomain.open(executionWorldDomain)
      try {
        signal.throwIfAborted()
        const result = await operation(domain)
        signal.throwIfAborted()
        return result
      } finally { await domain.close() }
    })
  }

  /**
   * Resolve an existing directory through the current filesystem and durably allocate its identity.
   * Concurrent aliases share one allocation. Disposal rejects outstanding resolutions; an allocation
   * already committed before cancellation remains available on the next call or restart.
   * @param root - directory in the mounted filesystem's execution world.
   * @param signal - caller cancellation, combined with this provider's lifetime.
   * @returns the same opaque ID after recreation with the same storage and world configuration.
   */
  resolve(root: string, signal?: AbortSignal): Promise<ExecutionWorkspaceId> {
    const operation = this.resolveRoot(root, signal)
    this.operations.add(operation)
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation))
    return operation
  }

  private async resolveRoot(root: string, signal?: AbortSignal): Promise<ExecutionWorkspaceId> {
    const operationSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    operationSignal.throwIfAborted()
    const target = await this.ctx.fs.resolve(root, { signal: operationSignal })
    operationSignal.throwIfAborted()
    const info = await this.ctx.fs.stat(target, operationSignal)
    operationSignal.throwIfAborted()
    if (info?.type !== 'directory') throw new Error('execution-world identity requires an existing directory')
    const key = createHash('sha256').update(JSON.stringify(['v1', this.worldId, target.targetKey])).digest('hex')
    const result = this.tail.then(() => this.withDomain(operationSignal, async (domain) => {
      operationSignal.throwIfAborted()
      const roots = domain.table('roots')
      const previous = roots.get(key)
      if (previous !== undefined) return previous.workspaceId
      const workspaceId = randomUUID() as ExecutionWorkspaceId
      await roots.put(key, { workspaceId })
      operationSignal.throwIfAborted()
      return workspaceId
    }))
    this.tail = result.then(() => {}, () => {})
    return result
  }
}

export default ExecutionWorldIdentity
