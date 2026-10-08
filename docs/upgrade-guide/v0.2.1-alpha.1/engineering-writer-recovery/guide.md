---
kind: upgrade-guide
description: Uncertain child cleanup retains engineering writer authority until confirmed recovery.
---

# Engineering Writer Recovery

English | [中文](guide.zh.md)

## Change

When role-child cleanup cannot confirm that work stopped, the task retains its active writer lease. Repository-wide writer admission prevents same-task or other-task work from dispatching while a writer or uncertain termination remains. `engineering_recover` rejects missing stop confirmation for this state, then releases the lease only after the operator confirms that the agent and its commands have stopped. Direct replanning also rejects an active writer and leaves its lease intact.

## Migration

1. When `engineering_run` returns `requiresStopConfirmation: true`, stop the previous agent and all command work it owns. Do not use a cancellation request alone as proof that they stopped.
2. Call `engineering_recover` with the exact `taskId` and `confirmedStopped: true`. Confirm the result reports `REPLAN` with `writer: null`, then resume the task through `engineering_run`.
3. For a task that does not require stopped-work confirmation, pass `confirmedStopped: false`. Use direct `agentctl replan` only when the task has no active writer or uncertain-stop blocker; it no longer clears a writer lease.
