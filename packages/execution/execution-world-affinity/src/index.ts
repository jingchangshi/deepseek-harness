/** Process-local execution namespace ownership shared by trusted capability providers. */
/** Opaque namespace witness compared only by identity; neither durable identity nor authorization. */
export type ExecutionWorldAffinity = symbol

/**
 * Allocate one witness for a connection or runtime owner to share with its providers.
 * @returns a fresh symbol without host, user, or path data.
 */
export function createExecutionWorldAffinity(): ExecutionWorldAffinity {
  return Symbol()
}

/** Host witness shared across module copies in one JavaScript agent, not across processes or workers. */
export const HOST_EXECUTION_WORLD_AFFINITY: ExecutionWorldAffinity = Symbol.for('@deepseek-ai/dsh-execution-world-affinity/host/v1')
