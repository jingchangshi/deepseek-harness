# Agent Note: Degenerate output guard

Status: implemented

English | [中文](2026-09-19-degenerate-output-guard.zh.md)

## Problem

A model step can collapse into a repetition loop inside its reasoning block and burn the entire per-request output budget without emitting a single text block or tool call. The step then settles as `max-tokens`, the turn ends, and all work in that turn is lost.

Two occurrences in one recorded session (`session.v3.jsonl`, attached to the report) quantify the failure:

| Event | Turn/step | Reasoning chars | Lines | Distinct lines | Output tokens |
|---|---|---|---|---|---|
| seq 704 | 2 / 122 | 480,942 | 47,267 | 129 | 128,000 (cap) |
| seq 1546 | 4 / 48 | 326,793 | 30,066 | 142 | 85,195 |

Both blocks are a small phrase cycle repeated to exhaustion — `Let me write.` ×15,708, `Writing.` ×15,695, `Go.` ×7,856, `OK.` ×7,853. The dominant cycle period is 6 lines in the first event and 4 in the second.

The collapse is a sharp phase transition, not a gradual decay. In seq 704 the last coherent reasoning ends at line 200 (~10,100 chars, ~2,500 tokens); every 5,000-line window after that contains exactly 4 distinct lines. In seq 1546 the transition is at line 250 (~13,500 chars). Repetition accounts for roughly 97% of the burned budget and the healthy prefix for the remainder.

The failure is invisible to every existing guard: `repeat-tool-reminder` keys on `(tool name, canonical arguments)` and cannot see a step that issues no tool call; `compaction-basic` manages request-side pressure and never inspects live output; the step produces no text, so the turn closes with nothing to continue from; and `goal-round-driver` treats `max-tokens` as a stop condition and disarms automatic continuation, so a Goal session stays disarmed until a human runs `/goal resume`.

## Decision

`packages/guard/degenerate-output-guard` watches the live assistant stream, judges a trailing character window by its line structure, and cancels the generation at the detection point, preserving everything already streamed. Detection and intervention are separate phases: the `agent/assistant-stream` listener only detects and cancels; every recovery decision runs in the `turn/end` handler, after the aborted turn has settled, where appending is legal again.

The shipped rungs under `onDetect` are `observe` (record only — the base bundle's rollout default), `abort-only` (cancel, no followup), and `abort-and-continue` (cancel, then one bounded corrective followup). The proposal's per-turn `maxInterventionsPerTurn` became `maxRecoveryAttempts`, a budget over the recovery chain — the consecutive turns whose input was the guard's own notice — because the corrective turn is its own turn, so a per-turn bound never engages. `applyTo` defaults to `reasoning`, not `both`: the recorded failures are reasoning collapses, and text-answer streams carry legitimate repetitive formatting that would need separate calibration.

## Detection

The detector (`src/detector.ts`) keeps a trailing window of the last `windowChars` characters per watched block, plus the pending delta tail and counters — state bounded by the config, independent of stream length, reset per attempt and per block. Evaluations amortize to every `checkEveryChars` characters, plus one final evaluation at the block boundary, so a collapse that turns suspect only inside the final partial interval is still caught.

An evaluation splits the window into non-empty trimmed lines, skips windows under `minWindowLines`, and first computes the distinct-line ratio: above `distinctLineRatio` the window is healthy and no period scan runs. Otherwise it scans periods `1..cyclePeriodMax` for the best `match(p) = |{i : lines[i] == lines[i-p]}| / (n - p)`; the best fraction at or above `cycleMatchRatio` fires and reports that period.

The measured separation from the recorded session is wide: degenerate windows sit at distinct-line ratio 0.0027–0.0047 while all 308 healthy blocks sit at 0.4925–1.0000. With the shipped thresholds (4,000-char window, `distinctLineRatio` 0.20, `cyclePeriodMax` 12, `cycleMatchRatio` 0.90) the sanitized fixture replays of both recorded shapes trip before 20,000 characters, and the healthy corpus never trips.

## Recovery chain and correlation

The cancellation's hook cause embeds the detection id — `degenerate-output-guard:<agentId>:<turn>/<block>/<charsSeen>` — and the `turn/end` recovery consumes the trip only when the settled reason matches that exact cause. Correlation is by cause, not adjacency: a separately cancelled turn never triggers recovery, and a stream frame for an attempt the guard never saw start is ignored.

The recovery chain resets its depth when a turn claims a message that is not the guard's own notice (a human or driver turn interrupted the chain) and increments only when the guard's own notice is claimed. When an aborted trip settles under `abort-and-continue`, recovery queues a corrective notice only while the depth stays under `maxRecoveryAttempts`; a further degeneration inside the exhausted chain still aborts but logs the budget exhaustion instead of queuing. A pending notice tracked by message id is released with a recorded loss if it is discarded before being claimed, and another producer's message riding in the same claim batch leaves the chain intact.

## Goal integration

When the tripped turn belonged to an armed goal round, the guard snapshots the goal's id and revision at detection. After the aborted turn settles, it re-arms the goal (disarm plus resume with the snapshotted reference) before the goal driver's idle pause check runs, so a guard-aborted round does not pause goal automation. The corrective notice is delivered through `inject` instead of `followup` for an armed goal: the message parks as the next step's input without its own wake, the goal driver's pending reservation supplies the wake, and the notice rides the next round batch. If the goal state drifted between detection and recovery — a different goal, a different revision, a non-active phase — the restore is skipped and recorded rather than guessed.

## Delivery timing

Recovery work runs in a microtask queued from the `turn/end` listener. The microtask runs before the agent loop's idle continuation resumes, which gives three guarantees at once: appends are legal (the turn-end publication has closed), the goal resume lands before the driver's idle pause check, and the queued notice exists before the driver requests its next drive.

## Configuration

Every field is a validated `Config` entry with fail-loud validation in `apply` (non-integers, out-of-range numbers, and `checkEveryChars > windowChars` throw at load). The generated [configuration catalog](../../../../docs/config-catalog.md#deepseek-aidsh-degenerate-output-guard) is authoritative for fields and defaults; the package README documents the operator-facing contract.

## Alternatives considered

**Cap the per-request output budget.** A smaller `maxTokens` on the route bounds the damage per step but does not detect anything, and it truncates legitimately long outputs. The WorkBuddy route still sends no request cap — `configuredMaxTokens` is populated only from a profile-declared `models[].maxTokens` and the catalog's `maxTokens: 128000` is sizing metadata, never a request default — so the cap remains worth setting as defense in depth, not a fix.

**Lower `reasoningEffort`.** The failing route runs `xhigh` on a model whose own declared default is `high`, with `onlyReasoning: true` and `canDisableThinking: false`. Lower effort plausibly lowers the incidence, but it is a probabilistic mitigation with no detection and no recovery.

**Extend `repeat-tool-reminder`.** That guard's design is exact repeated tool calls observed in `tools/post-execute`; a stream-level repetition detector shares no state, event, or threshold with it. Folding both into one package would join two unrelated detections behind one config surface.

**React to `max-tokens` and auto-continue.** Recovering the turn after the full budget is spent re-prompts a model that is still in the loop, so the continuation degenerates again, and it fights `goal-round-driver`, which deliberately disarms on `max-tokens`.

**Change `agent-loop` to cap reasoning length.** A structural per-step reasoning budget would prevent the failure rather than react to it, but it is a loop change for a model-behavior problem and needs a defensible budget for legitimate long reasoning. The stream-listener seam is sufficient.

**Detect on the assembled message instead of the stream.** Evaluating the settled `assistant/message` needs no per-chunk state, but by then the entire budget is spent. Early detection is the point.

## Consequences

- An aborted degenerate step leaves its streamed prefix in history; the guard bounds the retained loop to roughly the detection point instead of the full budget, and the prefix replays to the provider as `thinking`.
- The corrective notice is an ordinary logged user message, so the model-visible-equals-logged rule holds with no new session event, and the client renders it through the existing plugin-notice path.
- Detection and recovery are decoupled: a guard-aborted round re-arms its goal and the notice rides the next goal round, so goal automation survives a collapse without a human `/goal resume`.
- The guard is mounted in the base bundle at the `observe` rung on `reasoning` blocks; switching to `abort-and-continue` and widening `applyTo` are deployment decisions taken after the recorded detections justify them.
- Per-attempt state is bounded by the config (window, pending tail, counters) and lives in memory only; a resumed session starts with empty chain state.
- Thresholds are calibrated on two recorded events; the 104× separation is wide, but two samples from one model route do not establish a false-positive rate for other routes, which is what the `observe` rung measures before enforcement.
- A model that degenerates on every attempt burns the guard's budget too: `maxRecoveryAttempts` bounds this, the turn then ends aborted, and the user sees the notice.
- Line-oriented metrics miss degeneracy without line structure: a cycle that repeats mid-line, or output with no newlines at all, does not trip a line-based window. Character n-gram matching would cover it at higher cost.

## Testing

Detector unit tests cover the threshold boundaries (window size, line minimum, distinct-ratio health, best-period selection, empty deltas, and bounded state growth). Lifecycle tests drive a scripted adapter through detection, synchronous-cancel reentrancy, one-notice recovery, the recovery budget, all three rungs, both block kinds, per-attempt reset, fiber remount, config validation, and the goal-state edges (absent, disarmed, paused, unreadable, refused, drifted, discarded, ride-along, failed delivery). Goal-integration tests mount the goal service and round driver beside the guard and pin goal continuation through an abort, the budget-exhausted pause, the non-goal restore, and the restored-notice re-claim. A sanitized fixture replay of both recorded degenerate shapes trips before 20,000 characters, and the healthy corpus — dense analysis, fenced code, tables, CSV, test vectors, boilerplate, and a repetitive-but-legitimate footer — never trips. `pnpm run test:coverage` holds per-file 100% on the package.
