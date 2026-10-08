# Bounded Investigation and Lifecycle Budgets

English | [中文](bounded-investigation.zh.md)

## Summary

Deployment owners set per-role deadlines, tool limits, cumulative task budgets, and context and investigation bounds. Read-only Scout work is split into scoped units whose verified evidence can be resumed when the task scope and source files still match.

## Table of Contents

- [Deployment limits](#deployment-limits)
- [Investigation units](#investigation-units)
- [Checkpoints and reuse](#checkpoints-and-reuse)
- [Budget exhaustion and recovery](#budget-exhaustion-and-recovery)
- [Further Exploration](#further-exploration)

<a id="deployment-limits"></a>
## Deployment limits

Set runtime limits in the deployed engineering profile's `.agent/config/workflow.yaml`. The values below match the validated defaults. Optional token and cost limits remain omitted unless the deployment owner explicitly selects them.

```yaml
lifecycleBudget:
  maxLogicalInvocations: 60
  maxModelAttempts: 120
  maxProviderRequests: 600
  maxToolCalls: 1200
  maxElapsedMs: 7200000
roleBounds:
  scout-primary:
    softDeadlineMs: 90000
    hardDeadlineMs: 240000
    maxToolCalls: 40
  scout-secondary:
    softDeadlineMs: 90000
    hardDeadlineMs: 240000
    maxToolCalls: 40
  architect:
    softDeadlineMs: 300000
    hardDeadlineMs: 480000
    maxToolCalls: 40
  challenger:
    softDeadlineMs: 180000
    hardDeadlineMs: 300000
    maxToolCalls: 30
  reviewer:
    softDeadlineMs: 300000
    hardDeadlineMs: 600000
    maxToolCalls: 50
  implementer:
    softDeadlineMs: 300000
    hardDeadlineMs: 600000
    maxToolCalls: 100
maxInvestigationPaths: 40
maxRoleContextBytes: 32768
```

`lifecycleBudget` applies cumulatively to one development or Review-only task across retries, recovery, and replanning. It counts logical role invocations, model-route attempts, final adapter requests, tool executions, elapsed time, and observed tokens. `maxLogicalInvocations` is also capped by the project `maxRoleCalls` in `.agent/config/project.yaml`. Omitted `maxTotalTokens` and `maxKnownCostUsd` disable those ceilings. The ledger records unknown usage and cost as unknown; a configured ceiling that depends on unknown data blocks another provider request.

The lifecycle ledger does not calculate provider prices. `knownCostUsd` is a known subtotal and currently remains zero; it does not assert zero spend. Because reserved provider requests have no price attribution, an enabled `maxKnownCostUsd` allows an initial request only when the ledger has no prior request or historical unknown-cost state, then blocks later provider dispatch as `unknownCost`. Do not use this field as a spend cap until provider price accounting is available.

`roleBounds` sets limits for each known role. A soft deadline asks the child for a structured handoff with evidence obtained so far; it cannot force a partial result. The hard deadline cancels the child and waits for cleanup. `maxToolCalls` is enforced at tool execution. A logical invocation and its configured fallback attempts share the same role limits. The soft deadline must be less than the hard deadline.

`maxInvestigationPaths` limits source files in each investigation unit and bounds automatic Scout partitioning. `maxRoleContextBytes` limits the serialized role context; oversized context is written to a task-owned file and replaced by a digest-bound reference. Both settings require positive integers.

<a id="investigation-units"></a>
## Investigation units

The project owner may assign one or two explicit Scout questions in `.agent/config/project.yaml`:

```yaml
investigationUnits:
  - id: api-flow
    role: scout-primary
    question: Trace the request validation and dispatch path.
    allowedPaths:
      - packages/api/src
```

Each unit names a unique ID, Scout role, question, and non-empty repository-relative `allowedPaths`. Two units must use different Scout roles and non-overlapping paths. Scope paths cannot traverse outside the repository, enter `.git` or `.agent`, or follow symlinks. When `investigationUnits` is absent, the runtime derives bounded Scout work from tracked source files; projects with a larger scope must provide explicit questions and paths.

<a id="checkpoints-and-reuse"></a>
## Checkpoints and reuse

The runtime records inspection receipts from successful read-tool results, including the path and source-content hash. It stores a unit checkpoint under that task's `checkpoints/` directory. A completed unit also requires validated structured output; model statements alone do not count as inspected evidence.

For Development Scouts, the runtime compares the task question and unit scope, repository snapshot, scope membership, and each source hash before reuse. A matching checkpoint can be reused after a revision change. A changed question, path set, source file, or scope membership invalidates that unit. A partial Development checkpoint supplies only its recorded evidence to a later attempt.

For Review-only Scouts, a completed checkpoint is bound to the immutable Git snapshot and changed-path scope. Before reuse, the runtime checks each retained Git page, its actual tool-execution receipt, and the review output against deterministic evidence rules. A complete valid sibling checkpoint can be reused after recovery; an incomplete Scout is dispatched again. A different snapshot or changed scope cannot reuse the checkpoint. Scout checkpoints never authorize writer work.

<a id="budget-exhaustion-and-recovery"></a>
## Budget exhaustion and recovery

When a cumulative or per-role budget is exhausted during Development, the task enters `BUDGET_EXHAUSTED` and `engineering_run` returns `nextAction: INCREASE_BUDGET`. Review-only returns `status: BUDGET_EXHAUSTED` without a `nextAction` field. In either workflow, increase the applicable deployment or project limit before recovery. Then call `engineering_recover` with the same task ID and `confirmedStopped: false`. Resume Development with `engineering_run`; resume Review-only with `engineering_review`, the same task ID, and its original target selector. The runtime does not fall back to another model route after a lifecycle budget rejection. The durable `LIFECYCLE.json` counters survive recovery and replanning; changing limits does not erase prior usage. See [task protocol](task-protocol.md#recovery) for state handling.

The lifecycle ledger observes final LLM adapter dispatches. An awaited pre-dispatch event can reject a request before the adapter is called; post-dispatch records the latest usage chunk and outcome after the adapter iterator closes. Requests short-circuited by replay do not reach these events. SDK-internal HTTP retries are not individually observed and remain unknown to the ledger.

<a id="further-exploration"></a>
## Further Exploration

- [Engineering task protocol](task-protocol.md)
- [Engineering architecture](architecture.md)
