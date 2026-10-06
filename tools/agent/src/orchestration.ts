/** State-directed role dispatch without owning model execution. */

import type { HarnessConfig } from './config.ts'
import { resolveRoleRoute } from './config.ts'
import type { TaskStateRecord } from './types.ts'

/** One fixed tool call the coordinator may request from DSH. */
export interface DispatchInstruction {
  role: string
  toolName: string
  mode: 'plain' | 'workflow-fanout'
  taskRevision: number
  workRevision: number
}

/**
 * Select the next fixed-role calls from repository state.
 * @param config - validated harness configuration.
 * @param state - authoritative task state.
 * @returns zero or more bounded dispatch instructions.
 */
export function nextDispatches(config: HarnessConfig, state: TaskStateRecord): DispatchInstruction[] {
  let roles: string[]
  switch (state.state) {
    case 'BASELINED': roles = ['scout-primary', 'scout-secondary']; break
    case 'INVESTIGATED': roles = ['architect']; break
    case 'PLAN_FROZEN':
    case 'IMPLEMENTING': roles = ['implementer']; break
    case 'VERIFIED': roles = ['reviewer']; break
    default: roles = []
  }
  if (roles.length > config.workflow.maxConcurrentAgents) throw new Error('dispatch exceeds workflow concurrency limit')
  const mode = roles.length >= config.workflow.minimumFanout ? 'workflow-fanout' : 'plain'
  if (mode === 'workflow-fanout' && roles.length < 2) throw new Error('workflow requires at least two independent branches')
  return roles.map((role) => {
    const route = resolveRoleRoute(config, role)
    if (route.toolName === undefined) throw new Error(`role ${role} has no fixed tool`)
    return { role, toolName: route.toolName, mode, taskRevision: state.revision, workRevision: state.workRevision }
  })
}
