/**
 * Tool operation orchestration over session-query service capabilities.
 *
 * @module @deepseek-ai/dsh-tool-session-query/operations
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionQueryError,
  type SessionEventSearchPage,
  type SessionEventSurface,
  type SessionRecord,
  type SessionSearchCursor,
} from '@deepseek-ai/dsh-session-query'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { toolInput } from './input.ts'
import { presentation } from './presentation.ts'
import { serviceBoundary } from './service-boundary.ts'
import { workspaceAccess } from './workspace-access.ts'

type SessionSearchArgs = Parameters<typeof toolInput.buildSessionFilters>[0]

interface EventSearchArgs {
  session_id?: string
  query: string
  seq_from?: number
  seq_to?: number
  time_from?: string
  time_to?: string
  event_types?: string[]
  surfaces?: SessionEventSurface[]
}

interface SessionTargetArgs {
  session_id?: string
}

interface EventTargetArgs extends SessionTargetArgs {
  seq: number
}

interface EventReadArgs extends EventTargetArgs {
  before?: number
  after?: number
}

interface SearchCollection<T> {
  readonly items: T[]
  readonly capped: boolean
  /**
   * Set when the collection stopped BEFORE the provider ran out of pages,
   * because the caller's deadline fired. `items` still holds every match found
   * up to that point. Absent on a complete or merely capped collection, so
   * existing consumers read `true`/`undefined` exactly as before.
   */
  readonly partial?: PartialCollection
}

/**
 * Why a search stopped early, rendered to the model. `reason` is a fixed
 * vocabulary so the text stays stable; `deadlineMs` is only present when the
 * timeout stack reported the budget, where naming it makes the result
 * actionable.
 */
interface PartialCollection {
  readonly reason: 'deadline'
  readonly deadlineMs?: number
}

async function executeSessionSearch(
  ctx: Context,
  args: SessionSearchArgs,
  exec: ToolRunContext,
  maxResults: number,
): Promise<string> {
  const caller = workspaceAccess.callerOf(exec, ctx)
  const cwd = caller.header.cwd
  if (cwd === undefined) {
    throw new HarnessError(
      'cross-session search is unavailable because the caller session has no workspace',
      'SESSION_QUERY_TOOL_UNAUTHORIZED',
    )
  }
  const query = toolInput.normalizeQuery(args.query)
  const sessionFilters = toolInput.buildSessionFilters(args)
  const eventFilters = toolInput.buildEventFilters({
    seqFrom: args.event_seq_from,
    seqTo: args.event_seq_to,
    timeFrom: args.event_time_from,
    timeTo: args.event_time_to,
    eventTypes: args.event_types,
    surfaces: args.event_surfaces,
  })
  const requestedParentIds = toolInput.materializeParentSessionIds(args.parent_session_ids)
  if (requestedParentIds !== undefined || args.include_root_sessions === true) {
    const authorizedParentIds = requestedParentIds === undefined
      ? new Set<SessionId>()
      : await workspaceAccess.authorizeSessionIds(ctx, caller, requestedParentIds, exec.signal)
    const parentValues: Array<SessionId | null> = requestedParentIds
      ?.filter(id => authorizedParentIds.has(id)) ?? []
    if (args.include_root_sessions === true) parentValues.push(null)
    if (parentValues.length === 0) return presentation.formatEmptySessionSearch()
    sessionFilters.push({ kind: 'parent', values: parentValues })
  }
  sessionFilters.push({ kind: 'cwd', values: [cwd] })
  const collected = await collectPages(
    maxResults,
    exec.signal,
    cursor => serviceBoundary.call(ctx, exec.signal, 'session search', () =>
      ctx.sessionQuery.searchSessions({
        query,
        sessionFilters,
        eventFilters,
        ...cursor === undefined ? {} : { cursor },
      }, { signal: exec.signal })),
    hit => hit.header.id !== caller.id && workspaceAccess.recordAuthorized(hit, caller),
  )

  // A PARTIAL collection must not pay for more service calls: its deadline has
  // already fired, so every subsequent read would either reject on the aborted
  // signal (discarding the hits we just rescued) or run past the budget. Skip
  // the enrichment and degrade cosmetically — parents render as 'outside
  // workspace' and titles as 'untitled' — while the warning trailer states
  // plainly that the result is incomplete.
  //
  // The claim is what carries the pages past the registry's abort handling. It
  // is made only here, where real matches exist and the trailer names the gap.
  if (collected.partial !== undefined) {
    exec.declarePartial()
    return presentation.formatSessionSearch(collected, untitledViews(), new Set<SessionId>())
  }
  const parentIds = collected.items
    .map(hit => hit.header.parentSession)
    .filter((id): id is SessionId => id !== undefined)
  const authorizedParents = await workspaceAccess.authorizeSessionIds(ctx, caller, parentIds, exec.signal)
  const titles = await workspaceAccess.readTitles(
    ctx,
    caller,
    collected.items.map(hit => hit.header.id),
    exec.signal,
  )
  return presentation.formatSessionSearch(collected, titles, authorizedParents)
}

async function executeEventSearch(
  ctx: Context,
  args: EventSearchArgs,
  exec: ToolRunContext,
  maxResults: number,
): Promise<string> {
  const caller = workspaceAccess.callerOf(exec, ctx)
  const sessionId = workspaceAccess.targetId(args, caller)
  await workspaceAccess.authorizeTarget(ctx, caller, sessionId, exec.signal)
  const query = toolInput.normalizeQuery(args.query)
  const range = toolInput.sequenceRange(args.seq_from, args.seq_to)
  if (sessionId === caller.id) {
    const stepStartSeq = caller.boundary?.lastStepStartSeq
    if (stepStartSeq === undefined) {
      throw new HarnessError(
        'current-session search requires an active step boundary',
        'SESSION_QUERY_TOOL_NO_CURRENT_STEP',
      )
    }
    // `null` (no step started yet) caps the range to a degenerate `to` the
    // filter validation rejects — the loop never runs tools outside a step.
    range.to = Math.min(range.to ?? Number.MAX_SAFE_INTEGER, (stepStartSeq ?? 0) - 1)
  }
  const title = await workspaceAccess.readTitle(ctx, caller, sessionId, exec.signal)
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) {
    return presentation.formatEventSearch(sessionId, title, { items: [], capped: false })
  }
  const filters = toolInput.buildEventFilters({
    seqFrom: range.from,
    seqTo: range.to,
    timeFrom: args.time_from,
    timeTo: args.time_to,
    eventTypes: args.event_types,
    surfaces: args.surfaces,
  })
  const collected = await collectPages(
    maxResults,
    exec.signal,
    async (cursor): Promise<SessionEventSearchPage> => {
      const page = await serviceBoundary.call(ctx, exec.signal, 'event search', () =>
        ctx.sessionQuery.searchEvents({
          sessionId,
          query,
          filters,
          ...cursor === undefined ? {} : { cursor },
        }, { signal: exec.signal }))
      workspaceAccess.assertObservedTargetAuthorized(caller, sessionId, page.session)
      return page
    },
    () => true,
  )
  // Same claim as the session branch: the trailer states the result is
  // incomplete, so preserving these events is correct rather than misleading.
  if (collected.partial !== undefined) exec.declarePartial()
  return presentation.formatEventSearch(sessionId, title, collected)
}

async function executeSessionTrace(
  ctx: Context,
  args: SessionTargetArgs,
  exec: ToolRunContext,
): Promise<string> {
  const caller = workspaceAccess.callerOf(exec, ctx)
  const sessionId = workspaceAccess.targetId(args, caller)
  await workspaceAccess.authorizeTarget(ctx, caller, sessionId, exec.signal)
  const trace = await serviceBoundary.call(ctx, exec.signal, 'session lineage trace', () =>
    ctx.sessionQuery.traceSession(sessionId, exec.signal))
  workspaceAccess.assertObservedTargetAuthorized(caller, sessionId, trace.target.header)

  const ancestors: SessionRecord[] = []
  let ancestorBoundary = false
  for (const ancestor of trace.ancestors) {
    if (!workspaceAccess.recordAuthorized(ancestor, caller)) {
      ancestorBoundary = true
      break
    }
    ancestors.push(ancestor)
  }
  if (ancestors.length === trace.ancestors.length && !trace.complete) ancestorBoundary = true
  const descendants = workspaceAccess.authorizeDescendants(trace.descendants, caller)
  const visibleIds = [
    trace.target.header.id,
    ...ancestors.map(record => record.header.id),
    ...workspaceAccess.descendantIds(descendants),
  ]
  const titles = await workspaceAccess.readTitles(ctx, caller, visibleIds, exec.signal)
  return presentation.formatSessionTrace(trace, ancestors, ancestorBoundary, descendants, titles)
}

async function executeEventTrace(
  ctx: Context,
  args: EventTargetArgs,
  exec: ToolRunContext,
): Promise<string> {
  toolInput.assertNonNegativeSafeInteger('seq', args.seq)
  const seq = SessionSeq(args.seq)
  const caller = workspaceAccess.callerOf(exec, ctx)
  const sessionId = workspaceAccess.targetId(args, caller)
  await workspaceAccess.authorizeTarget(ctx, caller, sessionId, exec.signal)
  const trace = await serviceBoundary.call(ctx, exec.signal, 'event trace', () =>
    ctx.sessionQuery.traceEvent({ sessionId, seq }, exec.signal))
  workspaceAccess.assertObservedTargetAuthorized(caller, sessionId, trace.session)
  const title = await workspaceAccess.readTitle(ctx, caller, sessionId, exec.signal)
  return presentation.formatEventTrace(sessionId, title, trace)
}

async function executeEventRead(
  ctx: Context,
  args: EventReadArgs,
  exec: ToolRunContext,
): Promise<string> {
  toolInput.assertNonNegativeSafeInteger('seq', args.seq)
  const seq = SessionSeq(args.seq)
  if (args.before !== undefined) toolInput.assertNonNegativeSafeInteger('before', args.before)
  if (args.after !== undefined) toolInput.assertNonNegativeSafeInteger('after', args.after)
  const caller = workspaceAccess.callerOf(exec, ctx)
  const sessionId = workspaceAccess.targetId(args, caller)
  await workspaceAccess.authorizeTarget(ctx, caller, sessionId, exec.signal)
  const window = await serviceBoundary.call(ctx, exec.signal, 'event read', () =>
    ctx.sessionQuery.readEvent({
      sessionId,
      seq,
      ...args.before === undefined ? {} : { before: args.before },
      ...args.after === undefined ? {} : { after: args.after },
    }, exec.signal))
  workspaceAccess.assertObservedTargetAuthorized(caller, sessionId, window.session)
  const title = await workspaceAccess.readTitle(ctx, caller, sessionId, exec.signal)
  return presentation.formatEventRead(sessionId, title, window)
}

/**
 * Titles for a PARTIAL search: nothing is known, so every session renders
 * 'untitled'.
 *
 * A partial search cannot afford another service round trip — its deadline has
 * already fired, and any further read would either fail on the aborted signal or
 * run unbounded past the budget. Losing the titles is a cosmetic degradation;
 * losing the sessions is the data loss this change exists to stop, and the
 * warning trailer still tells the model the result is incomplete.
 *
 * A Map subclass (not a bare object) because the title map the formatter wants
 * extends ReadonlyMap; answering 'untitled' for every id means there is no
 * partial-population branch to get wrong.
 *
 * @returns a title view answering 'untitled' for any session id.
 */
function untitledViews(): Awaited<ReturnType<typeof workspaceAccess.readTitles>> {
  return new class extends Map<SessionId, { readonly text: string }> {
    override get(): { readonly text: string } {
      return { text: 'untitled' }
    }
  }()
}

/**
 * The elapsed deadline recovered from an aborted signal, when the timeout stack
 * attached one. `TimeoutReason` carries the budget that fired, which is what
 * makes the model-facing warning actionable ("after 30000ms") instead of vague.
 *
 * Read structurally rather than by import so this package keeps no dependency on
 * the timeout implementation: any reason exposing a positive `timeoutMs` is
 * accepted, and an unrecognised reason simply yields no number.
 *
 * @param signal - the signal the page request was cancelled by.
 * @returns the deadline in milliseconds, or `undefined` when unknown.
 */
function elapsedDeadline(signal: AbortSignal): number | undefined {
  const reason: unknown = signal.reason
  if (typeof reason !== 'object' || reason === null) return undefined
  const candidate: unknown = (reason as { timeoutMs?: unknown }).timeoutMs
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
    ? candidate
    : undefined
}

async function collectPages<T>(
  maxResults: number,
  signal: AbortSignal,
  request: (cursor?: SessionSearchCursor) => Promise<{
    readonly items: readonly T[]
    readonly nextCursor?: SessionSearchCursor
  }>,
  accept: (item: T) => boolean,
): Promise<SearchCollection<T>> {
  const items: T[] = []
  const seen = new Set<SessionSearchCursor>()
  let cursor: SessionSearchCursor | undefined
  /**
   * The one way this loop stops early with work in hand.
   *
   * Reached only when at least one item was collected. An empty search is left
   * to the HARD deadline on purpose: that path yields the canonical typed
   * `TOOL_TIMEOUT`, so "nothing found before the budget" stays a failure rather
   * than becoming a persuasive "no matches".
   *
   * @param deadlineMs - the budget to name in the warning, when known.
   * @returns the partial collection.
   */
  const partialResult = (deadlineMs: number | undefined): SearchCollection<T> => ({
    items,
    capped: false,
    partial: deadlineMs === undefined ? { reason: 'deadline' } : { reason: 'deadline', deadlineMs },
  })
  while (true) {
    try {
      signal.throwIfAborted()
      const page = await request(cursor)
      signal.throwIfAborted()
      for (const item of page.items) {
        if (!accept(item)) continue
        if (items.length === maxResults) {
          return { items, capped: true }
        }
        items.push(item)
      }
      if (page.nextCursor === undefined) return { items, capped: false }
      if (seen.has(page.nextCursor)) {
        throw new SessionQueryError(
          'session-search provider repeated a continuation cursor',
          'SESSION_QUERY_INVALID_CURSOR',
        )
      }
      seen.add(page.nextCursor)
      cursor = page.nextCursor
    } catch (error: unknown) {
      // `signal.aborted` is authoritative: it is what cut the page fetch short,
      // so a provider fault that merely COINCIDED with an abort is still a
      // fault. Anything else propagates untouched.
      if (!signal.aborted || items.length === 0) throw error
      return partialResult(elapsedDeadline(signal))
    }
  }
}

/** Five model-facing session-query operation implementations. */
export const operations = {
  executeSessionSearch,
  executeEventSearch,
  executeSessionTrace,
  executeEventTrace,
  executeEventRead,
}
