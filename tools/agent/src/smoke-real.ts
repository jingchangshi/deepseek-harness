/** Deployment-backed model route qualification through the pinned headless profile. */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SCHEMA, dump, load, Type } from 'js-yaml'
import type { HarnessConfig, ResolvedRoleRoute } from './config.ts'
import { resolveRoleFallbackRoutes, resolveRoleRoute } from './config.ts'
import { roleInvocationErrorForLlmCode } from './role-execution.ts'
import type { ModelSmokeResult } from './smoke.ts'
import type { CheckStatus } from './types.ts'
import { providerOptions } from '../runtime/bootstrap.ts'

/** One tool execution recovered from a durable Session, bound to its owning Session and call. */
export interface ToolEvidence {
  sessionId: string
  callId: string
  name: string
  ok: boolean
}

/** Safe provider failure facts projected from a durable Session event. */
export interface SessionFailureEvidence {
  sessionId: string
  source: 'llm/retry' | 'turn/end'
  code: string
  status?: number
}

/** Durable Session records recovered from one pinned-profile process. */
export interface SessionEvidence {
  /** Sessions this process wrote, in discovery order. */
  sessions: string[]
  /** Every Session whose header names `parentSession` set to an existing Session. */
  childSessions: string[]
  /** Sessions that are neither a child nor a parent of another Session in this run. */
  rootSessions: string[]
  tools: ToolEvidence[]
  routes: Array<{ sessionId: string; provider: string; model: string; reasoningEffort?: string }>
  failures: SessionFailureEvidence[]
  /** Last committed assistant text per Session, used to prove the child answered. */
  finalTexts: Array<{ sessionId: string; text: string }>
}

/** Evidence extracted from one real pinned-profile process. */
export interface RealSmokeEvidence {
  exitCode: number | null
  timedOut: boolean
  finalText: string
  sessions: SessionEvidence
  diagnostic: string
}

/** Injectable process runner for real-route qualification tests. */
export type RealSmokeExecutor = (
  role: string,
  route: ResolvedRoleRoute,
  coordinator: ResolvedRoleRoute,
) => Promise<RealSmokeEvidence>

interface ProcessResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

const PLACEHOLDER = /^\$\{([A-Z][A-Z0-9_]*)\}$/
const REQUIRED_CHECKS = [
  'provider-resolves',
  'model-resolves',
  'reasoning-routed',
  'completion',
  'tool-use',
  'subagent',
  'bounded-cancellation',
  'route-diagnostic',
] as const

function missingDeploymentValues(config: HarnessConfig, route: ResolvedRoleRoute, env: NodeJS.ProcessEnv): string[] {
  const modelRoute = config.routes[route.routeId]
  const provider = modelRoute === undefined ? undefined : config.providers[modelRoute.provider]
  const missing: string[] = []
  const inspect = (value: string | undefined, label: string): void => {
    if (value === undefined || value.trim().length === 0) missing.push(label)
    else {
      const placeholder = PLACEHOLDER.exec(value)
      if (placeholder !== null) missing.push(placeholder[1] ?? label)
    }
  }
  inspect(route.model, `${route.role}.model`)
  if (route.reasoningEffort !== 'off') inspect(modelRoute?.reasoningEfforts[route.reasoningEffort] ?? undefined, `${route.role}.reasoningEffort`)
  inspect(provider?.baseURL, `${route.role}.baseURL`)
  inspect(provider?.api, `${route.role}.api`)
  inspect(provider?.apiKeyEnv, `${route.role}.apiKeyEnv`)
  if (provider !== undefined && (env[provider.apiKeyEnv] ?? '').trim().length === 0) missing.push(provider.apiKeyEnv)
  return [...new Set(missing)]
}

function jsonObjects(text: string): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        values.push(Object.fromEntries(Object.entries(value)))
      }
    } catch {
      // Non-JSON diagnostics stay in the returned process diagnostic.
    }
  }
  return values
}

/**
 * Extract the terminal assistant output from a headless `--json` event stream.
 * @param events - parsed top-level JSONL records emitted by the CLI.
 * @returns the terminal output, or an empty string when the process did not emit a final record.
 */
export function extractHeadlessResult(events: Record<string, unknown>[]): string {
  const output = events.findLast(event => event.type === 'final')?.text
  return typeof output === 'string' ? output : ''
}

function field(value: Record<string, unknown>, name: string): unknown {
  return value[name]
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}

function nestedRecord(value: unknown, name: string): Record<string, unknown> | undefined {
  return objectRecord(objectRecord(value)?.[name])
}

async function readSessionLogs(root: string): Promise<Array<{ sessionId: string; header: Record<string, unknown>; events: Record<string, unknown>[] }>> {
  const logs: Array<{ sessionId: string; header: Record<string, unknown>; events: Record<string, unknown>[] }> = []
  const visit = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { await visit(path); continue }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const events = jsonObjects(await readFile(path, 'utf8'))
      const header = events.find(event => field(event, 'type') === 'session')
      if (header === undefined) continue
      const id = header.id
      if (typeof id !== 'string') continue
      logs.push({ sessionId: id, header, events })
    }
  }
  await visit(root)
  return logs
}

/** The last committed assistant text of one Session, concatenated from its text blocks. */
function assistantAnswerText(events: Record<string, unknown>[]): string {
  const assistant = events.filter(event => field(event, 'type') === 'assistant/message').at(-1)
  const data = assistant === undefined ? undefined : nestedRecord(assistant, 'data')
  const message = data === undefined ? undefined : Reflect.get(data, 'message')
  const blocks = typeof message === 'object' && message !== null ? Reflect.get(message, 'content') : undefined
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(block => typeof block === 'object' && block !== null && Reflect.get(block, 'type') === 'text')
    .map(block => Reflect.get(block as object, 'text'))
    .filter(part => typeof part === 'string')
    .join('')
}

function failureEvidence(sessionId: string, source: SessionFailureEvidence['source'], failure: Record<string, unknown>): SessionFailureEvidence {
  const candidate = failure.code
  const code = typeof candidate === 'string' && roleInvocationErrorForLlmCode(candidate, '') !== undefined
    ? candidate
    : 'UNKNOWN'
  const status = failure.status
  return {
    sessionId,
    source,
    code,
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
  }
}

/**
 * Correlate durable Session evidence across parent and delegated child Sessions.
 *
 * A delegated child records `parentSession` in its Session header, so the
 * parent/child relation is recovered from the logs themselves. A tool result
 * pairs only with a call of the same Session and call id: two Sessions can
 * mint the same call id, and a global name set cannot tell which Session ran
 * the tool.
 * @param logs - durable Session logs written by one pinned-profile process.
 * @returns sessions, the child/root split, and tool evidence bound to each Session.
 */
export function correlateSessionEvidence(logs: Array<{ sessionId: string; header: Record<string, unknown>; events: Record<string, unknown>[] }>): SessionEvidence {
  const ids = new Set(logs.map(log => log.sessionId))
  const childSessions: string[] = []
  for (const log of logs) {
    const parent = log.header.parentSession
    if (typeof parent === 'string' && ids.has(parent)) childSessions.push(log.sessionId)
  }
  const children = new Set(childSessions)
  const tools: ToolEvidence[] = []
  const routes: SessionEvidence['routes'] = []
  const failures: SessionEvidence['failures'] = []
  const finalTexts: SessionEvidence['finalTexts'] = []
  for (const log of logs) {
    const text = assistantAnswerText(log.events)
    if (text.length > 0) finalTexts.push({ sessionId: log.sessionId, text })
  }
  for (const log of logs) {
    for (const event of log.events) {
      const data = nestedRecord(event, 'data')
      if (data === undefined) continue
      const type = field(event, 'type')
      if (type === 'llm/retry') {
        const failure = nestedRecord(data, 'failure')
        if (failure !== undefined) failures.push(failureEvidence(log.sessionId, 'llm/retry', failure))
        continue
      }
      if (type === 'turn/end') {
        const reason = nestedRecord(data, 'reason')
        const failure = reason?.kind === 'error' ? objectRecord(reason.error) : undefined
        if (failure !== undefined) failures.push(failureEvidence(log.sessionId, 'turn/end', failure))
        continue
      }
      if (type === 'request/header') {
        const header = nestedRecord(data, 'header')
        const config = header === undefined ? undefined : nestedRecord(header, 'config')
        const provider = config?.provider
        const model = config?.model
        const reasoningEffort = config?.reasoningEffort
        if (typeof provider === 'string' && typeof model === 'string') {
          routes.push({ sessionId: log.sessionId, provider, model, ...typeof reasoningEffort === 'string' ? { reasoningEffort } : {} })
        }
        continue
      }
      if (type === 'tool/call') {
        const callId = data.callId
        if (typeof callId !== 'string' || typeof data.name !== 'string') continue
        tools.push({ sessionId: log.sessionId, callId, name: data.name, ok: false })
        continue
      }
      if (type !== 'tool/result') continue
      const message = nestedRecord(data, 'message')
      if (message === undefined) continue
      const callId = message.toolCallId
      if (typeof callId !== 'string' || message.isError === true) continue
      const call = tools.find(candidate => candidate.sessionId === log.sessionId && candidate.callId === callId)
      if (call !== undefined) call.ok = true
    }
  }
  return {
    sessions: logs.map(log => log.sessionId),
    childSessions,
    rootSessions: logs.map(log => log.sessionId).filter(id => !children.has(id)),
    tools,
    routes,
    failures,
    finalTexts,
  }
}

async function sessionEvidence(root: string): Promise<SessionEvidence> {
  return correlateSessionEvidence(await readSessionLogs(root))
}

function runProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((settle) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString('utf8')}`.slice(-1024 * 1024)
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      settle({ exitCode: null, timedOut, stdout, stderr: `${stderr}\n${String(error)}` })
    })
    child.once('close', (exitCode) => {
      clearTimeout(timer)
      settle({ exitCode, timedOut, stdout, stderr })
    })
  })
}

async function pinnedRolePatch(root: string, role: string, route: ResolvedRoleRoute): Promise<string[]> {
  if (role === 'coordinator') return []
  const id = `role-${role === 'implementer' ? `implementer-${process.platform === 'win32' ? 'windows' : 'posix'}` : role}`
  const schema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar' })])
  const parsed: unknown = load(await readFile(join(root, 'tools/agent/profiles/frozen-engineering.patch.yml'), 'utf8'), { schema })
  if (!Array.isArray(parsed)) throw new Error('pinned engineering overlay must contain a patch list')
  const patches: unknown[] = parsed
  const entries: unknown[] = patches.flatMap(patch => {
    if (typeof patch !== 'object' || patch === null) return []
    const inserted: unknown = Reflect.get(patch, 'insert')
    return Array.isArray(inserted) ? inserted : []
  })
  const entry = entries.find(candidate => typeof candidate === 'object' && candidate !== null && Reflect.get(candidate, 'id') === id)
  const config: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'config') : undefined
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error(`pinned engineering overlay is missing ${id}.config`)
  return dump([{ id, config: { ...config, agentOptions: {
    provider: route.provider, model: route.model,
    ...route.reasoningEffort === 'off' ? {} : { reasoningEffort: route.reasoningEffort }, maxTokens: route.maxTokens,
  } } }]).trimEnd().split('\n')
}

/**
 * Create the pinned headless executor used by deployment smoke checks.
 * @param root - DeepSeek Harness checkout root.
 * @param env - deployment environment containing route values and credentials.
 * @param timeoutMs - process deadline for each route.
 * @param config - validated deployment provider and model declarations.
 * @returns a runner that extracts durable route and tool evidence.
 */
export function createPinnedHeadlessExecutor(
  root: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  config: HarnessConfig,
): RealSmokeExecutor {
  return async (role, route, coordinator) => {
    const rolePatch = await pinnedRolePatch(root, role, route)
    const roles = Object.fromEntries(Object.entries(config.roles).map(([id, settings]) => [id, {
      ...settings, enabled: id === 'coordinator' || id === role,
      route: id === role ? route.routeId : settings.route, fallbackRoutes: [],
    }]))
    const providerPatch = dump([{ id: 'llm-pi-ai', config: { providers: providerOptions({ ...config, roles }) } }])
    const temporary = await mkdtemp(join(tmpdir(), `dsh-real-smoke-${role}-`))
    const sessions = join(temporary, 'sessions')
    const marker = join(temporary, 'marker.txt')
    const patch = join(temporary, 'route.patch.yml')
    await writeFile(marker, `DSH_REAL_SMOKE_MARKER:${role}\n`, 'utf8')
    await writeFile(patch, [
      '- id: agent-default-model',
      '  config:',
      `    provider: ${JSON.stringify(coordinator.provider)}`,
      `    model: ${JSON.stringify(coordinator.model)}`,
      ...coordinator.reasoningEffort === 'off' ? [] : [`    reasoningEffort: ${JSON.stringify(coordinator.reasoningEffort)}`],
      ...rolePatch,
      providerPatch.trimEnd(),
      '- id: session-persistence-jsonl',
      '  config:',
      '    root: !!js process.env.DSH_SMOKE_SESSION_ROOT',
      '    compression: none',
      '',
    ].join('\n'), 'utf8')
    const instruction = `You MUST execute the read tool on that exact path before answering; inferring, inventing or generating contents is forbidden, and an unexecutable read must be reported as an explicit failure.`
    const task = role === 'coordinator'
      ? `Use the read tool to read ${marker}. ${instruction} Then return exactly the marker text.`
      : `Call ${route.toolName ?? ''} exactly once. Ask it to use the read tool to read ${marker} and return exactly the marker text. ${instruction} Then return the child result verbatim.`
    try {
      const result = await runProcess(
        process.execPath,
        [
          '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
          '--profile', 'headless',
          '--patch', 'tools/agent/profiles/frozen-engineering.patch.yml',
          '--patch', patch,
          '--json', task,
        ],
        root,
        {
          ...env,
          DSH_HOME: join(temporary, 'home'),
          DSH_SMOKE_SESSION_ROOT: sessions,
          DSH_PERMISSION_MODE: 'read-only',
          DSH_TELEMETRY_DISABLED: '1',
        },
        timeoutMs,
      )
      const stream = jsonObjects(result.stdout)
      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        finalText: extractHeadlessResult(stream),
        sessions: await sessionEvidence(sessions),
        diagnostic: `${result.stderr}\n${result.stdout}`.slice(-16384),
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
}

function unavailable(route: ResolvedRoleRoute, missing: string[]): ModelSmokeResult {
  const status: CheckStatus = 'NOT_RUN'
  return {
    routeId: route.routeId,
    role: route.role,
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoningEffort,
    status,
    checks: {
      'provider-resolves': status,
      'model-resolves': status,
      'reasoning-routed': status,
      completion: status,
      'tool-use': status,
      subagent: status,
      background: status,
      'structured-output': status,
      'bounded-cancellation': status,
      'route-diagnostic': status,
    },
    reason: `missing deployment values: ${missing.join(', ')}`,
  }
}

/** Non-sensitive diagnostic classification of one failed real-route attempt. */
export interface RealSmokeFailure {
  failureClass: RealSmokeFailureClass
  expectedMarker: string
  expectedTool?: string
  finalText: string
  calledTools: string[]
  successfulTools: string[]
  failures: SessionFailureEvidence[]
  exitCode: number | null
  timedOut: boolean
}

/** One disjoint reason a real route failed qualification. */
export type RealSmokeFailureClass =
  | 'PROCESS_EXIT_FAILURE'
  | 'TIMEOUT'
  | 'ROUTE_MISMATCH'
  | 'REASONING_ROUTE_MISMATCH'
  | 'SUBAGENT_NOT_CALLED'
  | 'SUBAGENT_FAILED'
  | 'CHILD_READ_NOT_CALLED'
  | 'CHILD_READ_FAILED'
  | 'FINAL_MARKER_MISMATCH'

const EMPTY_SESSIONS: SessionEvidence = { sessions: [], childSessions: [], rootSessions: [], tools: [], routes: [], failures: [], finalTexts: [] }

/** One disjoint reason a real route failed qualification, in evaluation order. */
export function classifyFailure(
  evidence: RealSmokeEvidence,
  expectedTool: string | undefined,
  checks: Readonly<Record<string, CheckStatus>>,
  roleSessions: readonly string[],
): RealSmokeFailureClass {
  if (evidence.timedOut) return 'TIMEOUT'
  if (evidence.exitCode !== 0) return 'PROCESS_EXIT_FAILURE'
  if (checks['route-diagnostic'] !== 'PASS') return 'ROUTE_MISMATCH'
  if (checks['reasoning-routed'] !== 'PASS') return 'REASONING_ROUTE_MISMATCH'
  if (expectedTool !== undefined && checks.subagent !== 'PASS') {
    const dispatched = evidence.sessions.tools.some(tool => tool.name === expectedTool && evidence.sessions.rootSessions.includes(tool.sessionId))
    return dispatched ? 'SUBAGENT_FAILED' : 'SUBAGENT_NOT_CALLED'
  }
  if (checks['tool-use'] !== 'PASS') {
    // Only the role's own Session proves attempt versus failure: a parent or
    // unrelated Session that happened to call `read` must not reclassify a
    // child that never called it.
    const attempted = evidence.sessions.tools.some(tool => tool.name === 'read' && roleSessions.includes(tool.sessionId))
    return attempted ? 'CHILD_READ_FAILED' : 'CHILD_READ_NOT_CALLED'
  }
  if (checks.completion !== 'PASS') return 'FINAL_MARKER_MISMATCH'
  return 'FINAL_MARKER_MISMATCH'
}

/**
 * Qualify one role from durable evidence bound to the Session that owns it.
 *
 * A delegated role runs in a child Session, so its route, its `read`, and the
 * fixed role tool that dispatched it are proven separately: the route and
 * `read` come from the child Session, while dispatch comes from the root
 * Session. Unifying them into one global name set would let an unrelated
 * Session's successful `read` qualify the role.
 * @param evidence - process, stream, and durable Session evidence.
 * @returns the checks and the first failing class, if any.
 */
export function evaluateRole(
  role: string,
  route: ResolvedRoleRoute,
  evidence: RealSmokeEvidence,
): { checks: Record<string, CheckStatus>; failure?: RealSmokeFailureClass } {
  const marker = `DSH_REAL_SMOKE_MARKER:${role}`
  const expectedTool = role === 'coordinator' ? undefined : route.toolName
  const sessions = evidence.sessions
  const roleSessions = expectedTool === undefined ? sessions.rootSessions : sessions.childSessions
  const providerRouted = sessions.routes.some(candidate => roleSessions.includes(candidate.sessionId)
    && candidate.provider === route.provider)
  const routed = sessions.routes.some(candidate => roleSessions.includes(candidate.sessionId)
    && candidate.provider === route.provider && candidate.model === route.model)
  const reasoned = sessions.routes.some(candidate => roleSessions.includes(candidate.sessionId)
    && candidate.provider === route.provider && candidate.model === route.model && (candidate.reasoningEffort ?? 'off') === route.reasoningEffort)
  const candidateSessions = roleSessions.filter(sessionId => sessions.routes.some(candidate => candidate.sessionId === sessionId
    && candidate.provider === route.provider && candidate.model === route.model && (candidate.reasoningEffort ?? 'off') === route.reasoningEffort))
  // The delegated child must have answered with the marker itself: a parent
  // that echoes a read the child never turned into an answer is not qualified.
  const childAnswered = expectedTool === undefined
    || sessions.finalTexts.some(entry => candidateSessions.includes(entry.sessionId) && entry.text.includes(marker))
  const read = sessions.tools.some(tool => tool.name === 'read' && tool.ok && candidateSessions.includes(tool.sessionId))
  const dispatched = expectedTool === undefined ? undefined
    : sessions.tools.find(tool => tool.name === expectedTool && sessions.rootSessions.includes(tool.sessionId))
  const checks: Record<string, CheckStatus> = {
    'provider-resolves': providerRouted ? 'PASS' : 'FAIL',
    'model-resolves': routed ? 'PASS' : 'FAIL',
    'reasoning-routed': reasoned ? 'PASS' : 'FAIL',
    completion: evidence.exitCode === 0 && evidence.finalText.includes(marker) && childAnswered ? 'PASS' : 'FAIL',
    'tool-use': read ? 'PASS' : 'FAIL',
    subagent: expectedTool === undefined ? 'NOT_RUN' : dispatched?.ok === true ? 'PASS' : 'FAIL',
    background: 'NOT_RUN',
    'structured-output': 'NOT_RUN',
    'bounded-cancellation': evidence.timedOut ? 'FAIL' : 'PASS',
    'route-diagnostic': routed ? 'PASS' : 'FAIL',
  }
  const required = REQUIRED_CHECKS.filter(name => !(name === 'subagent' && expectedTool === undefined))
  if (required.every(name => checks[name] === 'PASS')) return { checks }
  return { checks, failure: classifyFailure(evidence, expectedTool, checks, candidateSessions) }
}

function summarizeFailure(role: string, route: ResolvedRoleRoute, evidence: RealSmokeEvidence, failureClass: RealSmokeFailureClass): RealSmokeFailure {
  const expectedTool = role === 'coordinator' ? undefined : route.toolName
  return {
    failureClass,
    expectedMarker: `DSH_REAL_SMOKE_MARKER:${role}`,
    ...expectedTool === undefined ? {} : { expectedTool },
    finalText: evidence.finalText.slice(0, 2000),
    calledTools: [...new Set(evidence.sessions.tools.map(tool => tool.name))],
    successfulTools: [...new Set(evidence.sessions.tools.filter(tool => tool.ok).map(tool => tool.name))],
    failures: evidence.sessions.failures.slice(-16),
    exitCode: evidence.exitCode,
    timedOut: evidence.timedOut,
  }
}

/**
 * Qualify enabled roles and their distinct primary/fallback routes through real DSH routing.
 * @param config - validated harness configuration with environment substitutions applied.
 * @param env - credential environment used by the pinned process.
 * @param execute - pinned-profile executor or an injected test double.
 * @returns role and route results; primary evidence is reused and missing deployment values remain `NOT_RUN`.
 */
export async function runRealModelSmokes(
  config: HarnessConfig,
  env: NodeJS.ProcessEnv,
  execute: RealSmokeExecutor,
): Promise<ModelSmokeResult[]> {
  const coordinator = resolveRoleRoute(config, 'coordinator')
  const coordinatorMissing = missingDeploymentValues(config, coordinator, env)
  const results: ModelSmokeResult[] = []
  const qualifiedRoutes = new Map<string, ModelSmokeResult>()
  const qualify = async (route: ResolvedRoleRoute): Promise<ModelSmokeResult> => {
    const role = route.role
    const missing = [...new Set([...coordinatorMissing, ...missingDeploymentValues(config, route, env)])]
    if (missing.length > 0) {
      return unavailable(route, missing)
    }
    let evidence: RealSmokeEvidence
    try {
      evidence = await execute(role, route, coordinator)
    } catch (error) {
      evidence = {
        exitCode: null,
        timedOut: false,
        finalText: '',
        sessions: EMPTY_SESSIONS,
        diagnostic: error instanceof Error ? error.message : String(error),
      }
    }
    const evaluated = evaluateRole(role, route, evidence)
    return {
      routeId: route.routeId,
      role,
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      status: evaluated.failure === undefined ? 'PASS' : 'FAIL',
      checks: evaluated.checks,
      ...evaluated.failure === undefined ? {} : { reason: JSON.stringify(summarizeFailure(role, route, evidence, evaluated.failure)) },
    }
  }
  for (const [role, roleConfig] of Object.entries(config.roles)) {
    if (!roleConfig.enabled) continue
    const route = resolveRoleRoute(config, role)
    const result = await qualify(route)
    results.push({ ...result, qualification: 'role' })
    const key = JSON.stringify([route.routeId, route.reasoningEffort])
    if (!qualifiedRoutes.has(key)) qualifiedRoutes.set(key, result)
  }
  for (const [role, roleConfig] of Object.entries(config.roles)) {
    if (!roleConfig.enabled) continue
    for (const route of resolveRoleFallbackRoutes(config, role)) {
      const key = JSON.stringify([route.routeId, route.reasoningEffort])
      if (!qualifiedRoutes.has(key)) qualifiedRoutes.set(key, await qualify(route))
    }
  }
  results.push(...[...qualifiedRoutes.values()].map(result => ({ ...result, qualification: 'route' as const })))
  return results
}
