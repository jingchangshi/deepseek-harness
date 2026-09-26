/** Durable execution-workspace identity vocabulary. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Persisted opaque identity; it grants no access to a filesystem or process. */
export type ExecutionWorkspaceId = Branded<'ExecutionWorkspaceId'>
