---
kind: upgrade-guide
description: Engineering tasks now enforce durable cumulative lifecycle budgets and return BUDGET_EXHAUSTED when a configured limit is reached.
---

# Engineering Lifecycle Budgets

English | [中文](guide.zh.md)

## Change

Engineering tasks now persist cumulative role, model-attempt, provider-request, tool-call, elapsed-time, and optional token usage in `LIFECYCLE.json`. The ledger also records cost uncertainty. When a configured limit prevents another reservation, Development returns `BUDGET_EXHAUSTED` with `nextAction: INCREASE_BUDGET`; Review-only returns `status: BUDGET_EXHAUSTED` without a `nextAction` field. Recovery and replanning preserve the ledger, so the task cannot repeat work under the same exhausted limit. Actual provider usage and outcomes are settled per request. Deployment routes can supply validated pricing estimates; unpriced or incomplete usage remains `UNKNOWN`. `maxKnownCostUsd` fails closed after an unpriced request and is not a billed-spend cap.

## Migration

1. If the deployed defaults are sufficient, no configuration change is required. To raise a limit, edit `<DSH_HOME>/engineering/.agent/config/workflow.yaml` under `lifecycleBudget`, for example `maxProviderRequests` or `maxElapsedMs`. `maxTotalTokens` is optional. Omit `maxKnownCostUsd` unless every dispatched route has verified pricing and complete usage; see [usage accounting](../../../software-engineering-harness/usage-evaluation-v2.md). It fails closed after an unpriced request and does not cap billed spend. If logical invocations are limited by project `maxRoleCalls`, increase that field in the target repository's `.agent/config/project.yaml` too.
2. Restart the engineering profile so it loads the updated deployment configuration.
3. For a Development task that returned `BUDGET_EXHAUSTED`, call `engineering_recover` with its existing `taskId` and `confirmedStopped: false`, then resume it with `engineering_run` using that `taskId` and no new request. For Review-only, recover with the same review task ID and `confirmedStopped: false`, then call `engineering_review` with the original target selector. Do not delete `LIFECYCLE.json` or edit its counters.
4. Confirm the run advances beyond the exhausted state. The durable ledger retains prior reservations and applies the increased limit to subsequent work.
