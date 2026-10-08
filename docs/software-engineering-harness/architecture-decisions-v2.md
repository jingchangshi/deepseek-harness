# Engineering Harness V2 Architecture Decisions

English | [中文](architecture-decisions-v2.zh.md)

## Summary

This reference records reusable V2 contracts and their tradeoffs. The [architecture](architecture-v2.md) owns the full design; the [acceptance matrix](acceptance-matrix-v2.md) owns phase requirements. These decisions do not imply that a phase passed acceptance.

## Decisions

| Area | Decision | Tradeoff |
|---|---|---|
| Mutation observation | Observe the actual registered tool body synchronously after visibility, policy, guards, argument validation, and around-dispatch. Resolve effects from typed tool metadata; omitted metadata is potentially mutating. | Conservative defaults can block fallback for undeclared tools, so read tools must declare their effects at their definitions. Tool-name allowlists cannot override metadata. |
| Argument validation | `defineTool` exposes its captured validator for registry dispatch and preserves it for direct execution. Raw definitions use Ajv Draft 7 with strict checks before body observation. | Unsupported schemas fail closed; remote references are not fetched. The validator remains separate from the restricted output-schema compiler so MCP parameter schemas retain general Draft 7 semantics. |
| Observer ownership | Body-start observers are synchronous, scoped registrations with exact disposers. They receive a frozen execution snapshot and resolved effects; exceptions, returned values, or cancellation prevent body entry. | A synchronous listener can delay dispatch. Each retry is a new body start and is observed independently. |
| Presentation | Engineering children use scoped `presentAs('native')` before dispatch. | The runtime uses the existing presentation API; no additional mode is introduced. PTC transport remains potentially mutating, including nested `run_code`. |
| Writer authority | A writer lease remains active when child cleanup cannot establish quiescence. Repository-wide admission blocks dispatch while any writer or uncertain-stop state exists. Recovery releases the lease only after confirmed stop. | Recovery requires an operator action and prevents forward progress while owned work may still run. Direct replan or block cannot erase writer authority. |
| Phase acceptance | A phase passes only with its required primary evidence, independent review, and delivery record. Missing or pending evidence remains `PARTIAL` or `NOT_RUN`. | Focused tests, design approval, or a successful build cannot substitute for unrelated acceptance rows or final delivery evidence. |

## Deferred decisions

Phase 1 implementation, freeze update, and delivery are verified. The review workflow records immutable target and evidence references, and reviewer tools operate with read-only Git authority. Its new negative cases were added with the fixes and have no RED baseline. Phases 2–4 remain unimplemented and unverified. Detailed requirements stay in the [acceptance matrix](acceptance-matrix-v2.md); this page records no implementation choice for those phases.
