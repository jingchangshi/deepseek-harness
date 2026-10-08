/** DSH tools that own automatic engineering runs and isolated role delegation. */

import { readFile, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import { POLICY_REFUSAL_CODE, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { loadHarnessConfig, resolveRoleRoute } from '../src/config.ts'
import type { HarnessConfig } from '../src/config.ts'
import { getEngineeringStatus, loadEngineeringProject, recoverEngineeringTask, runEngineeringTask } from '../src/automatic.ts'
import type { EngineeringRole, EngineeringRunResult, RoleInvocation } from '../src/automatic.ts'
import { runEngineeringReview } from '../src/review-only.ts'
import type { ReviewRunResult } from '../src/review-only.ts'
import type { GitEvidenceRepository, GitReviewTarget } from '../src/git-evidence.ts'
import { RoleInvocationError, RoleQuiescenceError, roleInvocationErrorForLlmCode, roleFailureAfterMutation } from '../src/role-execution.ts'
import { claimEngineeringInvocation, engineeringInvocationId, readEngineeringInvocationReceipt, withEngineeringInvocationLock, writeEngineeringInvocationReceipt } from '../src/invocation.ts'
import type { EngineeringRunInvocationId } from '../src/invocation.ts'
import { BudgetExhaustedError } from '../src/lifecycle.ts'
import type { RoleExecutionControl } from '../src/automatic.ts'
import type { InvestigationUnit } from '../src/investigation.ts'
import { runProfileEngineeringEvaluation } from './evaluation.ts'

export const name = 'engineering-harness'
export const inject = ['tools', 'subagents', 'systemPrompt']

/** Fixed deployment source and bounded lifetime of each role invocation. */
export interface Config {
  deploymentRoot: string
  roleTimeoutMs: number
  evaluation?: { strongRouteId: string; cheapRouteId: string }
}

export const Config: z<Config> = z.object({
  deploymentRoot: z.string().required(),
  roleTimeoutMs: z.number().min(1).step(1).default(1_200_000),
  evaluation: z.object({ strongRouteId: z.string(), cheapRouteId: z.string() }),
})

const COORDINATOR_TOOLS = ['engineering_run', 'engineering_review', 'engineering_status', 'engineering_recover', 'engineering_evaluate', 'get_goal', 'update_goal']
const READ_TOOLS = ['read', 'read_image', 'glob', 'grep', 'lsp', 'web_fetch', 'web_search', 'spill_read']
const GIT_REVIEW_TOOLS = ['git_snapshot', 'git_changed_files', 'git_diff', 'git_show', 'git_history']
const activeInvocations = new Map<EngineeringRunInvocationId, Promise<EngineeringRunResult>>()
const activeReviews = new Map<EngineeringRunInvocationId, Promise<ReviewRunResult>>()
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
 * Match a successful `read` value to the current local file before issuing source evidence.
 * @param root - canonical workspace root.
 * @param requestedPath - path passed to the `read` tool.
 * @param value - canonical structured result returned by the tool body.
 * @returns the matched repository path and full-file hash, or `undefined` for stale, remote, or incomplete output.
 */
export async function inspectionHashForReadResult(
  root: string,
  requestedPath: string,
  value: unknown,
): Promise<{ path: string; contentHash: string } | undefined> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = value as Record<string, unknown>
  if (typeof result.path !== 'string' || typeof result.offset !== 'number' || !Number.isInteger(result.offset) || result.offset < 1
    || typeof result.totalLines !== 'number' || !Number.isInteger(result.totalLines) || result.totalLines < 0
    || !Array.isArray(result.lines) || result.lines.length === 0) return undefined
  const requestedCandidate = resolve(root, requestedPath)
  if (!within(root, requestedCandidate)) return undefined
  const requested = await realpath(requestedCandidate)
  const reportedPath = resolve(root, result.path)
  if (!within(root, reportedPath)) return undefined
  let reported: string
  try {
    reported = await realpath(reportedPath)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    throw error
  }
  if (reported !== requested) return undefined
  const bytes = await readFile(requested)
  const text = bytes.toString('utf8')
  const currentLines = text.split('\n')
  if (currentLines.at(-1) === '') currentLines.pop()
  const normalizedLines = currentLines.map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
  if (result.totalLines !== normalizedLines.length) return undefined
  let previousLine = result.offset - 1
  for (const line of result.lines) {
    if (line === null || typeof line !== 'object' || Array.isArray(line)) return undefined
    const entry = line as Record<string, unknown>
    if (typeof entry.number !== 'number' || !Number.isInteger(entry.number) || typeof entry.text !== 'string') return undefined
    const number = entry.number
    if (number !== previousLine + 1 || normalizedLines[number - 1] !== entry.text) return undefined
    previousLine = number
  }
  return { path: requested, contentHash: createHash('sha256').update(bytes).digest('hex') }
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
    const cause = executionError === undefined
      ? error
      : new AggregateError([executionError, error], 'Role execution and cleanup failed')
    throw new RoleQuiescenceError(`Role ${role} via ${provider}/${model} cleanup failed: ${cleanup}`, { cause })
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
async function applyDeployment(ctx: Context, config: Config, deployment: HarnessConfig, adapterAccounting?: { cacheOmission: 'zero'; inputAccounting: 'exclusive' }): Promise<void> {
  if (config.evaluation !== undefined && (config.evaluation.strongRouteId === undefined) !== (config.evaluation.cheapRouteId === undefined)) throw new Error('Evaluation requires both strong and cheap route IDs')
  const shutdown = new AbortController()
  const running = new Set<Promise<unknown>>()
  const availableTools = new WeakMap<Agent, string[]>()
  const coordinators = new WeakSet<Agent>()
  const children = new WeakSet<Agent>()
  const startingMutationObservers = new Map<string, () => void>()
  const startingReviewEvidence = new Map<string, GitEvidenceRepository>()
  const reviewEvidenceByAgent = new WeakMap<Agent, GitEvidenceRepository>()
  const startingExecution = new Map<string, { control: RoleExecutionControl; unit?: InvestigationUnit; budget: AbortController }>()
  const executions = new WeakMap<Agent, { control: RoleExecutionControl; unit?: InvestigationUnit; budget: AbortController }>()
  const executionsBySession = new Map<string, { control: RoleExecutionControl; unit?: InvestigationUnit; budget: AbortController }>()
  const executionIds = new Map<symbol, string>()
  const sessionRequests = new Map<string, string[]>()
  const sessionAudits = new Map<string, Promise<void>>()

  const executionId = (exec: ToolExecution): string => {
    let id = executionIds.get(exec.token)
    if (id === undefined) {
      id = exec.agent !== undefined && exec.loggedCallSeq !== undefined ? `${exec.agent.session.id}:${exec.loggedCallSeq}:${exec.callId}` : randomUUID()
      executionIds.set(exec.token, id)
    }
    return id
  }

  ctx.on('llm/pre-dispatch', async dispatch => {
    const execution = dispatch.options.sessionId === undefined ? undefined : executionsBySession.get(dispatch.options.sessionId)
    if (execution === undefined) return
    const route = deployment.routes[execution.control.routeId]
    const accounting = route !== undefined && route.provider === dispatch.options.provider && route.model === dispatch.options.model ? route : undefined
    try {
      await execution.control.lifecycle.reserveProviderRequest(execution.control.attemptId, dispatch.requestId, {
        provider: dispatch.options.provider, model: dispatch.options.model, routeId: execution.control.routeId,
        ...(accounting?.pricing === undefined ? {} : { pricing: accounting.pricing }),
        ...(adapterAccounting === undefined ? accounting?.cacheOmission === undefined ? {} : { cacheOmission: accounting.cacheOmission } : { cacheOmission: adapterAccounting.cacheOmission }),
        ...(adapterAccounting === undefined ? accounting?.inputAccounting === undefined ? {} : { inputAccounting: accounting.inputAccounting } : { inputAccounting: adapterAccounting.inputAccounting }),
        purpose: dispatch.options.purpose === 'compaction' ? 'compaction' : dispatch.options.purpose === undefined ? 'agent' : 'other',
        ...(dispatch.options.sessionId === undefined ? {} : { sessionId: dispatch.options.sessionId }),
      })
    } catch (error) {
      if (error instanceof BudgetExhaustedError) execution.budget.abort(error)
      throw error
    }
  })
  ctx.on('tools/result', exec => { executionIds.delete(exec.token) })
  ctx.effect(() => () => { executionIds.clear() })
  ctx.on('llm/post-dispatch', async dispatch => {
    const execution = dispatch.options.sessionId === undefined ? undefined : executionsBySession.get(dispatch.options.sessionId)
    if (execution === undefined) return
    await execution.control.lifecycle.settleProviderRequest(dispatch.requestId, {
      startedAt: dispatch.startedAt, endedAt: dispatch.endedAt, outcome: dispatch.outcome,
      ...(dispatch.usage === undefined ? {} : { usage: dispatch.usage }),
    })
    if (dispatch.options.sessionId !== undefined && dispatch.options.purpose === undefined) {
      const requests = sessionRequests.get(dispatch.options.sessionId) ?? []
      requests.push(dispatch.requestId)
      sessionRequests.set(dispatch.options.sessionId, requests)
    }
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
    const execution = executionsBySession.get(session.id)
    const requestId = sessionRequests.get(session.id)?.shift()
    if (execution === undefined || requestId === undefined) return
    const previous = sessionAudits.get(session.id) ?? Promise.resolve()
    const pending = previous.then(() => execution.control.lifecycle.reconcileSessionUsage(requestId, {
      sessionId: session.id, eventSeq: event.seq,
      ...(event.type === 'assistant/message' && event.data.usage !== undefined ? { usage: event.data.usage } : {}),
    }))
    sessionAudits.set(session.id, pending)
    void pending.catch(error => execution.budget.abort(error))
  })
  ctx.on('session/flush', async session => { await sessionAudits.get(session.id) })
  ctx.on('session/disposed', session => { sessionRequests.delete(session.id); sessionAudits.delete(session.id) })
  const childrenByParent = new Set<string>()
  let closing = false
  let roleStartTail = Promise.resolve()

  function gitEvidence(agent: Agent | undefined): GitEvidenceRepository {
    const evidence = agent === undefined ? undefined : reviewEvidenceByAgent.get(agent)
    if (evidence === undefined) throw new Error('Git evidence tools require a Review-only child with a pinned snapshot')
    return evidence
  }

  const gitOutput = { schema: { type: 'string' as const }, render: (_args: unknown, result: string) => [{ type: 'text' as const, text: result }] }
  const offset = { type: 'integer' as const, description: 'Zero-based page offset returned by the preceding result.' }
  const limit = { type: 'integer' as const, description: 'Maximum page size; output completeness reports continuation.' }
  ctx.tools.register(defineTool({
    name: 'git_snapshot', sideEffects: 'read-only', description: 'Read the immutable repository, base and target commit identities bound to this Review-only child.',
    parameters: {}, output: gitOutput,
    execute: async (_args, exec) => JSON.stringify(gitEvidence(exec.agent).snapshot),
  }))
  ctx.tools.register(defineTool({
    name: 'git_changed_files', sideEffects: 'read-only', description: 'List a page of changed paths and statuses in the pinned Git snapshot.',
    parameters: { offset, limit }, output: gitOutput,
    execute: async (args, exec) => JSON.stringify(await gitEvidence(exec.agent).changedFiles(args, exec.signal)),
  }))
  ctx.tools.register(defineTool({
    name: 'git_diff', sideEffects: 'read-only', description: 'Read a page of a pinned file diff. Cite evidenceId and follow completeness.nextOffset until the scope is inspected.',
    parameters: { path: { type: 'string', required: true, description: 'Repository-relative changed path.' }, offset, limit }, output: gitOutput,
    execute: async (args, exec) => JSON.stringify(await gitEvidence(exec.agent).diff(args, exec.signal)),
  }))
  ctx.tools.register(defineTool({
    name: 'git_show', sideEffects: 'read-only', description: 'Read pinned new-version source lines. Cite evidenceId, commit and line numbers; binary content is explicitly marked.',
    parameters: { path: { type: 'string', required: true, description: 'Repository-relative source path.' },
      startLine: { type: 'integer', description: 'First source line, starting at one.' },
      lineCount: { type: 'integer', description: 'Maximum source lines returned.' } }, output: gitOutput,
    execute: async (args, exec) => JSON.stringify(await gitEvidence(exec.agent).show(args, exec.signal)),
  }))
  ctx.tools.register(defineTool({
    name: 'git_history', sideEffects: 'read-only', description: 'Read a page of commit ancestry fixed at the review target.',
    parameters: { offset, limit }, output: gitOutput,
    execute: async (args, exec) => JSON.stringify(await gitEvidence(exec.agent).history(args, exec.signal)),
  }))

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') childEndReasons.set(session, event.data.reason)
  })

  async function project(root: string) {
    await loadEngineeringProject(root)
    return deployment
  }

  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) {
      if (childrenByParent.has(agent.session.header.parentSession)) {
        children.add(agent)
        agent.ctx.tools.presentAs('native')
        const evidence = startingReviewEvidence.get(agent.session.header.parentSession)
        const execution = startingExecution.get(agent.session.header.parentSession)
        if (execution !== undefined) {
          executions.set(agent, execution)
          executionsBySession.set(agent.session.id, execution)
          agent.ctx.effect(() => () => { executionsBySession.delete(agent.session.id); executions.delete(agent) })
        }
        if (evidence !== undefined) reviewEvidenceByAgent.set(agent, evidence)
        const observer = startingMutationObservers.get(agent.session.header.parentSession)
        if (observer !== undefined) {
          agent.ctx.tools.observeBodyStart((_exec, sideEffects) => {
            if (execution !== undefined) {
              try { execution.control.markBodyStart() }
              catch (error) { if (error instanceof BudgetExhaustedError) execution.budget.abort(error); throw error }
            }
            if (evidence !== undefined && sideEffects !== 'read-only') {
              throw new Error('Review-only children may only execute tools with explicit read-only effects')
            }
            if (sideEffects === 'potentially-mutating') observer()
          })
        }
      }
      return
    }
    const root = workspace(agent)
    const loaded = await project(root)
    const persona = await readFile(resolve(config.deploymentRoot, loaded.roles.coordinator!.personaFile), 'utf8')
    shutdown.signal.throwIfAborted()
    availableTools.set(agent, [...READ_TOOLS, ...GIT_REVIEW_TOOLS, ...WRITE_TOOLS, ...SHELL_TOOLS].filter(name => agent.ctx.tools.get(name, agent) !== undefined))
    coordinators.add(agent)
    ctx.effect(() => agent.ctx.systemPrompt.section({
      name: 'engineering:coordinator', order: 1, interpolate: false,
      text: `${persona}\nFor Review-only, PR review, commit review or branch review, call engineering_review with the requested local Git target; never start an Implementer or engineering_run for that intent. For a new development request, call engineering_run with the complete user requirement and no taskId. This tool owns investigation, planning, implementation, verification, review and acceptance. For progress or resumption, first use engineering_status, then call engineering_run with only the returned taskId and omit request. Supply both taskId and request only to change scope after the task explicitly enters REPLAN. Respect engineering_run.nextAction: WAIT_FOR_CURRENT_RUN means do not start another run; REPLAN_WITH_SCOPE means ask only for missing product/scope information; RECOVER means do not repeat engineering_run unchanged and call engineering_recover; INCREASE_BUDGET means stop dispatching and request an operator increase to the exhausted deployment budget before recovery. Obtain operator confirmation that previous agent and command work stopped only when requiresStopConfirmation is true. Ask only for missing product decisions. Do not ask users to run agentctl or manage revisions, artifacts, or writer tokens. Report ACCEPTED only when the tool returns that state.`,
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
    const execution = exec.agent === undefined ? undefined : executions.get(exec.agent)
    if (execution !== undefined) {
      try { await execution.control.reserveToolCall(executionId(exec)) }
      catch (error) { if (error instanceof BudgetExhaustedError) execution.budget.abort(error); throw error }
      if (execution.unit !== undefined && ['read', 'read_image', 'grep', 'glob', 'lsp'].includes(exec.name)) {
        const args = exec.arguments
        const path = args !== null && typeof args === 'object' ? 'file_path' in args ? args.file_path : 'path' in args ? args.path : undefined : undefined
        if (typeof path !== 'string') throw new Error('Investigation code tools require an explicit path inside the assigned work unit')
        const absolute = await realpath(resolve(workspace(exec.agent!), path))
        const local = relative(await realpath(workspace(exec.agent!)), absolute).split(sep).join('/')
        const contextAllowed = (local.startsWith(`.agent/tasks/${execution.control.taskId}/`) || local.startsWith(`.agent/reviews/${execution.control.taskId}/`)) && /\/(?:CONTEXT|REQUEST)-[^/]+\.json$/.test(local)
        if (!contextAllowed && !execution.unit.allowedPaths.some(scope => local === scope || local.startsWith(`${scope}/`))) throw new Error(`Investigation path is outside the assigned scope: ${path}`)
      }
      if (execution.unit !== undefined && (exec.name === 'git_show' || exec.name === 'git_diff')) {
        const args = exec.arguments
        const path = args !== null && typeof args === 'object' && 'path' in args ? args.path : undefined
        if (typeof path !== 'string' || !execution.unit.allowedPaths.includes(path)) throw new Error('Review Scout Git path is outside the assigned work unit')
      }
    }
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

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const execution = exec.agent === undefined ? undefined : executions.get(exec.agent)
    if (decision.kind !== 'accept' || decision.value !== undefined || decision.content !== undefined) return decision
    if (execution !== undefined && !result.isError && (exec.name === 'git_show' || exec.name === 'git_diff')) {
      if (typeof result.value !== 'string') throw new Error('Git evidence tool result must contain its JSON receipt')
      const page: unknown = JSON.parse(result.value)
      if (page === null || typeof page !== 'object' || !('evidenceId' in page) || !('path' in page) || !('contentHash' in page)
        || typeof page.evidenceId !== 'string' || typeof page.path !== 'string' || typeof page.contentHash !== 'string') throw new Error('Git evidence tool result is missing its inspection fields')
      await execution.control.recordInspection({ executionId: executionId(exec), evidenceId: page.evidenceId, path: page.path, contentHash: page.contentHash, toolName: exec.name })
    }
    if (execution !== undefined && !result.isError && exec.name === 'read') {
      const args = exec.arguments
      const path = args !== null && typeof args === 'object' ? 'file_path' in args ? args.file_path : 'path' in args ? args.path : undefined : undefined
      if (typeof path === 'string') {
        const root = await realpath(workspace(exec.agent!))
        const receipt = await inspectionHashForReadResult(root, path, result.value)
        if (receipt !== undefined) {
          const local = relative(root, receipt.path).split(sep).join('/')
          if (execution.unit?.allowedPaths.some(scope => local === scope || local.startsWith(`${scope}/`))) {
            await execution.control.recordInspection({ executionId: executionId(exec), path: local, toolName: exec.name, contentHash: receipt.contentHash })
          }
        }
      }
    }
    return decision
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
    let softTimer: NodeJS.Timeout | undefined
    let lifetimeTimer: NodeJS.Timeout | undefined
    let lifetimeStopped = false
    try {
      const loaded = await project(invocation.root)
      const route = invocation.route
      const persona = await readFile(resolve(config.deploymentRoot, loaded.roles[invocation.role]!.personaFile), 'utf8')
      if (invocation.reviewEvidence !== undefined && route.writable) throw new Error('Review-only roles must remain read-only')
      const allowed = availableTools.get(parent)!
        .filter(name => invocation.reviewEvidence !== undefined ? GIT_REVIEW_TOOLS.includes(name) || READ_TOOLS.includes(name) : route.writable || READ_TOOLS.includes(name))
      const timeout = new AbortController()
      const budget = new AbortController()
      const scheduleLifetime = async (): Promise<void> => {
        const remainingLifetime = await invocation.executionControl?.lifecycle.remainingElapsedMs()
        if (!lifetimeStopped && remainingLifetime !== undefined) {
          lifetimeTimer = setTimeout(() => { void scheduleLifetime().catch(error => budget.abort(error)) }, Math.min(remainingLifetime, 2_147_483_647))
        }
      }
      await scheduleLifetime()
      const elapsed = invocation.executionControl === undefined ? 0 : Math.max(0, Date.now() - Date.parse(invocation.executionControl.startedAt))
      const hardDeadline = Math.min(config.roleTimeoutMs, invocation.executionControl?.bounds.hardDeadlineMs ?? config.roleTimeoutMs)
      timer = setTimeout(() => timeout.abort(new Error(`Engineering role ${invocation.role} timed out`)), Math.max(0, hardDeadline - elapsed))
      const externalSignal = AbortSignal.any([invocation.signal, shutdown.signal])
      const signal = AbortSignal.any([externalSignal, timeout.signal, budget.signal])
      childrenByParent.add(parent.id)
      signal.throwIfAborted()
      const { signal: _signal, markMutationStarted: _markMutationStarted, reviewEvidence, executionControl, ...payload } = invocation
      await previousStart
      signal.throwIfAborted()
      startingMutationObservers.set(parent.id, markMutationStarted)
      if (executionControl !== undefined) startingExecution.set(parent.id, { control: executionControl, ...(invocation.workUnit === undefined ? {} : { unit: invocation.workUnit }), budget })
      if (reviewEvidence !== undefined) startingReviewEvidence.set(parent.id, reviewEvidence)
      const run = await ctx.subagents.start('spawn', {
        parent, signal, label: `Engineering ${invocation.role}`, maxDepth: 1,
        persona: `${persona}\nOnly Implementer may write project source; .agent and .git are owned by the workflow driver.${reviewEvidence === undefined ? '' : '\nThis is Review-only. Inspect the pinned Git snapshot with git_show and git_diff. Cite returned evidenceId values in the required review output. Report unresolved scope explicitly. Do not use development decision or plan fields.'}`,
        agentOptions: { provider: route.provider, model: route.model,
          ...route.reasoningEffort === 'off' ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }, maxTokens: route.maxTokens },
        toolFilter: { allow: allowed },
        outputSchema: invocation.outputSchema,
        prompt: [{ type: 'text', text: JSON.stringify(payload) }],
      })
      startingMutationObservers.delete(parent.id)
      startingReviewEvidence.delete(parent.id)
      startingExecution.delete(parent.id)
      started = true
      releaseStart()
      if (executionControl !== undefined) {
        softTimer = setTimeout(() => {
          if (run.localAgent !== undefined && !signal.aborted) run.localAgent.inject(createUserMessage({ content: [{ type: 'text', text: 'The investigation soft deadline has arrived. Return a structured handoff containing only evidence actually obtained and explicit unresolved questions. Do not start broad new investigation.' }], source: { kind: 'user' } }))
          void executionControl.checkpoint().catch(error => budget.abort(error))
        }, Math.max(0, executionControl.bounds.softDeadlineMs - elapsed))
      }
      let result: unknown
      try {
        result = await collectRole(run, invocation.role, route.provider, route.model, externalSignal, timeout.signal, () => mutationStarted)
      } catch (error) {
        if (error instanceof RoleQuiescenceError) throw error
        if (budget.signal.reason instanceof BudgetExhaustedError) throw budget.signal.reason
        throw error
      }
      if (budget.signal.aborted) throw budget.signal.reason
      externalSignal.throwIfAborted()
      return result
    } finally {
      if (!started) {
        if (startingMutationObservers.get(parent.id) === markMutationStarted) startingMutationObservers.delete(parent.id)
        if (startingReviewEvidence.get(parent.id) === invocation.reviewEvidence) startingReviewEvidence.delete(parent.id)
        startingExecution.delete(parent.id)
        releaseStart()
      }
      if (timer !== undefined) clearTimeout(timer)
      if (softTimer !== undefined) clearTimeout(softTimer)
      lifetimeStopped = true
      if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer)
    }
  }

  if (config.evaluation !== undefined && config.evaluation.strongRouteId !== undefined && config.evaluation.cheapRouteId !== undefined) {
    const evaluation = config.evaluation
    for (const routeId of [evaluation.strongRouteId, evaluation.cheapRouteId]) {
      if (deployment.routes[routeId] === undefined) throw new Error(`Unknown evaluation route: ${routeId}`)
    }
    ctx.tools.register(defineTool({
      name: 'engineering_evaluate', description: 'Run one immutable evaluation fixture through four deployment-selected strategies and independent acceptance checks.',
      parameters: { caseId: { type: 'string', required: true, enum: ['pebble-mul', 'mlir-pass', 'review-overflow', 'recovery-latch'] } },
      output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
      async execute(args, exec) {
        const parent = exec.agent
        if (parent === undefined || !coordinators.has(parent)) throw new Error('Evaluation requires an engineering Coordinator')
        if (closing) throw new Error('Engineering profile is shutting down')
        const operation = runProfileEngineeringEvaluation({
          checkout: resolve(import.meta.dirname, '../../..'), deployment, ...evaluation, caseId: args.caseId,
          executeRole: invocation => executeRole(parent, { ...invocation, signal: AbortSignal.any([invocation.signal, exec.signal, shutdown.signal]) }),
        })
        running.add(operation)
        try { return JSON.stringify(await operation) }
        finally { running.delete(operation) }
      },
    }))
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
            if (receipt?.schemaVersion === 3) throw new Error('Review-only receipt cannot resume Development')
            if (receipt === undefined && exec.loggedCallSeq !== undefined) {
              const legacyId = engineeringInvocationId(sessionId, exec.callId, repositoryIdentity)
              const legacy = await readEngineeringInvocationReceipt(root, legacyId)
              if (legacy?.schemaVersion === 3) throw new Error('Review-only receipt cannot resume Development')
              if (legacy !== undefined) {
                taskId = legacy.schemaVersion === 1 || legacy.phase === 'COMPLETED' ? legacy.result.taskId : legacy.taskId ?? ''
                return blocked(`Legacy invocation ${legacyId}${taskId === '' ? '' : ` for task ${taskId}`} has no logged occurrence sequence and cannot safely map to invocation ${invocationId}. Do not start another task or reuse the legacy result automatically. Inspect engineering_status and the legacy receipt; confirm all owned work has stopped and ask an operator to reconcile the occurrence before explicit recovery.`)
              }
            }
            if (receipt === undefined) {
              if (!await claimEngineeringInvocation(root, { ...identity, schemaVersion: 2, phase: 'CLAIMED' })) {
                receipt = await readEngineeringInvocationReceipt(root, invocationId)
                if (receipt?.schemaVersion === 3) throw new Error('Review-only receipt cannot resume Development')
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
          if (activeReceipt?.schemaVersion === 3) throw new Error('Review-only receipt cannot resume Development')
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
    name: 'engineering_review', description: 'Review a pinned local Git commit, branch tip, commit range or resolvable local PR without an Implementer. Completion requires observed evidence for the complete changed scope.',
    parameters: {
      targetKind: { type: 'string', enum: ['commit', 'branch', 'range', 'pr'], required: true, description: 'Selector type; PR uses an existing local refs/pull/<number>/head.' },
      target: { type: 'string', required: true, description: 'Full commit SHA or HEAD; local branch; baseSHA..targetSHA range; or local PR number.' },
      base: { type: 'string', description: 'Optional full base commit SHA; required for local PR. Omit for the selected commit parent.' },
      taskId: { type: 'string', description: 'Resume a review with its persisted snapshot; supplied target must match its original selector.' },
    },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined || !coordinators.has(parent)) throw new Error('Only a top-level engineering Coordinator can review changes')
      if (closing) throw new Error('Engineering profile is shutting down')
      const root = await realpath(workspace(parent))
      const invocationId = engineeringInvocationId(parent.session.header.id, exec.callId, root, exec.loggedCallSeq, 'review-only')
      let operation = activeReviews.get(invocationId)
      if (operation === undefined) {
        const identity = { invocationId, sessionId: parent.session.header.id, callId: exec.callId, repositoryIdentity: root,
          ...exec.loggedCallSeq === undefined ? {} : { loggedCallSeq: exec.loggedCallSeq }, schemaVersion: 3 as const, workflow: 'review-only' as const }
        let target: GitReviewTarget
        if (args.targetKind === 'range') target = { kind: 'range', target: args.target }
        else if (args.targetKind === 'commit' || args.targetKind === 'branch' || args.targetKind === 'pr') {
          target = { kind: args.targetKind, target: args.target, ...args.base === undefined ? {} : { base: args.base } }
        } else throw new Error('Unsupported Review-only target kind')
        const taskId = normalizeTaskId(args.taskId)
        operation = Promise.resolve().then(async () => {
          const locked = await withEngineeringInvocationLock(root, invocationId, async () => {
            const receipt = await readEngineeringInvocationReceipt(root, invocationId)
            if (receipt !== undefined) {
              if (receipt.schemaVersion !== 3) throw new Error('Development receipt cannot resume Review-only')
              if (receipt.phase === 'COMPLETED') return receipt.result
              throw new Error(`Review invocation ${invocationId} was already claimed. Inspect its persisted review and confirm all child work stopped before explicit recovery.`)
            }
            if (!await claimEngineeringInvocation(root, { ...identity, phase: 'CLAIMED' })) throw new Error('Review invocation is already claimed')
            const result = await runEngineeringReview({ root, deployment, target,
              ...taskId === undefined ? {} : { taskId },
              signal: AbortSignal.any([exec.signal, shutdown.signal]),
              executeRole: invocation => executeRole(parent, invocation),
              onTaskSelected: taskId => writeEngineeringInvocationReceipt(root, { ...identity, phase: 'TASK_BOUND', taskId }),
            })
            await writeEngineeringInvocationReceipt(root, { ...identity, phase: 'COMPLETED', taskId: result.taskId, result })
            return result
          })
          if (!locked.acquired) throw new Error(`Review invocation ${invocationId} is owned by another process; wait for its result`)
          return locked.value
        }).finally(() => {
          activeReviews.delete(invocationId)
          running.delete(operation!)
        })
        activeReviews.set(invocationId, operation)
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
 * @param adapterAccounting - counter semantics declared by the provider bootstrap's adapter.
 * @returns a Cordis plugin that does not reread routing files during activation or tasks.
 */
export function createEngineeringPlugin(deployment: HarnessConfig, adapterAccounting?: { cacheOmission: 'zero'; inputAccounting: 'exclusive' }) {
  return { name, inject, Config, apply: (ctx: Context, config: Config) => applyDeployment(ctx, config, deployment, adapterAccounting) }
}

/**
 * Activate the standalone runtime from an explicit user deployment directory.
 * @param ctx - profile-owned plugin context.
 * @param config - deployment location and role deadline.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await applyDeployment(ctx, config, await loadHarnessConfig(config.deploymentRoot))
}
