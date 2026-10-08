# Engineering Harness V2 implementation plan

English | [中文](implementation-plan-v2.zh.md)

## Summary

This reference defines delivery order for the [V2 architecture](architecture-v2.md). Each phase requires independent tests, observed RED results where applicable, implementation, GREEN results, regression checks and independent review before commit and push to the target branch. The Phase 4 design is frozen; production implementation and verification remain unstarted. See the [usage accounting and evaluation design](usage-evaluation-v2.md). [Acceptance criteria](acceptance-matrix-v2.md) cannot be weakened to match an implementation.

## Baseline and execution

Preserve existing untracked indexing caches. The target branch is ascendnpu-engineering-harness in jingchangshi/deepseek-harness. The target fork is configured as remote jcshi; origin identifies the upstream repository and must not receive these pushes. Record exact starting/final commit IDs, command evidence and remote confirmation in a machine-readable delivery artifact. Keep raw Sessions and credentials outside Git.

The main agent owns interfaces and acceptance. A read-only Scout investigates the tool pipeline. An independent Test Designer writes tests before a separate Implementer edits production code. An independent Reviewer inspects primary design and implementation evidence. The configured worker model is unavailable in this environment; use supported subagents and record actual model/role assignments without claiming the unavailable worker ran.

## Phase order

| Phase | Production scope | Delivery condition |
|---|---|---|
| 0 | Tool registry dispatch metadata and runtime mutation observation | Authorized validated dispatch only; no unsafe writer fallback |
| 1 | Typed Git evidence and separate Review-only task lifecycle | Immutable SHA, validated evidence, no Implementer or source writes |
| 2 | Work units, durable checkpoints and task lifecycle budgets | Runtime bounds and cumulative recovery accounting |
| 3 | Auditable adaptive task classification, minimal role stages, and distinct capability escalation | Monotonic classification floor, finite durable escalation, and crash-safe writer diagnosis; required tests are listed in the [acceptance matrix](acceptance-matrix-v2.md) and [adaptive scheduling design](adaptive-scheduling-v2.md) |
| 4 | Request usage ledger and reproducible benchmark runner ([frozen design](usage-evaluation-v2.md)) | Deduplicated actual usage and independent E2E or explicit NOT_RUN |

No phase begins production implementation before the preceding phase passes acceptance. Architecture review precedes Phase 0 implementation. Test creation may expose missing new capabilities; record these as capability RED rather than an existing regression. Production corrections must not edit independent test expectations to accept wrong behavior.

Phase 3 implementation starts only after its frozen interfaces and independent RED tests are approved. The [adaptive scheduling design](adaptive-scheduling-v2.md) owns classification floors, success and escalation responses, durable escalation states, and writer-diagnosis crash ordering.

## Validation and delivery

Use focused tools/agent Vitest suites, changed core-package tests, TypeScript, lint and documentation checks selected from the actual diff. Tool-pipeline API changes update owning README/JSDoc and consumers. Product-visible changes require recorded output evidence. Preserve pinned-runtime integrity deliberately: update managed hashes only for reviewed intended changes and test the freeze checks. Each accepted milestone contains explicit-file commits and a normal non-force push after checking remote ancestry; verify the resulting remote SHA.

## Evidence ownership

The acceptance matrix owns requirement identifiers and test obligations. Phase verification reports own executed commands, RED/GREEN/regression results, independent review decisions and unresolved risks. A machine-readable status report owns commit/push identities. Runtime logs, Session ZIP contents and credentials are excluded from committed reports. Documentation records whether a design is proposed or frozen, and claims implementation only when primary evidence supports it.

## Public tool API delivery

Phase 0 updates tool-definition validation/effect metadata and registry observation. Update the owning README pair, JSDoc, subsystem reference, applicable recorded-output evidence and an upgrade guide for raw invalid-argument rejection. Independent tests cover the captured defineTool schema and raw full-schema behavior. No output-schema subset restriction may silently alter upstream MCP parameter schemas.
