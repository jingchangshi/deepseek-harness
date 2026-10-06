/** DSH tools that own automatic engineering runs and isolated role delegation. */

import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import { POLICY_REFUSAL_CODE, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { loadHarnessConfig, resolveRoleRoute } from '../src/config.ts'
import type { HarnessConfig } from '../src/config.ts'
import { getEngineeringStatus, loadEngineeringProject, recoverEngineeringTask, runEngineeringTask } from '../src/automatic.ts'
import type { EngineeringRole, EngineeringRunResult, RoleInvocation } from '../src/automatic.ts'
import { RoleInvocationError, roleInvocationErrorForLlmCode, roleFailureAfterMutation } from '../src/role-execution.ts'
import { claimEngineeringInvocation, engineeringInvocationId, readEngineeringInvocationReceipt, withEngineeringInvocationLock, writeEngineeringInvocationReceipt } from '../src/invocation.ts'
import type { EngineeringRunInvocationId } from '../src/invocation.ts'

export const name = 'engineering-harness'
export const inject = ['tools', 'subagents', 'systemPrompt']

/** Fixed deployment source and bounded lifetime of each role invocation. */
export interface Config {
  deploymentRoot: string
  roleTimeoutMs: number
}

export const Config: z<Config> = z.object({
  deploymentRoot: z.string().required(),
  roleTimeoutMs: z.number().min(1).step(1).default(1_200_000),
})

const COORDINATOR_TOOLS = ['engineering_run', 'engineering_status', 'engineering_recover', 'get_goal', 'update_goal']
const READ_TOOLS = ['read', 'read_image', 'glob', 'grep', 'lsp', 'web_fetch', 'web_search', 'spill_read']
const activeInvocations = new Map<EngineeringRunInvocationId, Promise<EngineeringRunResult>>()
const childEndReasons = new WeakMap<Session, TurnEndReason>()
const WRITE_TOOLS = ['write', 'edit', 'str_replace_editor']
/**
 * Command-execution tools an Implementer may hold. A shell command runs
 * arbitrary text, so the workflow confines its starting `workdir` and leaves
 * the command body to the deployment sandbox.
 */
const SHELL_TOOLS = process.platform === 'win32' ? ['pwsh'] : ['bash']
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

function normalizeTaskId(taskId: string | undefined): string | undefined {
  if (taskId === '') return undefined
  if (taskId !== undefined && !TASK_ID_PATTERN.test(taskId)) throw new Error('taskId must be a nonempty valid task identifier; omit taskId for a new task or to list all tasks')
  return taskId
}

function workspace(agent: Agent): string {
  const root = agent.session.header.cwd
  if (root === undefined) throw new Error('Engineering Session requires a repository working directory')
  return root
}

function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/**
 * Reject a role-supplied path outside the repository, or inside workflow/Git
 * authority, including symlink aliases.
 * @param root - canonical repository root.
 * @param path - model-supplied file path or command working directory.
 * @param deploymentRoot - user deployment directory protected from model access, including aliases.
 * @param subject - plural noun for the rejection message: `files` for a write target, `working directories` for a command.
 */
export async function assertWritablePath(root: string, path: string, deploymentRoot?: string, subject = 'files'): Promise<void> {
  const refuse = (): never => {
    throw new Error(`Engineering Implementer may only use ${subject} under the project source tree, outside .agent and .git`)
  }
  if (path.split(/[\\/]+/).includes('..')) refuse()
  const candidate = resolve(root, path)
  let existing = candidate
  let canonical: string
  for (;;) {
    try {
      canonical = await realpath(existing)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(existing) === existing) throw error
      existing = dirname(existing)
    }
  }
  const destination = resolve(canonical, relative(existing, candidate))
  const deployment = deploymentRoot === undefined ? undefined : await realpath(deploymentRoot)
  for (const target of [candidate, destination]) {
    const path = relative(root, target)
    if (!within(root, target) || ['.agent', '.git'].some(name => path === name || path.startsWith(`${name}${sep}`))
      || deployment !== undefined && within(deployment, target)) {
      refuse()
    }
  }
}

/**
 * Collect strict JSON from a completed child and await its cleanup on every outcome.
 * @param run - owned subagent run.
 * @param role - logical engineering role under dispatch.
 * @param provider - provider ID used in diagnostics.
 * @param model - resolved model ID used in diagnostics.
 * @param signal - external invocation signal, excluding the local role deadline.
 * @param timeoutSignal - local role-deadline signal, used to identify a child aborted by the deadline.
 * @param mutationStarted - reports whether the attempt dispatched a potentially mutating tool.
 * @returns child-authored JSON after quiescent disposal.
 */
export async function collectRole(run: SubagentRun, role: EngineeringRole, provider: string, model: string, signal: AbortSignal = new AbortController().signal, timeoutSignal?: AbortSignal, mutationStarted: () => boolean = () => false): Promise<unknown> {
  let executionError: RoleInvocationError | undefined
  let structured: unknown
  let stoppedByLocalDeadline = false
  try {
    const result = await run.result
    stoppedByLocalDeadline = result.stopReason === 'aborted'
      && timeoutSignal?.aborted === true
      && !signal.aborted
    const subject = `${role} child ${run.id} via ${provider}/${model}`
    if (result.stopReason !== 'completed') {
      const diagnostic = result.diagnostic === undefined ? '' : ` Diagnostic: ${result.diagnostic}`
      if (signal.aborted) throw new RoleInvocationError(`${subject} ended with ${result.stopReason}.${diagnostic}`, 'NON_FALLBACKABLE', false)
      const reason = run.localAgent === undefined ? undefined : childEndReasons.get(run.localAgent.session)
      const code = reason?.kind === 'error' ? reason.error.code : undefined
      if (result.stopReason === 'error' && code !== undefined) {
        const remedy = code === POLICY_REFUSAL_CODE
          ? ' Repeating this route cannot help; the workflow may try a different candidate only after that route passes its own dispatch policy.'
          : ' Correct the role or provider configuration, then explicitly recover the task.'
        const classified = roleInvocationErrorForLlmCode(code, `${subject} ended with ${result.stopReason}.${diagnostic}${remedy}`)
        if (classified !== undefined) throw classified
      }
      if (result.stopReason === 'max-tokens') {
        throw new RoleInvocationError(`${subject} ended with ${result.stopReason}.${diagnostic} Correct the role or provider configuration, then explicitly recover the task.`, 'MODEL_MALFORMED_OUTPUT', true)
      }
      if (result.stopReason === 'error' && reason?.kind === 'completed') {
        throw new RoleInvocationError(`${subject} completed without structured output.`, 'MISSING_STRUCTURED_OUTPUT', true)
      }
      throw new RoleInvocationError(`${subject} ended with ${result.stopReason}.${diagnostic} Correct the role or provider configuration, then explicitly recover the task.`, 'NON_FALLBACKABLE', false)
    }
    if (result.structured === undefined) {
      throw new RoleInvocationError(`${subject} completed without structured output.`, 'MISSING_STRUCTURED_OUTPUT', true)
    }
    structured = result.structured
  } catch (error) {
    executionError = signal.aborted
      ? new RoleInvocationError(`Role ${role} was cancelled before completion.`, 'NON_FALLBACKABLE', false, { cause: error })
      : error instanceof RoleInvocationError
        ? error
        : new RoleInvocationError(`Role ${role} via ${provider}/${model} failed before an authoritative result.`, 'NON_FALLBACKABLE', false, { cause: error })
  }
  try {
    await run.dispose()
  } catch (error) {
    const cleanup = error instanceof Error ? error.message : String(error)
    const disposal = new RoleInvocationError(`Role ${role} via ${provider}/${model} cleanup failed: ${cleanup}`, 'NON_FALLBACKABLE', false, { cause: error })
    if (executionError !== undefined) throw new AggregateError([executionError, disposal], 'Role execution and cleanup failed')
    throw disposal
  }
  if (executionError !== undefined) {
    if (stoppedByLocalDeadline && !signal.aborted && executionError.failureClass === 'NON_FALLBACKABLE') {
      executionError = new RoleInvocationError(`Role ${role} via ${provider}/${model} exceeded its local deadline after its child stopped and cleanup completed.`, 'ROLE_TIMEOUT_QUIESCENT', true, { cause: executionError })
    }
    throw mutationStarted() ? roleFailureAfterMutation(executionError) : executionError
  }
  return structured
}

/**
 * Install Coordinator tools and enforce role authority in prompt assembly and execution.
 * @param ctx - profile-owned plugin context.
 * @param config - shared deployment configuration and role deadline.
 */
async function applyDeployment(ctx: Context, config: Config, deployment: HarnessConfig): Promise<void> {
  const shutdown = new AbortController()
  const running = new Set<Promise<unknown>>()
  const availableTools = new WeakMap<Agent, string[]>()
  const coordinators = new WeakSet<Agent>()
  const children = new WeakSet<Agent>()
  const mutationObservers = new WeakMap<Agent, () => void>()
  const startingMutationObservers = new Map<string, () => void>()
  const childrenByParent = new Set<string>()
  let closing = false
  let roleStartTail = Promise.resolve()

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') childEndReasons.set(session, event.data.reason)
  })

  async function project(root: string) {
    await loadEngineeringProject(root)
    return deployment
  }

  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) {
      if (childrenByParent.has(agent.session.header.parentSession)) children.add(agent)
      const observer = startingMutationObservers.get(agent.session.header.parentSession)
      if (observer !== undefined) mutationObservers.set(agent, observer)
      return
    }
    const root = workspace(agent)
    const loaded = await project(root)
    const persona = await readFile(resolve(config.deploymentRoot, loaded.roles.coordinator!.personaFile), 'utf8')
    shutdown.signal.throwIfAborted()
    availableTools.set(agent, [...READ_TOOLS, ...WRITE_TOOLS, ...SHELL_TOOLS].filter(name => agent.ctx.tools.get(name, agent) !== undefined))
    coordinators.add(agent)
    ctx.effect(() => agent.ctx.systemPrompt.section({
      name: 'engineering:coordinator', order: 1, interpolate: false,
      text: `${persona}\nFor a new development request, call engineering_run with the complete user requirement and no taskId. This tool owns investigation, planning, implementation, verification, review and acceptance. For progress or resumption, first use engineering_status, then call engineering_run with only the returned taskId and omit request. Supply both taskId and request only to change scope after the task explicitly enters REPLAN. Respect engineering_run.nextAction: WAIT_FOR_CURRENT_RUN means do not start another run; REPLAN_WITH_SCOPE means ask only for missing product/scope information; RECOVER means do not repeat engineering_run unchanged and call engineering_recover. Obtain operator confirmation that previous agent and command work stopped only when requiresStopConfirmation is true. Ask only for missing product decisions. Do not ask users to run agentctl or manage revisions, artifacts, or writer tokens. Report ACCEPTED only when the tool returns that state.`,
    }))
    // `restrict` refuses a name the composition does not expose and cannot mask
    // a tool the Session registered into its OWN scope, which is exactly where
    // the standing delegation row (`tool-subagent` with `modelSelectionSettings`)
    // installs itself. The composition therefore suppresses that row for this
    // profile (see `classifyPresetRows` in ./preset-rows.ts); here a restriction
    // over the exposed engineering tools keeps the coordinator to the workflow.
    ctx.effect(() => {
      const exposed = COORDINATOR_TOOLS.filter(name => agent.ctx.tools.get(name, agent) !== undefined)
      return exposed.length === 0 ? () => {} : agent.ctx.tools.restrict({ allow: exposed })
    })
    ctx.effect(() => agent.ctx.on('agent/request', async (_payload, next) => {
      const request = await next()
      const route = resolveRoleRoute(await project(root), 'coordinator')
      const { reasoningEffort: _reasoningEffort, ...baseRequest } = request
      return { ...baseRequest, provider: route.provider, model: route.model,
        ...route.reasoningEffort === 'off' ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }, maxTokens: route.maxTokens }
    }))
  })

  ctx.tools.guard(exec => {
    if (exec.agent === undefined) return 'Engineering profile requires a Session-owned caller'
    if (coordinators.has(exec.agent) && !COORDINATOR_TOOLS.includes(exec.name)) {
      return `Coordinator may only use engineering workflow tools (${COORDINATOR_TOOLS.join(', ')}); this profile removes generic delegation, so delegate by naming a workflow tool instead`
    }
    if (children.has(exec.agent) && COORDINATOR_TOOLS.includes(exec.name)) return 'Engineering roles cannot start nested workflows'
    return undefined
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent !== undefined && !READ_TOOLS.includes(exec.name)) mutationObservers.get(exec.agent)?.()
    if (exec.agent !== undefined && children.has(exec.agent) && WRITE_TOOLS.includes(exec.name)) {
      const args = exec.arguments
      if (args === null || typeof args !== 'object') throw new Error('Engineering write requires a path')
      const path = 'file_path' in args ? args.file_path : 'path' in args ? args.path : undefined
      if (typeof path !== 'string') throw new Error('Engineering write requires a file path')
      await assertWritablePath(await realpath(workspace(exec.agent)), path, config.deploymentRoot)
    }
    // A shell command runs arbitrary text, so its own `workdir` is the only
    // statically checkable path. Confining it keeps an Implementer from
    // starting inside the workflow's own artifacts; the command text remains
    // the deployment sandbox's responsibility.
    if (exec.agent !== undefined && children.has(exec.agent) && SHELL_TOOLS.includes(exec.name)) {
      const args = exec.arguments
      if (args === null || typeof args !== 'object') throw new Error('Engineering shell call requires arguments')
      const workdir = 'workdir' in args ? args.workdir : undefined
      if (workdir !== undefined && typeof workdir !== 'string') throw new Error('Engineering shell workdir must be a string')
      await assertWritablePath(await realpath(workspace(exec.agent)), workdir ?? '.', config.deploymentRoot, 'working directories')
    }
    return next()
  })

  const executeRole = async (parent: Agent, invocation: RoleInvocation): Promise<unknown> => {
    const previousStart = roleStartTail
    let releaseStart!: () => void
    roleStartTail = new Promise<void>(resolve => { releaseStart = resolve })
    let started = false
    let mutationStarted = false
    const markMutationStarted = () => {
      mutationStarted = true
      invocation.markMutationStarted?.()
    }
    let timer: NodeJS.Timeout | undefined
    try {
      const loaded = await project(invocation.root)
      const route = invocation.route
      const persona = await readFile(resolve(config.deploymentRoot, loaded.roles[invocation.role]!.personaFile), 'utf8')
      const allowed = availableTools.get(parent)!
        .filter(name => route.writable || READ_TOOLS.includes(name))
      const timeout = new AbortController()
      timer = setTimeout(() => timeout.abort(new Error(`Engineering role ${invocation.role} timed out`)), config.roleTimeoutMs)
      const externalSignal = AbortSignal.any([invocation.signal, shutdown.signal])
      const signal = AbortSignal.any([externalSignal, timeout.signal])
      childrenByParent.add(parent.id)
      signal.throwIfAborted()
      const { signal: _signal, markMutationStarted: _markMutationStarted, ...payload } = invocation
      await previousStart
      signal.throwIfAborted()
      startingMutationObservers.set(parent.id, markMutationStarted)
      const run = await ctx.subagents.start('spawn', {
        parent, signal, label: `Engineering ${invocation.role}`, maxDepth: 1,
        persona: `${persona}\nOnly Implementer may write project source; .agent and .git are owned by the workflow driver.`,
        agentOptions: { provider: route.provider, model: route.model,
          ...route.reasoningEffort === 'off' ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }, maxTokens: route.maxTokens },
        toolFilter: { allow: allowed },
        outputSchema: invocation.outputSchema,
        prompt: [{ type: 'text', text: JSON.stringify(payload) }],
      })
      startingMutationObservers.delete(parent.id)
      started = true
      releaseStart()
      const result = await collectRole(run, invocation.role, route.provider, route.model, externalSignal, timeout.signal, () => mutationStarted)
      externalSignal.throwIfAborted()
      return result
    } finally {
      if (!started) {
        if (startingMutationObservers.get(parent.id) === markMutationStarted) startingMutationObservers.delete(parent.id)
        releaseStart()
      }
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  ctx.tools.register(defineTool({
    name: 'engineering_run',
    description: 'Implement or resume a development requirement in the current Session repository using isolated Scouts, Architect, Challenger, one Implementer, command verification and independent Reviewer. Returns authoritative acceptance or a concrete blocker.',
    parameters: {
      request: { type: 'string', description: 'Complete requirement for a new task, or changed scope for a task already in REPLAN. Omit when resuming.' },
      taskId: { type: 'string', description: 'Existing task identifier when explicitly resuming it. An empty string is treated as omitted for a new task.' },
    },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined || !coordinators.has(parent)) throw new Error('Only a top-level engineering Coordinator can run tasks')
      if (closing) throw new Error('Engineering profile is shutting down')
      const requestedTaskId = normalizeTaskId(args.taskId)
      const signal = AbortSignal.any([exec.signal, shutdown.signal])
      const repositoryIdentity = await realpath(workspace(parent))
      const root = repositoryIdentity
      const sessionId = parent.session.header.id
      const invocationId = engineeringInvocationId(sessionId, exec.callId, repositoryIdentity, exec.loggedCallSeq)
      let operation = activeInvocations.get(invocationId)
      if (operation === undefined) {
        const identity = { invocationId, sessionId, callId: exec.callId, repositoryIdentity, ...exec.loggedCallSeq === undefined ? {} : { loggedCallSeq: exec.loggedCallSeq } }
        let taskId = ''
        const blocked = (summary: string): EngineeringRunResult => ({
          status: 'BLOCKED', taskId, summary, nextAction: 'RECOVER', requiresStopConfirmation: true,
        })
        operation = Promise.resolve().then(async (): Promise<EngineeringRunResult> => withEngineeringInvocationLock(root, invocationId, async () => {
          try {
            let receipt = await readEngineeringInvocationReceipt(root, invocationId)
            if (receipt === undefined && exec.loggedCallSeq !== undefined) {
              const legacyId = engineeringInvocationId(sessionId, exec.callId, repositoryIdentity)
              const legacy = await readEngineeringInvocationReceipt(root, legacyId)
              if (legacy !== undefined) {
                taskId = legacy.schemaVersion === 1 || legacy.phase === 'COMPLETED' ? legacy.result.taskId : legacy.taskId ?? ''
                return blocked(`Legacy invocation ${legacyId}${taskId === '' ? '' : ` for task ${taskId}`} has no logged occurrence sequence and cannot safely map to invocation ${invocationId}. Do not start another task or reuse the legacy result automatically. Inspect engineering_status and the legacy receipt; confirm all owned work has stopped and ask an operator to reconcile the occurrence before explicit recovery.`)
              }
            }
            if (receipt === undefined) {
              if (!await claimEngineeringInvocation(root, { ...identity, schemaVersion: 2, phase: 'CLAIMED' })) {
                receipt = await readEngineeringInvocationReceipt(root, invocationId)
                if (receipt === undefined) throw new Error('Invocation claim disappeared; inspect the runtime receipt directory')
              }
            }
            if (receipt !== undefined) {
              if (receipt.schemaVersion === 1 || receipt.phase === 'COMPLETED') return receipt.result
              taskId = receipt.taskId ?? ''
              return blocked(`Invocation ${invocationId} was already claimed${taskId === '' ? ' before task binding' : ` for task ${taskId}`}. Do not start another task. Inspect engineering_status and the runtime receipt; confirm owned children and commands have stopped, then explicitly recover the bound task. If no task was bound, reconcile the claim with an operator before issuing a new invocation.`)
            }
            const result = await runEngineeringTask({
              root, deployment, request: args.request ?? '',
              ...requestedTaskId === undefined ? {} : { taskId: requestedTaskId }, signal,
              onTaskSelected: async selected => {
                if (taskId !== '' && taskId !== selected) throw new Error('Engineering invocation task identity changed')
                taskId = selected
                await writeEngineeringInvocationReceipt(root, { ...identity, schemaVersion: 2, phase: 'TASK_BOUND', taskId })
              },
              executeRole: invocation => executeRole(parent, invocation),
            })
            if (taskId !== '' && result.taskId !== taskId) throw new Error('Engineering invocation result task identity changed')
            taskId = result.taskId
            await writeEngineeringInvocationReceipt(root, { ...identity, schemaVersion: 2, phase: 'COMPLETED', taskId, result })
            return result
          } catch (error) {
            return blocked(`Invocation ${invocationId} failed closed: ${error instanceof Error ? error.message : String(error)}. Do not repeat engineering_run. Inspect the runtime receipt and engineering_status; confirm all owned work has stopped before operator recovery.`)
          }
        }).then(locked => {
          if (locked.acquired) return locked.value
          const activeReceipt = locked.receipt
          taskId = activeReceipt === undefined
            ? ''
            : activeReceipt.schemaVersion === 1 || activeReceipt.phase === 'COMPLETED'
              ? activeReceipt.result.taskId
              : activeReceipt.taskId ?? ''
          return {
            status: 'RUN_ALREADY_ACTIVE',
            taskId,
            summary: `Invocation ${invocationId} is owned by another process. Wait for that run to finish; do not start another task or recover its receipt while its owner holds the invocation lock.`,
            nextAction: 'WAIT_FOR_CURRENT_RUN',
          } satisfies EngineeringRunResult
        }).finally(() => {
          activeInvocations.delete(invocationId)
          running.delete(operation!)
        }))
        activeInvocations.set(invocationId, operation)
        running.add(operation)
      }
      return JSON.stringify(await operation)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'engineering_status', description: 'Read durable engineering task states in this Session repository without starting work.',
    parameters: { taskId: { type: 'string', description: 'Optional task identifier. An empty string is treated as omitted and lists all tasks.' } },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    async execute(args, exec) {
      if (exec.agent === undefined || !coordinators.has(exec.agent)) throw new Error('Engineering status requires a Coordinator')
      return JSON.stringify(await getEngineeringStatus(workspace(exec.agent), normalizeTaskId(args.taskId)))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'engineering_recover', description: 'Release interrupted work and explicitly replan one task, requiring stopped-work confirmation only when engineering_run requests it.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Exact interrupted task identifier.' },
      confirmedStopped: { type: 'boolean', required: true, description: 'Set true after stopped-work confirmation when engineering_run returns requiresStopConfirmation=true; otherwise set false.' },
    },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    async execute(args, exec) {
      if (exec.agent === undefined || !coordinators.has(exec.agent)) throw new Error('Engineering recovery requires a Coordinator')
      return JSON.stringify(await recoverEngineeringTask(workspace(exec.agent), args.taskId, args.confirmedStopped))
    },
  }))
  ctx.effect(() => async () => {
    closing = true
    shutdown.abort(new Error('Engineering profile unloaded'))
    await Promise.allSettled([...running])
    childrenByParent.clear()
  })
}

/**
 * Bind role authorization and dispatch to the provider bootstrap's configuration snapshot.
 * @param deployment - validated deployment used to configure the provider adapters.
 * @returns a Cordis plugin that does not reread routing files during activation or tasks.
 */
export function createEngineeringPlugin(deployment: HarnessConfig) {
  return { name, inject, Config, apply: (ctx: Context, config: Config) => applyDeployment(ctx, config, deployment) }
}

/**
 * Activate the standalone runtime from an explicit user deployment directory.
 * @param ctx - profile-owned plugin context.
 * @param config - deployment location and role deadline.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await applyDeployment(ctx, config, await loadHarnessConfig(config.deploymentRoot))
}
