---
description: "Stream-cycle guard that stops degenerate model output before it exhausts the token budget and queues one bounded corrective followup, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-degenerate-output-guard

English | [中文](README.zh.md)

## Summary

This package catches the failure mode where a model's streamed output collapses into a short cycle of repeated lines and keeps generating until the token budget is exhausted. The guard watches the live stream and cancels a degenerate generation at the detection point, preserving everything already streamed, and under `abort-and-continue` queues one bounded corrective followup. The stream listener only detects and cancels; recovery runs after the aborted turn has settled. The `dsh` base bundle ships the conservative rollout rung — `observe` on `reasoning` blocks — which records without touching the conversation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when long autonomous generations should be protected against repetition collapse. There is nothing to learn or wire: the `dsh` base bundle already runs it, and the shipped default watches reasoning streams in `observe` mode — a deployment earns confidence from the recorded detections before switching the intervention rung.

### When to choose it

Choose it when agents produce long reasoning or text streams unattended and a repetition collapse wastes budget or wedges the loop. Avoid it when output is short (the guard never judges a window under `minWindowLines` lines) or when legitimately repetitive formatting — tables, separators, generated boilerplate — dominates the final window: the detector's distinct-line ratio and exact line-period match are tuned to sharp collapses, but a deployment can always fall back to `observe` while calibrating.

### The three intervention rungs

`onDetect` selects what happens when a window is judged degenerate:

- `observe` (default) — record a structured detection warning; the stream continues untouched. Use this to calibrate thresholds and measure the collapse signature against your workload.
- `abort-only` — cancel the generation and let the turn settle aborted; no followup is queued and the conversation waits for the next human or driver input.
- `abort-and-continue` — cancel, then queue one corrective notice so the agent continues from the useful context in a fresh turn.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-degenerate-output-guard'
  config:
    windowChars: 4000          # trailing window inspected per check
    checkEveryChars: 512       # characters between amortized mid-stream checks
    minWindowLines: 24         # minimum lines before a window is judged
    distinctLineRatio: 0.20    # above this distinct-line ratio the window is healthy
    cyclePeriodMax: 12         # largest line period scanned for a cycle
    cycleMatchRatio: 0.90      # period match fraction required to fire
    onDetect: observe          # observe | abort-only | abort-and-continue
    maxRecoveryAttempts: 1     # corrective followups allowed per recovery chain
    applyTo: reasoning         # reasoning | text | both
```

| Field | Default | Meaning |
|---|---|---|
| `windowChars` | `4000` | Size of the trailing character window each evaluation inspects |
| `checkEveryChars` | `512` | Characters between amortized mid-stream evaluations; the block boundary always evaluates |
| `minWindowLines` | `24` | Non-empty trimmed lines required before a window is judged |
| `distinctLineRatio` | `0.20` | Windows whose distinct-line ratio exceeds this are healthy regardless of periods |
| `cyclePeriodMax` | `12` | Largest line period the scan considers |
| `cycleMatchRatio` | `0.90` | Matched-line fraction required for the detected period to fire |
| `onDetect` | `observe` | Intervention rung at detection |
| `maxRecoveryAttempts` | `1` | Corrective followups allowed per recovery chain — consecutive turns whose input was this guard's own notice |
| `applyTo` | `reasoning` | Which streamed block kinds are watched |

Invalid configuration fails at startup with a clear error — a non-integer or out-of-range number, or `checkEveryChars` exceeding `windowChars` — never a silent change of behavior. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-degenerate-output-guard) documents every accepted value.

### What you get

With the shipped defaults a degenerate reasoning collapse is recorded as a structured warning naming the block, line period, and stream position — no raw text. Once a deployment switches to `abort-and-continue`, the degenerate generation stops at the current position, the turn settles aborted, and a fresh turn begins with a corrective notice that tells the model the previous generation was stopped and asks it to continue from the useful context with a tool call or a result. The recovery chain allows at most `maxRecoveryAttempts` consecutive automatic corrections, so the guard can never retry-loop itself; a human message in between renews the budget.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the guard detects cycles, how the two-phase abort-and-recover design works, and how it integrates with the goal driver; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The guard is built on five commitments:

- **Two phases, one decision point.** The stream listener only detects and cancels — it marks the tripped state before cancelling and never queues recovery work mid-stream. Recovery runs in the `turn/end` handler, after the aborted turn has settled, where appending is legal again.
- **Bounded memory.** Each watched block holds only its trailing window (`windowChars`), the pending delta tail, and counters — independent of stream length — and per-attempt state resets when a new stream starts.
- **Structured telemetry only.** Detection records carry the block kind, line period, matched fraction, stream position, and identifiers; raw stream text never reaches the log.
- **Fail loud at load.** Every config range validates in `apply` and throws, never falling back to defaults.
- **Correlation by cause, not adjacency.** The cancellation's hook cause embeds the detection id (`degenerate-output-guard:<agentId>:<turn>/<block>/<charsSeen>`), and the `turn/end` recovery consumes the trip only when the settled reason matches that exact cause — a separately cancelled turn never triggers recovery.

### Detection: the trailing window

The detector (in `src/detector.ts`) keeps a trailing window of the last `windowChars` characters. Each evaluation takes the non-empty trimmed lines of the window and first computes the distinct-line ratio: unique lines over total lines. Above `distinctLineRatio` the window is healthy — varied prose exits immediately without a period scan. Otherwise the scan computes, for every period `p` from 1 to `cyclePeriodMax`, the fraction of lines equal to their predecessor `p` lines back; the best fraction at or above `cycleMatchRatio` fires, and the fire reports that period. Evaluations amortize to every `checkEveryChars` of accumulated input, plus one final evaluation at the block boundary — a collapse that turns suspect only inside the final partial interval is still caught.

### The recovery chain

Recovery correlates consecutive guard-stopped turns into one chain. The chain's depth resets when a turn claims a message that is not the guard's own notice (a human or driver turn interrupted the chain) and increments only when the guard's own notice is claimed. When an aborted trip settles and `onDetect` is `abort-and-continue`, recovery queues a corrective notice only while `depth` stays under `maxRecoveryAttempts`; a further degeneration inside the exhausted chain still aborts but logs the budget exhaustion instead of queuing. The pending notice is tracked by message id: if it is discarded before being claimed, the guard releases the chain slot and records the loss; if another producer's message rides in the same claim batch, the chain stays intact.

### Goal integration

When the tripped turn belonged to an armed goal round, the guard snapshots the goal's id and revision at detection. After the aborted turn settles, it re-arms the goal (disarm + resume with the snapshotted reference) before the goal driver's idle pause check runs, so a guard-aborted round does not pause the goal automation. The corrective notice is delivered through `inject` instead of `followup` for an armed goal: the message parks as the next step's input without its own wake, so the goal driver's pending reservation supplies the wake and the notice rides the next round batch. If the goal state drifted between detection and recovery — a different goal, a different revision, a non-active phase — the restore is skipped and recorded rather than guessed.

### Delivery timing

The recovery work runs in a microtask queued from the `turn/end` listener. The microtask runs before the agent loop's idle continuation resumes, which gives three guarantees at once: appends are legal (the turn-end publication has closed), the goal resume lands before the driver's idle pause check, and the queued notice exists before the driver requests its next drive.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, stream/turn/inbox listeners, recovery chain |
| [`src/detector.ts`](src/detector.ts) | The trailing-window repetition detector and its tuning |
| — | No runtime invariant companion is published; the guard's state is private per-agent bookkeeping and exposes no package-owned event or snapshot that an independent companion can observe. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the agent loop's inbox events to exhaustive configuration and the guard group map.

- [Core subsystem reference](../../../docs/subsystems/core.md) — the agent loop, inbox claim/discard notifications, and hook cancellation cause this guard consumes.
- [Goal subsystem reference](../../../docs/subsystems/goal.md) — the goal phases, disarm/resume references, and round driver the recovery cooperates with.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-degenerate-output-guard) — every accepted config field and its source declaration.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

### Observe and abort-only rungs

#### What the model sees

Nothing. No tool schema, no message, no prompt text is added; the detection warning goes to the deployment log only.

#### Token effect

Zero tokens. The guard holds no model-visible state.

#### KV Cache effect

None: these rungs add no model-visible content, so there is nothing to cache.

### Corrective notice (abort-and-continue)

#### What the model sees

After an aborted degenerate turn, the next turn's input carries the notice below, with `<period>` the detected line period and `<lines>` the repeated-line count in the final window. The notice is a `user/message` attributed to the plugin, so the model reads it like any other message. The text is pinned verbatim:

##### Corrective notice

```markdown
The previous generation entered a short repetition cycle (period <period>, ~<lines> repeated lines in the final window) and was stopped before it exhausted the output budget.
Do not restate the plan or continue the stopped reasoning. Continue from the useful context and either:
1. execute the required tool/action, or
2. provide the requested result.
```

#### Token effect

The notice is retained history for that agent; its text is fixed, so the added tokens are constant per notice and bounded by `maxRecoveryAttempts` per recovery chain.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **Exact-line detection only** — the period scan compares whole trimmed lines, so a cycle whose lines drift slightly (a counter, a timestamp) stays under `cycleMatchRatio`; fuzzy matching is rejected pending evidence of need.
- **In-memory state only** — a session resumed from persistence starts with empty chain state; the guard is a runtime guard, not a logged invariant.
- **The final window is the only evidence** — a collapse whose onset falls entirely before the trailing window is invisible until the cycle dominates it.
- **Recovery reuses the same model** — a corrective turn can degenerate again; the budget bounds the retries but does not improve them.
- **`text` blocks ship uncalibrated** — `applyTo: 'text'` watches answer streams with the same thresholds tuned for reasoning; calibrate per deployment before enabling it in a shipped profile.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The [degenerate-output-guard feature note](../../../.agents/notes/implemented/feature/2026-09-19-degenerate-output-guard.md) records the design decisions behind the two-phase abort, the cross-turn budget, the goal re-arm ordering, and the rollout plan.

</details>
