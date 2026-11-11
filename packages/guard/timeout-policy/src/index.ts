/**
 * Cooperative tool-call timeout enforcer. A tool declares `timeoutMs` and
 * promises to honor `exec.signal`; this wrapper arms that deadline and maps its
 * own expiry to `TOOL_TIMEOUT` without racing or abandoning the tool promise.
 *
 * FIXME: settle the intended `@deepseek-ai/dsh-timeout-guard` rename before the
 * first tagged release — suggestion only, aligning the name with its `guard/`
 * home; decide at resolution time
 * ([regrouping Agent Note](../../../../.agents/notes/archived/architecture/2026-07-29-package-regrouping.md)).
 *
 * @module @deepseek-ai/dsh-tool-call-timeout-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * The code owned by this plugin, used BOTH as the internal {@link deadline}
 * classification code AND as the structured error `code` on the replacement
 * tool result. Scoping {@link timeoutOf} to it keeps a nested outer deadline
 * (another `tools/execute` wrapper's timer that fired first) from being misread
 * as this plugin's own timeout — it reads as an ordinary upstream cancel.
 */
export const TOOL_TIMEOUT = 'TOOL_TIMEOUT'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'timeout-policy'

/** The tool registry service this plugin wraps (`tools/execute`) and reads (`get`). */
export const inject = ['tools']

/**
 * The structured result substituted when this plugin's deadline wins AND the
 * tool reached quiescence carrying nothing usable. `content` is the
 * model-facing message; `error.code` is the same {@link TOOL_TIMEOUT} this
 * plugin owns, so a retry/sandbox plugin (and replay) can route on it.
 *
 * Only an EMPTY outcome is replaced: an `isError` result, or a successful one
 * whose content carries no readable text. See {@link carriesPartialContent} for
 * why a quiescent success is preserved instead.
 *
 * @param timeoutMs - the elapsed budget, rendered into the model-facing message.
 * @returns the `isError` {@link ToolExecutionResult} with a `TOOL_TIMEOUT` error.
 */
function toolTimeoutResult(timeoutMs: number): ToolExecutionResult {
  const message = `tool call timed out after ${timeoutMs}ms`
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: 'ToolTimeoutError', code: TOOL_TIMEOUT } },
  }
}

/**
 * Whether a tool that settled AFTER this deadline fired CLAIMED its output is
 * deliberately partial and must survive.
 *
 * The tool owns this judgement and states it explicitly through
 * `exec.declarePartial()`; this plugin only honours the claim. Reading partiality
 * off content shape instead would be a guess, and the wrong guess is expensive in
 * both directions:
 *
 * - a success with no readable text, or an `isError` result — the tool had
 *   nothing to show. Replacing it with {@link toolTimeoutResult} loses nothing
 *   and keeps an empty timeout a hard, typed failure. An empty "success" would be
 *   a lie about what was searched.
 * - a success WITHOUT the claim — the tool may well have returned a give-up
 *   placeholder. Treating non-empty text as proof of partiality would present
 *   that as a result, so an unmarked outcome keeps today's behaviour exactly and
 *   becomes a typed `TOOL_TIMEOUT`.
 *
 * @param result - the settled dispatch result the tool produced under the deadline.
 * @returns `true` only when the result is a success carrying the explicit claim.
 */
function claimsPartial(result: ToolExecutionResult): boolean {
  if (result.isError || result.partial !== true) return false
  // A claim with nothing readable behind it still has nothing to show. Honouring
  // it would hand the model an empty success — "no matches found" — for a call
  // that actually ran out of time. The claim asserts the content is incomplete,
  // not that an empty result is a result, so both conditions are required.
  return result.content.some(block => block.type === 'text' && block.text.trim() !== '')
}

/**
 * Decide what the model sees when this plugin's deadline won and the tool has
 * reached quiescence. Extracted as a pure function so the rule is testable on
 * its own and cannot drift from its documentation.
 *
 * @param result - the settled dispatch result the tool produced.
 * @param timeoutMs - the elapsed budget, used only for the replacement message.
 * @returns the tool's own claimed-partial result, or a structured `TOOL_TIMEOUT`
 *   when the tool made no such claim.
 */
export function quiescentTimeoutOutcome(
  result: ToolExecutionResult,
  timeoutMs: number,
): ToolExecutionResult {
  return claimsPartial(result) ? result : toolTimeoutResult(timeoutMs)
}

/**
 * Register the timeout wrapper. It resolves the caller-visible tool definition,
 * temporarily replaces `exec.signal`, delegates, restores the upstream signal,
 * and replaces the result only when this wrapper's own timer fired.
 */
export function apply(ctx: Context): void {
  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const timeoutMs = ctx.tools.get(exec.name, exec.agent)?.timeoutMs
    // A tool that declares no budget: no deadline, delegate unchanged.
    if (timeoutMs === undefined) return next()

    using d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)
    // Swap the derived deadline onto exec for dispatch, then restore the
    // caller's own signal so post-execute listeners never see this plugin's
    // (possibly already-aborted) timeout signal.
    const upstream = exec.signal
    exec.signal = d.signal
    try {
      const result = await next()
      // If OUR timer fired (scoped by code — a nested outer deadline reads as
      // undefined here), the tool/capability saw the abort and reached
      // quiescence. What it returned then decides the shape:
      //
      // - nothing usable (an error, or a success with no readable text): replace
      //   it with the structured TOOL_TIMEOUT, so an empty timeout stays a hard
      //   typed failure rather than a persuasive "no results found".
      // - a success carrying text: PRESERVE it. The tool reached quiescence
      //   holding real work and labelled it as partial itself, because it alone
      //   knows which page it stopped on. Overwriting here is what turned a
      //   partial search into a total loss.
      if (timeoutOf(d.signal, TOOL_TIMEOUT) !== undefined) {
        return quiescentTimeoutOutcome(result, timeoutMs)
      }
      return result
    } finally {
      exec.signal = upstream
    }
  })
}
