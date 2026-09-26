/** Host-local durable records for execution worlds and their canonical roots. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ExecutionWorkspaceId } from './types.ts'

/** Only UUIDs and one-way root lookup keys reach the persisted identity domain. */
export const executionWorldDomain = defineDomain({
  name: 'execution_world_identity',
  version: 1,
  global: {
    schema: z.object({ localWorldId: z.uuid().nullable() }).strict(),
    initial: { localWorldId: null },
  },
  tables: {
    roots: domainTable(z.object({
      workspaceId: z.uuid().transform((value): ExecutionWorkspaceId => value as ExecutionWorkspaceId),
    }).strict()),
  },
})
