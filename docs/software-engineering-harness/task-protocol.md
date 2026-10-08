# Engineering Task Protocol

English | [中文](task-protocol.zh.md)

This reference defines the repository artifacts, state transitions, and current `agentctl` source-launch commands for the [frozen engineering harness](architecture.md). The repository record remains authoritative when a DSH Session or process is unavailable.

## Summary

Each task has immutable metadata, one revisioned state record, and schema-validated stage artifacts. Writers use compare-and-set revisions under a cross-process file lock. Artifact files are replaced atomically before `STATE.json`, so an interrupted state commit leaves the previous authoritative revision readable.

## Table of Contents

- [Repository files](#repository-files)
- [State transitions](#state-transitions)
- [Revisions and writers](#revisions-and-writers)
- [Verification and review](#verification-and-review)
- [Acceptance](#acceptance)
- [CLI](#cli)
- [Recovery](#recovery)

-----

<a id="repository-files"></a>
## Repository files

Task directories live at `.agent/tasks/<task-id>/`. `TASK.yaml` contains immutable task identity, profile, data class, and creation time. A profile ID is a nonempty string of lowercase ASCII letters, digits, and hyphens that starts with a letter or digit; whitespace and path separators are invalid. Task creation requires `.agent/profiles/<id>.yaml` with a matching `id`, supported schema version, and valid gate definitions before writing task metadata or state. Automatic project loading validates the same declaration, and resumed tasks retain their original profile. `STATE.json` contains the current state, repository revision, frozen work revision, bounded-fix count, optional writer lease, and update time.

Stage commands write `BASELINE.json`, `INVESTIGATION.json`, `PLAN.json`, `VERIFY.json`, `REVIEW.json`, and `DECISION.json`. Schemas in `.agent/schemas/` reject unknown fields and malformed values. `EVIDENCE.jsonl` entries use `evidence.schema.json`; evidence append and command execution arrive with the verification-profile stage.

<a id="state-transitions"></a>
## State transitions

The normal path is:

```text
NEW -> BASELINED -> INVESTIGATED -> PLAN_FROZEN -> IMPLEMENTING
IMPLEMENTING -> VERIFYING -> VERIFIED -> REVIEWING -> REVIEWED -> ACCEPTED
```

`REPLAN` returns to `INVESTIGATED` through a new investigation. Any nonterminal task can become `BLOCKED`. `ACCEPTED` is terminal, so repeated acceptance and later mutation fail.

`engineering_run` returns `nextAction` with its status. `WAIT_FOR_CURRENT_RUN` means another run owns this repository; no additional task, role, writer, or command starts. `RECOVER` forbids an unchanged repeat and requires operator stop confirmation before `engineering_recover` only when `requiresStopConfirmation` is `true`. A `false` value means owned work already reached quiescence, so recovery proceeds without that confirmation. `REPLAN_WITH_SCOPE` requires missing product information rather than a mechanical retry. A verified plan with an acceptance-blocking assumption enters `BLOCKED` with this action and no stop confirmation; supplying changed scope to the same task explicitly replans it. Repeated calls naming a `BLOCKED` task return its blocker without dispatch. `NONE` accompanies terminal acceptance.

An interrupted writer or uncertain child cleanup requires `RECOVER` with `requiresStopConfirmation: true`. Durable state can retain an `IMPLEMENTING` writer even after the model call returns. Do not dispatch another task while any task holds a writer or records uncertain termination.

Replay identity uses the durable Session ID, tool call ID, logged call sequence, and canonical repository path, not request text. The sequence distinguishes later model calls that reuse an ID; direct API callers without a logged sequence must supply a stable distinct call ID themselves. Runtime-owned receipts under `.dsh/engineering/.runtime/invocations/` record the invocation claim before effects, then its selected task and completed result. Concurrent replay joins the in-process operation; completed replay returns the recorded result. An unfinished durable claim after process loss requires explicit recovery rather than starting another workflow. A new tool call with identical text is a distinct invocation.

<a id="revisions-and-writers"></a>
## Revisions and writers

Every mutating command requires `--revision <current>`. The store acquires `STATE.json.lock`, reloads and validates current state, and rejects a stale revision before writing. Each successful transition increments the revision exactly once; `verify` and `review` each perform two explicit transitions and therefore increment it twice.

`implement` creates one opaque writer token. `verify` must present that exact token, clears the lease, and enters `VERIFYING`. A task cannot acquire another lease while one is active. Only the implementer operation creates a writer lease.

Repository-wide writer admission serializes writer acquisition and checks every task state before a role dispatch or direct `agentctl implement`. An existing writer or uncertain-stop blocker prevents work on the same or another task. Direct `replan` and `block` reject an active writer; they never clear its lease. Use `engineering_recover` to recover an interrupted writer after the operator confirms that its agent and commands have stopped.

Freezing a plan increments `workRevision` and resets `fixAttempts`. Plan, verification, and review artifacts carry the work revision they evaluate. Acceptance rejects artifacts from any other work revision.

<a id="verification-and-review"></a>
## Verification and review

Verification status is exactly `PASS`, `FAIL`, `NOT_RUN`, or `INCOMPLETE`. Only `PASS` enters `VERIFIED`; every other status consumes one bounded fix. The first failed round returns to `IMPLEMENTING`, while the second enters `REPLAN`.

Review decisions are exactly `ACCEPT`, `FIX_BOUNDED`, `REPLAN`, or `BLOCKED`. `ACCEPT` enters `REVIEWED`. `FIX_BOUNDED` consumes the same bounded-fix counter as verification failure. `BLOCKED` requires a non-empty blocker.

<a id="acceptance"></a>
## Acceptance

`agentctl accept` validates state, plan, verification, review and command evidence under the state writer lock. It requires `REVIEWED`, no writer, matching task and work revision, no blocking plan assumption, verification version 3 with `PASS`, every cumulative required instance passing with matching command evidence, and review decision `ACCEPT`. [Scoped verification](scoped-verification.md) defines instance matching; [source sealing](verification-policy-design.md) defines attempt authority. Acceptance writes `DECISION.json` and commits terminal state.

Reviewer output cannot bypass deterministic checks. A verification document whose top-level status is `PASS` but whose required check failed still cannot be accepted.

<a id="cli"></a>
## CLI

During source development, launch the CLI from the pinned DSH checkout and use `--root` when the target repository is elsewhere:

```sh
cd /absolute/dsh-checkout
node --import tsx/esm tools/agent/agentctl.mjs init --root /absolute/project
node --import tsx/esm tools/agent/agentctl.mjs new task-id --title "Task" --profile webapp --data-class internal --root /absolute/project
node --import tsx/esm tools/agent/agentctl.mjs status task-id --root /absolute/project
```

Artifact commands are `baseline`, `investigate`, `plan`, `verify`, and `review`; each takes `--input <json-file>` and `--revision`. `implement` takes `--revision` and returns the writer token in state. `verify` additionally takes `--writer-token`. `accept` and `replan` take `--revision`.

The CLI uses executable argument arrays internally and does not invoke a platform shell. `verify-profile` runs configured project commands and records their evidence in the target repository.

<a id="recovery"></a>
## Recovery

An interrupted artifact write leaves no partial final file because replacement uses a random sibling and atomic rename. An interruption after artifact replacement but before state replacement leaves the artifact's `taskRevision` ahead of authoritative state; readers ignore it until a successful command publishes that revision. Corrupt or missing artifacts fail validation and never become implicit defaults.

If role-child disposal cannot confirm quiescence, the role call fails as `RoleQuiescenceError` and its writer lease remains active. `engineering_recover` requires `taskId` and `confirmedStopped`. Set `confirmedStopped: true` only after the previous agent and all its command work have actually stopped; recovery then releases the lease, enters `REPLAN`, and clears run counters and verification checkpoints. A fresh `engineering_run` or direct implementation remains blocked until recovery succeeds. For a task with no active writer and no uncertain work, pass `false` when stop confirmation is not required.

## Further Exploration

- [Architecture](architecture.md)
- [Acceptance plan](acceptance-plan.md)
- [Current status](status.md)

## Dev Note

None.
