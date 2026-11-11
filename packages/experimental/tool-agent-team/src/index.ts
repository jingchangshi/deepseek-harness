/** Scoped model-facing tools for the opt-in Agent Teams runtime. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { RoleId, TeamError, TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import type { ResolvedRoleTable, TeamMemberView } from '@deepseek-ai/dsh-experimental-agent-team'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-agent-team'
/** Services required by the Team tool plugin. */
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt']

/** Tool routing configuration. */
export interface Config {
  /** Register `interrupt_agent` and its policy guidance. Defaults to true; false leaves the domain API available. */
  readonly interrupt?: boolean
  /** Continuable-subagent provider used for fresh teammates. */
  readonly freshProvider?: string
  /** Continuable-subagent provider used for completed-prefix fork teammates. */
  readonly forkProvider?: string
}

/** Loader schema for the opt-in Team tool plugin. */
export const Config: z<Config> = z.object({
  interrupt: z.boolean().default(true),
  freshProvider: z.string().default('spawn'),
  forkProvider: z.string().default('fork'),
})

/**
 * Render the role catalog one Team actually routes by, naming its provenance.
 *
 * The rows come from the Team-service configuration the Lead's preset selects,
 * so this text cannot drift from the routes a spawn really uses: it is the same
 * table `spawn_teammate` resolves. No route is hardcoded here.
 *
 * The catalog NAMES the preset that was observed and the table that answered.
 * A silent substitution is the one failure a reader cannot detect: the base
 * table and a preset table render identically otherwise, so a session whose
 * preset was misread showed the built-in routes while its persona documented
 * different ones. When resolution fell back, that is stated outright.
 * @param resolution - the Team's table, the observed preset, and the table used.
 * @returns the catalog line plus, when applicable, an explicit fallback warning.
 */
function roleCatalog(resolution: ResolvedRoleTable): string {
  const { roles, presetId, presetSource, table, fellBack } = resolution
  const rung = presetSource === 'composed'
    ? 'the live composition'
    : presetSource === 'projection' ? 'the session projection' : 'the creation-time session header'
  const observed = presetId === undefined ? 'none observed' : `${presetId}, read from ${rung}`
  const warning = !fellBack ? '' : presetId === undefined
    ? '\n\nWARNING: no preset id could be observed, so roles fell back to the base "roles" table. If this session runs under a preset with its own team routes, those routes are NOT in effect: treat the table above as unconfirmed and say so before spawning.'
    : `\n\nWARNING: preset "${presetId}" has no presetRoles entry in this deployment, so roles fell back to the base "roles" table. The routes above are therefore NOT that preset's routes: treat them as unconfirmed and say so before spawning.`
  const head = `Team roles (preset: ${observed} -> ${table} table)`
  if (roles.length === 0) return `${head}: this deployment configures no roles, so spawn_teammate cannot create a teammate.${warning}`
  const rows = roles.map(role => `${role.id} (${role.provider}/${role.model}, ${role.description}, max ${role.maxConcurrent})`)
  return `${head}: ${rows.join(' · ')}.${warning}`
}

/** Model-facing collaboration guidance shared by Lead and teammates. */
function teamPolicy(interrupt: boolean, resolution: ResolvedRoleTable): string {
  return `Agent Teams is available in this session

${roleCatalog(resolution)} Dispatch by role: spawn_teammate({ role, task }). Reuse an idle teammate of the SAME role with send_message (pass expected_role to assert) before creating a new one. A task's required_role is enforced when claimed or reassigned. When capacity is full the runtime returns backpressure naming the blocked role: wait or reuse, and NEVER send a task to a mismatched role.

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

Use the target returned by spawn_teammate or list_agents for send_message${interrupt ? ' and interrupt_agent' : ''}, or as owner when assigning or filtering shared tasks. send_message steers a running target at its nearest step boundary and starts or resumes an inactive target. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. provisioning means member creation is in progress; failed means member creation failed. A peer message starts with its sender name. A successful send does not mean the recipient has processed it. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. A task that declares completion requirements (team_task_create "requirements") completes only when you pass "evidence" for every declared key and an installed completion policy accepts it; without such a policy the refusal is TEAM_TASK_COMPLETION_UNAVAILABLE. Requirements may be added or strengthened by an edit but never removed or weakened. Task readiness never starts an owner. Before wait_agent, use list_agents and make sure another required member is running or provisioning; use send_message first when the required member is inactive. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member can produce a change. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.`
}

const ACTIVE_WAIT_STATUSES: ReadonlySet<TeamMemberView['status']> = new Set(['running', 'provisioning'])
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.'

/**
 * One model-facing roster row. The Lead pseudo-row omits the
 * teammate-only provisioning fields, so only identity, role, status, and
 * diagnostics are required.
 */
const MEMBER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string', required: true },
    role: { type: 'string', required: true, enum: ['lead', 'teammate'] },
    status: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed', 'retired'] },
    roleId: { type: 'string' },
    slotId: { type: 'string' },
    generation: { type: 'integer' },
    description: { type: 'string' },
    provider: { type: 'string' },
    context: { type: 'string', enum: ['fresh', 'fork'] },
    model: { type: 'string' },
    diagnostics: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

/** Expose the member name as its model-facing target. */
function modelMember(member: TeamMemberView): InferValue<typeof MEMBER_VIEW_SCHEMA> {
  const { id: _id, name, ...details } = member
  return { target: name, ...details }
}

/**
 * Shared guidance for the opaque completion requirement contract, so the two
 * tools that accept or display it cannot drift apart.
 */
const COMPLETION_REQUIREMENTS_DESCRIPTION = 'Declared completion requirements. Each entry names a stable key, the completion policy kind that validates it, and an opaque JSON payload. A task that declares requirements completes only when a registered completion policy accepts the offered evidence; a task without requirements keeps the ordinary completion behaviour.'

/**
 * The accepted write-scope form, stated once in the tool that owns the
 * conversion, so every refusal names the rule and the workspace it was measured
 * against instead of a bare "invalid scope".
 */
const WRITE_SCOPE_FORM = 'write scopes are session-relative file or directory prefixes inside the session workspace (e.g. "targets/ascend/plan"), never another tree'

/** The one directory capability this tool reads, declared structurally like Team routing's preset roster. */
interface WorkingDirectoryProbe {
  get(session: Agent['session']): string
}

/**
 * Read the directory an absolute write scope is relative to.
 *
 * The working-directory projection is authoritative because a Session can move;
 * the durable header is the fallback for a Session created without that service.
 * @param ctx - context that may contain the working-directory service.
 * @param agent - calling Agent whose Session owns the directory.
 * @returns the effective absolute session directory, when one is known.
 */
export function sessionDirectory(ctx: Context, agent: Agent): string | undefined {
  const workingDirectory = ctx.get('workingDirectory') as WorkingDirectoryProbe | undefined
  const directory = workingDirectory?.get(agent.session) ?? agent.session.header.cwd
  return directory === undefined || directory.trim().length === 0 ? undefined : directory
}

/**
 * Lexically normalize one absolute path into comparable form.
 *
 * Collapses repeated separators, drops `.` segments, and resolves `..` against
 * its parent, clamped at its root. Deliberately lexical: a write scope is
 * advisory text compared component-wise, so it is never canonicalized against
 * the filesystem and no I/O runs during a task mutation.
 * @param value - absolute path, POSIX or drive-letter form.
 * @returns the normalized path with a preserved root and no trailing separator.
 */
function absoluteForm(value: string): string {
  const drive = /^([a-z]):/iu.exec(value)?.[1]?.toUpperCase()
  const segments: string[] = []
  for (const segment of (drive === undefined ? value : value.slice(2)).split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return drive === undefined ? `/${segments.join('/')}` : `${drive}:/${segments.join('/')}`
}

/**
 * Convert one write-scope candidate into the form the Team service stores.
 *
 * A relative candidate passes through untouched, so the Team service stays the
 * single authority on the accepted syntax. An absolute candidate INSIDE the
 * session directory converts losslessly — the case that used to lose a whole
 * batch of task creations. An absolute candidate OUTSIDE it is refused with that
 * reason rather than silently kept: a verbatim absolute scope is not comparable
 * with another task's scope, and a `../` rewrite would corrupt the component-wise
 * overlap warnings the board derives from these values.
 * @param cwd - effective absolute session directory, when one is known.
 * @param value - model-authored scope, relative or absolute.
 * @returns the scope to send to the Team service.
 */
export function sessionWriteScope(cwd: string | undefined, value: string): string {
  const candidate = value.trim().replaceAll('\\', '/')
  if (!candidate.startsWith('/') && !/^[a-z]:/iu.test(candidate)) return value
  if (cwd === undefined) {
    throw new TeamError(
      `invalid write scope ${JSON.stringify(value)}: it is an absolute path but this session records no working directory to make it relative to; `
      + WRITE_SCOPE_FORM,
      'TEAM_INVALID_WRITE_SCOPE',
    )
  }
  const workspace = absoluteForm(cwd.replaceAll('\\', '/'))
  const absolute = absoluteForm(candidate)
  // A workspace that IS a filesystem root has no separator of its own to keep.
  const atRoot = workspace === '/' || /^[a-z]:\/$/iu.test(workspace)
  if (absolute === workspace) {
    throw new TeamError(
      `invalid write scope ${JSON.stringify(value)}: it resolves to the session workspace root ${JSON.stringify(workspace)} and names no path inside it; `
      + 'name a file or directory instead, e.g. "src/feature"',
      'TEAM_INVALID_WRITE_SCOPE',
    )
  }
  if (!absolute.startsWith(atRoot ? workspace : `${workspace}/`)) {
    throw new TeamError(
      `invalid write scope ${JSON.stringify(value)}: it is outside the session workspace ${JSON.stringify(workspace)}, so it has no session-relative form `
      + `and a scope from another tree cannot be stored; ${WRITE_SCOPE_FORM}; record the prefix inside the session workspace that the work changes, or omit this scope`,
      'TEAM_INVALID_WRITE_SCOPE',
    )
  }
  return absolute.slice(atRoot ? workspace.length : workspace.length + 1)
}

/**
 * Convert every declared write scope before the Team service validates it.
 * @param cwd - effective absolute session directory, when one is known.
 * @param values - model-authored scopes.
 * @returns the scope to send for each entry, in declaration order.
 */
export function sessionWriteScopes(cwd: string | undefined, values: readonly string[]): string[] {
  return values.map(value => sessionWriteScope(cwd, value))
}

/** One declared completion requirement. */
const COMPLETION_REQUIREMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    payload: { type: 'json', required: true },
  },
} as const

/** One opaque evidence reference offered for a declared requirement key. */
const COMPLETION_EVIDENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: { type: 'string', required: true },
    reference: { type: 'string', required: true },
  },
} as const

/** Durable receipt recorded by the completion policies that accepted a task. */
const COMPLETION_RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    policy: { type: 'string', required: true },
    requirementsDigest: { type: 'string', required: true },
    evidence: { type: 'array', required: true, items: COMPLETION_EVIDENCE_SCHEMA },
    acceptedRevision: { type: 'integer', required: true },
  },
} as const

/** One shared task, matching the public `TeamTaskView`. */
const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    subject: { type: 'string', required: true },
    description: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'deleted'] },
    ownerName: { type: 'string' },
    blockedBy: { type: 'array', required: true, items: { type: 'string' } },
    writeScopes: { type: 'array', required: true, items: { type: 'string' } },
    ready: { type: 'boolean', required: true },
    writeScopeWarnings: { type: 'array', required: true, items: { type: 'string' } },
    requiredRole: { type: 'string' },
    completionRequirements: { type: 'array', items: COMPLETION_REQUIREMENT_SCHEMA },
    completion: COMPLETION_RECEIPT_SCHEMA,
  },
} as const

const SPAWN_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    member: { ...MEMBER_VIEW_SCHEMA, required: true },
  },
} as const

const MEMBER_LIST_VALUE_SCHEMA = { type: 'array', items: MEMBER_VIEW_SCHEMA } as const

const SEND_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sent: { type: 'boolean', required: true, const: true },
  },
} as const

/** `noProgress` is present only on the model-only shortcut that skips the wait. */
const WAIT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    timedOut: { type: 'boolean', required: true },
    noProgress: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', required: true, const: 'no-active-peer' },
        message: { type: 'string', required: true },
      },
    },
  },
} as const

const INTERRUPT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    previousStatus: { type: 'string', required: true, enum: ['running', 'inactive'] },
  },
} as const

const TASK_LIST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: { type: 'array', required: true, items: TASK_VIEW_SCHEMA },
    nextCursor: { type: 'integer' },
  },
} as const

/**
 * Declare one canonical output schema with compact model-facing JSON. Every
 * Team result is a fixed record, so the declared schema is what makes the
 * compiler check `execute` against the value the model is promised.
 * @param schema - canonical value schema for one tool.
 * @returns the `output` declaration accepted by {@link defineTool}.
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  /* v8 ignore next 2 -- Team tools are registered only in an exact Agent scope, so discovery supplies this carrier. */
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/** Register the complete Team tool set in one exact Agent scope. */
function install(agent: Agent, ctx: Context, config: Required<Config>): () => void {
  const scoped = agent.ctx
  const disposers: Array<() => unknown> = []
  const register = (disposer: () => unknown): void => { disposers.push(disposer) }
  try {
    register(scoped.systemPrompt.section({
      name: 'team:policy',
      order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),
      // Resolved per assembly from the Team's own role table, so the catalog
      // names the preset actually observed and the table it produced — including
      // when that is a fallback, which is stated as a warning rather than
      // inferred from prose elsewhere in the prompt.
      text: () => teamPolicy(config.interrupt, ctx.agentTeams.resolvedRoleTable(agent)),
    }))
    register(scoped.systemPrompt.context({
      name: 'team:identity',
      order: scoped.systemPrompt.getContextOrder('TEAM_IDENTITY'),
      required: true,
      text: () => {
        const { role, name } = ctx.agentTeams.membership(agent)
        return `${role === 'lead'
          ? 'You are the Team Lead named "lead".'
          : `You are teammate "${name}".\nYour Team Lead is named "lead".\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).`}
Use list_agents({}) to find your teammates and their names.
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).`
      },
    }))

    register(scoped.tools.register(defineTool({
      name: 'spawn_teammate',
      description: 'Create one named, durable teammate. Only the Team Lead may call this tool.',
      parameters: {
        role: { type: 'string', required: true, description: 'Declared role id to fill. The role fixes the model route and concurrency; the role catalog in your Team policy lists the ids this deployment routes, and a route is deployment configuration that this tool cannot override.' },
        task: { type: 'string', required: true, description: 'Complete initial task for the teammate.' },
        context: {
          type: 'string',
          enum: ['fresh', 'fork'],
          description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
        },
        slot: { type: 'string', description: 'Optional slot id to claim. Reserved slots belong to one role; flex slots are shared.' },
        description: { type: 'string', description: 'Short description of the delegated responsibility.' },
      },
      output: jsonOutput(SPAWN_VALUE_SCHEMA),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'spawn_teammate')
        const result = await ctx.agentTeams.spawnTeammate(agent, {
          roleId: RoleId(args.role),
          description: args.description ?? args.role,
          task: [{ type: 'text', text: args.task }],
          context: args.context ?? 'fresh',
          ...args.slot === undefined ? {} : { slotId: args.slot },
          signal: exec.signal,
        })
        return { member: modelMember(result.member) }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'send_message',
      description: 'Send one message to another Team member. A running target receives it at the nearest step boundary; an inactive target starts or resumes a turn.',
      parameters: {
        target: { type: 'string', required: true, description: 'Member target returned by spawn_teammate or list_agents, including lead.' },
        message: { type: 'string', required: true, description: 'Self-contained message for the target.' },
        expected_role: { type: 'string', description: 'Assert the target role; a mismatch is refused instead of delivering. Omit to allow ordinary cross-role communication.' },
      },
      output: jsonOutput(SEND_VALUE_SCHEMA),
      async execute(args, exec) {
        await ctx.agentTeams.sendMessage(callingAgent(exec.agent, 'send_message'), {
          target: args.target,
          content: [{ type: 'text', text: args.message }],
          ...args.expected_role === undefined ? {} : { expectedRole: RoleId(args.expected_role) },
          signal: exec.signal,
        })
        return { sent: true }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'list_agents',
      description: 'List the Lead and every durable teammate with an addressable target and current availability. inactive means no turn is executing, not a task result. provisioning and failed describe member creation.',
      parameters: {},
      output: jsonOutput(MEMBER_LIST_VALUE_SCHEMA),
      execute(_args, exec) {
        return Promise.resolve(ctx.agentTeams.listMembers(callingAgent(exec.agent, 'list_agents')).map(modelMember))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'wait_agent',
      description: 'Wait for the next teammate status, message, or shared-task change after this call starts. This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Re-list after wakeup or timeout instead of polling.',
      parameters: {
        timeout_ms: {
          type: 'integer',
          description: 'Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.',
        },
      },
      output: jsonOutput(WAIT_VALUE_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'wait_agent')
        const timeoutMs = args.timeout_ms ?? 30_000
        // Preserve TeamService's authoritative timeout validation before the
        // model-only no-progress shortcut.
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
          return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
        }
        // The active-peer read and waiter registration must remain one synchronous
        // span; awaiting between them can lose the only peer-status edge.
        const hasActivePeer = ctx.agentTeams.listMembers(caller).some(member =>
          member.id !== caller.id && ACTIVE_WAIT_STATUSES.has(member.status))
        if (!hasActivePeer) {
          return {
            timedOut: false,
            noProgress: {
              reason: 'no-active-peer' as const,
              message: NO_ACTIVE_PEER_MESSAGE,
            },
          }
        }
        return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
      },
    })))

    if (config.interrupt) {
      register(scoped.tools.register(defineTool({
        name: 'interrupt_agent',
        description: 'Interrupt one teammate\'s current turn while preserving its pending inbox. Team Lead only.',
        parameters: {
          target: { type: 'string', required: true, description: 'Teammate target returned by spawn_teammate or list_agents.' },
        },
        output: jsonOutput(INTERRUPT_VALUE_SCHEMA),
        execute(args, exec) {
          return Promise.resolve(ctx.agentTeams.interrupt(callingAgent(exec.agent, 'interrupt_agent'), args.target))
        },
      })))
    }

    register(scoped.tools.register(defineTool({
      name: 'retire_teammate',
      description: 'Retire one active or failed teammate, releasing its slot while keeping its name reserved forever. Team Lead only.',
      parameters: {
        target: { type: 'string', required: true, description: 'Teammate target returned by list_agents.' },
      },
      output: jsonOutput(MEMBER_VIEW_SCHEMA),
      async execute(args, exec) {
        const member = await ctx.agentTeams.retireTeammate(callingAgent(exec.agent, 'retire_teammate'), args.target)
        return modelMember(member)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_create',
      description: 'Create one unowned pending task on the shared Team task board.',
      parameters: {
        subject: { type: 'string', required: true, description: 'Concise task title.' },
        description: { type: 'string', required: true, description: 'Complete task details and acceptance criteria.' },
        required_role: { type: 'string', description: 'Required role id for whoever claims this task; a claim or reassignment by another role is refused.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete first.' },
        write_scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Advisory file or directory prefixes this task expects to modify. Stored session-workspace-relative: pass either that relative form or an absolute path inside the session workspace, which is converted for you. An absolute path outside the session workspace is refused, because it has no relative form to compare with other tasks.',
        },
        requirements: {
          type: 'array',
          items: COMPLETION_REQUIREMENT_SCHEMA,
          description: COMPLETION_REQUIREMENTS_DESCRIPTION,
        },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'team_task_create')
        // Convert before the Team service validates, so an absolute path inside
        // the session workspace succeeds instead of failing the whole call.
        const writeScopes = args.write_scopes === undefined
          ? undefined
          : sessionWriteScopes(sessionDirectory(ctx, agent), args.write_scopes)
        return await ctx.agentTeams.createTask(agent, {
          subject: args.subject,
          description: args.description,
          ...args.required_role === undefined ? {} : { requiredRole: RoleId(args.required_role) },
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...writeScopes === undefined ? {} : { writeScopes },
          ...args.requirements === undefined ? {} : { completionRequirements: args.requirements },
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_list',
      description: 'List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.',
      parameters: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'Optional exact status filter.',
        },
        owner: { type: 'string', description: 'Optional member target from spawn_teammate or list_agents, matching ownerName; use unowned for tasks without an owner.' },
        ready: { type: 'boolean', description: 'Optional readiness filter.' },
        cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
        limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
      },
      output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
      execute(args, exec) {
        const status = args.status
        const filtered = ctx.agentTeams.listTasks(callingAgent(exec.agent, 'team_task_list')).filter(task =>
          (status === undefined || task.status === status)
          && (args.owner === undefined || (args.owner === 'unowned' ? task.ownerName === undefined : task.ownerName === args.owner))
          && (args.ready === undefined || task.ready === args.ready))
        const cursor = args.cursor ?? 0
        const limit = args.limit ?? 50
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer')
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100')
        return Promise.resolve({
          tasks: filtered.slice(cursor, cursor + limit),
          ...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_get',
      description: 'Read the complete latest value of one shared task before changing or executing it.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return Promise.resolve(ctx.agentTeams.getTask(
          callingAgent(exec.agent, 'team_task_get'),
          TeamTaskId(args.task_id),
        ))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_update',
      description: 'Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
        expected_revision: { type: 'integer', required: true, description: 'Current task revision used as the CAS precondition.' },
        action: {
          type: 'string',
          required: true,
          enum: ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'],
          description: 'Task transition to apply.',
        },
        subject: { type: 'string', description: 'Replacement title for edit.' },
        description: { type: 'string', description: 'Replacement details for edit.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Complete blocker list for set_dependencies.' },
        write_scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replacement advisory write scopes for edit, stored session-workspace-relative. An absolute path inside the session workspace is converted; one outside it is refused because it has no relative form.',
        },
        owner: { type: 'string', description: 'Member target from spawn_teammate or list_agents for Lead-only reassign; omit to unassign.' },
        completion_requirements: {
          type: 'array',
          items: COMPLETION_REQUIREMENT_SCHEMA,
          description: 'Replacement completion requirements for edit. Requirements may only be added or strengthened; dropping or rewriting a declared requirement is refused.',
        },
        evidence: {
          type: 'array',
          items: COMPLETION_EVIDENCE_SCHEMA,
          description: 'Evidence references for complete, one per declared requirement key. A task that declares completion requirements completes only when a registered completion policy accepts these references.',
        },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'team_task_update')
        // Same conversion as create: an edit must not fail on a path form the
        // model can legitimately produce, and must not store another tree's path.
        const writeScopes = args.write_scopes === undefined
          ? undefined
          : sessionWriteScopes(sessionDirectory(ctx, agent), args.write_scopes)
        return await ctx.agentTeams.updateTask(agent, {
          taskId: TeamTaskId(args.task_id),
          expectedRevision: args.expected_revision,
          action: args.action,
          ...args.subject === undefined ? {} : { subject: args.subject },
          ...args.description === undefined ? {} : { description: args.description },
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...writeScopes === undefined ? {} : { writeScopes },
          ...args.owner === undefined ? {} : { owner: args.owner },
          ...args.completion_requirements === undefined
            ? {}
            : { completionRequirements: args.completion_requirements },
          ...args.evidence === undefined ? {} : { evidence: args.evidence },
        })
      },
    })))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) void dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) void dispose()
  }
}

/** Install Team tools in every live or subsequently published Team member scope. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: Required<Config> = {
    interrupt: config.interrupt ?? true,
    freshProvider: config.freshProvider ?? 'spawn',
    forkProvider: config.forkProvider ?? 'fork',
  }
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return
    installed.set(agent, install(agent, ctx, resolved))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'tool-team.scopedTools()')
}
