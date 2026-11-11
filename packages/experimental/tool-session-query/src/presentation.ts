/**
 * Model text rendering and generic tool-call presentation.
 *
 * @module @deepseek-ai/dsh-tool-session-query/presentation
 */

import {
  extractSessionEventText,
  type SessionEventSearchHit,
  type SessionEventTraceObservation,
  type SessionEventWindow,
  type SessionLineageTrace,
  type SessionRecord,
  type SessionSearchHit,
} from '@deepseek-ai/dsh-session-query'
import type {
  SessionEvent,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { workspaceAccess } from './workspace-access.ts'

type TitleView = Awaited<ReturnType<typeof workspaceAccess.readTitle>>
type CompleteTitleMap = Awaited<ReturnType<typeof workspaceAccess.readTitles>>
type AuthorizedDescendants = ReturnType<typeof workspaceAccess.authorizeDescendants>

interface SearchCollection<T> {
  readonly items: T[]
  readonly capped: boolean
  /** Present when a deadline stopped the search early; see the collector. */
  readonly partial?: {
    readonly reason: 'deadline'
    readonly deadlineMs?: number
  }
}

/**
 * The trailer that tells the model a search result is INCOMPLETE.
 *
 * This is the F3 principle applied to session search: a partial result must be
 * returned AND clearly labelled, never silently presented as the whole answer.
 * The block is a distinct trailer rather than a result row, so a warning can
 * never be mistaken for a session hit, and the body above it stays exactly the
 * sessions that really matched.
 *
 * An empty collection never reaches here — an empty timeout stays a hard
 * `TOOL_TIMEOUT` failure upstream, because "no results" and "we ran out of time
 * before finding any" are different facts and only one of them is true.
 *
 * @param collected - the collection that may be partial.
 * @returns the warning trailer, or an empty string for a complete result.
 */
function formatPartialNotice(collected: { readonly partial?: { readonly deadlineMs?: number } }): string {
  if (collected.partial === undefined) return ''
  const budget = collected.partial.deadlineMs === undefined
    ? 'the search deadline'
    : `the ${collected.partial.deadlineMs}ms search deadline`
  return `\n\n(WARNING: PARTIAL results. The search stopped at ${budget} before it finished paging, so more matches may exist that are MISSING from the results above. Narrow the query or add filters to get a complete result.)`
}

interface SessionSearchCallArgs {
  readonly query: string
}

interface EventSearchCallArgs {
  readonly query: string
}

interface SessionTargetCallArgs {
  readonly session_id?: string
}

interface EventTargetCallArgs extends SessionTargetCallArgs {
  readonly seq: number
}

function formatSessionSearch(
  collected: SearchCollection<SessionSearchHit>,
  titles: CompleteTitleMap,
  authorizedParents: ReadonlySet<SessionId>,
): string {
  if (collected.items.length === 0) return formatEmptySessionSearch()
  const lines = [`Session search results (${collected.items.length}):`]
  for (const [index, hit] of collected.items.entries()) {
    const parent = hit.header.parentSession === undefined
      ? 'root'
      : authorizedParents.has(hit.header.parentSession)
        ? hit.header.parentSession
        : '[outside workspace]'
    const availability = [
      hit.live ? 'live' : undefined,
      hit.persisted ? 'persisted' : undefined,
    ].filter((value): value is string => value !== undefined).join(', ') || 'unavailable'
    lines.push(
      '',
      `${index + 1}. Session ${hit.header.id} — ${workspaceAccess.titleText(titles.get(hit.header.id))}`,
      `   Created: ${formatTime(hit.header.createdAt)}`,
      `   Parent: ${parent}`,
      `   Availability: ${availability}`,
      `   Best match: seq ${hit.bestMatch.seq} | ${hit.bestMatch.type} | ${hit.bestMatch.surface} | ${formatTime(hit.bestMatch.time)}`,
      `   Snippet: ${hit.bestMatch.snippet}`,
    )
  }
  if (collected.capped) {
    lines.push('', 'Result cap reached. Narrow the query or add filters to find additional matches.')
  }
  return lines.join('\n') + formatPartialNotice(collected)
}

function formatEmptySessionSearch(): string {
  return 'No prior session matches found.'
}

function formatEventSearch(
  sessionId: SessionId,
  title: TitleView,
  collected: SearchCollection<SessionEventSearchHit>,
): string {
  const lines = [`Session ${sessionId} — ${workspaceAccess.titleText(title)}`]
  if (collected.items.length === 0) {
    lines.push('', 'No prior event matches found.')
    return lines.join('\n')
  }
  lines.push('', `Event search results (${collected.items.length}):`)
  for (const [index, hit] of collected.items.entries()) {
    lines.push(
      `${index + 1}. seq ${hit.seq} | ${hit.type} | ${hit.surface} | ${formatTime(hit.time)}`,
      `   Snippet: ${hit.snippet}`,
    )
  }
  if (collected.capped) {
    lines.push('', 'Result cap reached. Narrow the query or add filters to find additional matches.')
  }
  return lines.join('\n') + formatPartialNotice(collected)
}

function formatSessionTrace(
  trace: SessionLineageTrace,
  ancestors: readonly SessionRecord[],
  ancestorBoundary: boolean,
  descendants: AuthorizedDescendants,
  titles: CompleteTitleMap,
): string {
  const lines = [
    `Session ${trace.target.header.id} — ${workspaceAccess.titleText(titles.get(trace.target.header.id))}`,
    `Created: ${formatTime(trace.target.header.createdAt)}`,
    `Availability: ${availabilityText(trace.target)}`,
    '',
    'Ancestors (nearest first):',
  ]
  if (ancestors.length === 0 && !ancestorBoundary) lines.push('- none (target is a root session)')
  for (const record of ancestors) {
    lines.push(`- ${record.header.id} — ${workspaceAccess.titleText(titles.get(record.header.id))} | ${formatTime(record.header.createdAt)} | ${availabilityText(record)}`)
  }
  if (ancestorBoundary) lines.push('- [outside workspace boundary]')
  lines.push('', 'Descendants:')
  if (descendants.length === 0) lines.push('- none')
  else renderDescendants(lines, descendants, titles)
  return lines.join('\n')
}

function renderDescendants(
  lines: string[],
  nodes: AuthorizedDescendants,
  titles: CompleteTitleMap,
): void {
  for (const { node, depth } of workspaceAccess.visitDescendants(nodes)) {
    const indent = '  '.repeat(depth)
    if (node === null) {
      lines.push(`${indent}- [outside workspace subtree]`)
      continue
    }
    const id = node.record.header.id
    lines.push(`${indent}- ${id} — ${workspaceAccess.titleText(titles.get(id))} | ${formatTime(node.record.header.createdAt)} | ${availabilityText(node.record)}`)
  }
}

function formatEventTrace(
  sessionId: SessionId,
  title: TitleView,
  trace: SessionEventTraceObservation,
): string {
  return [
    `Session ${sessionId} — ${workspaceAccess.titleText(title)}`,
    `Target: seq ${trace.target.seq} | ${trace.target.type} | ${trace.target.surface} | ${formatTime(trace.target.time)}`,
    `Replaced by: ${trace.replacedBy ?? 'none'}`,
    `Replacement chain: ${seqList(trace.replacementChain)}`,
    `Events replaced by target: ${seqList(trace.replacedEventSeqs)}`,
    `Events cited directly as sources: ${seqList(trace.sourceEventSeqs)}`,
    `Direct derived events: ${seqList(trace.derivedEventSeqs)}`,
  ].join('\n')
}

function formatEventRead(
  sessionId: SessionId,
  title: TitleView,
  window: SessionEventWindow,
): string {
  const before = window.events.filter(event => event.seq < window.target.seq)
  const after = window.events.filter(event => event.seq > window.target.seq)
  const lines = [
    `Session ${sessionId} — ${workspaceAccess.titleText(title)}`,
    `Target event seq ${window.target.seq}:`,
    '```json',
    JSON.stringify(window.target, null, 2),
    '```',
  ]
  if (before.length > 0) {
    lines.push('', 'Before:')
    for (const event of before) lines.push(formatNeighbor(event))
  }
  if (after.length > 0) {
    lines.push('', 'After:')
    for (const event of after) lines.push(formatNeighbor(event))
  }
  return lines.join('\n')
}

function formatNeighbor(event: SessionEvent): string {
  const text = extractSessionEventText(event)
  return `- seq ${event.seq} | ${event.type} | ${formatTime(event.time)}`
    + (text.length === 0 ? ' | (no semantic text)' : `\n  ${text.replaceAll('\n', '\n  ')}`)
}

function availabilityText(record: SessionRecord): string {
  return [
    record.live ? 'live' : undefined,
    record.persisted ? 'persisted' : undefined,
  ].filter((value): value is string => value !== undefined).join(', ') || 'unavailable'
}

function seqList(values: readonly number[]): string {
  return values.length === 0 ? 'none' : values.join(', ')
}

function formatTime(value: number): string {
  return new Date(value).toISOString()
}

function presentSessionSearchCall(args: SessionSearchCallArgs): GenericCallView {
  return { card: 'generic', kind: 'search', title: 'Search prior sessions', rawInput: args.query }
}

function presentEventSearchCall(args: EventSearchCallArgs): GenericCallView {
  return { card: 'generic', kind: 'search', title: 'Search session events', rawInput: args.query }
}

function presentSessionTraceCall(args: SessionTargetCallArgs): GenericCallView {
  return {
    card: 'generic',
    kind: 'read',
    title: args.session_id === undefined ? 'Trace current session' : `Trace session ${args.session_id}`,
    ...args.session_id === undefined ? {} : { rawInput: args.session_id },
  }
}

function presentEventTargetCall(
  action: string,
  args: EventTargetCallArgs,
): GenericCallView {
  return {
    card: 'generic',
    kind: 'read',
    title: `${action} ${args.seq}`,
    rawInput: {
      ...args.session_id === undefined ? {} : { session_id: args.session_id },
      seq: args.seq,
    },
  }
}

/** Text output and call-card presentation for every session-query tool. */
export const presentation = {
  formatSessionSearch,
  formatEmptySessionSearch,
  formatPartialNotice,
  formatEventSearch,
  formatSessionTrace,
  formatEventTrace,
  formatEventRead,
  presentSessionSearchCall,
  presentEventSearchCall,
  presentSessionTraceCall,
  presentEventTargetCall,
}
