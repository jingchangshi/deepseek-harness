# Engineering Harness V2 acceptance matrix

English | [中文](acceptance-matrix-v2.zh.md)

## Summary

This reference freezes required behavior for the [implementation plan](implementation-plan-v2.md). PASS requires primary evidence for every row in a phase. A passing mock, smoke or schema validator cannot substitute for a different evidence class. Phases 3–4 still require implementation and verification.

## Requirement traceability

| ID | Requirement | Required independent evidence |
|---|---|---|
| P0-01 | Unknown Scout bash does not mark mutation | Real registry/runtime regression; demonstrate pre-fix RED |
| P0-02 | Guard, visibility, registration and argument rejection do not mark mutation | Negative dispatch tests, with body-call counters |
| P0-03 | read, grep and lsp remain read-only | Typed-effect body-start tests |
| P0-04 | Quiescent read-only timeout can fallback | Child disposal barrier before fallback starts |
| P0-05 | Actual writer dispatch disables fallback | Side-effect body entered, failed role cannot switch routes |
| P0-06 | Running background work prevents another writer | Controlled stop/disposal barrier and writer admission assertion |
| P0-07 | Concurrent children cannot share mutation state | Two Agent identities with overlapping executions |
| P0-08 | Cancellation, wrapper short-circuit and observer failure stay safe | Registry integration with exact body invocation assertions |
| P0-09 | Raw schema validation precedes observers; undeclared effects are mutating | Invalid raw schema/args and default-effect fixtures |
| P0-10 | Observation is synchronous, scoped and disposable | Multiple/throwing callbacks, callback cancellation, retry and HMR teardown tests |
| P0-11 | Every allowed read tool owns metadata; PTC remains conservative | Real definition inspection, native restriction and nested PTC tests |
| P1-01 | Commit, branch tip, range and resolvable PR targets pin fixed SHAs | Synthetic Git repositories and branch movement after snapshot |
| P1-02 | Snapshot/files/diff/show/history are safe typed tools | Argv and path injection rejection; no shell execution |
| P1-03 | Binary and large output remain explicit and pageable | Binary and oversized synthetic commits; coverage completeness |
| P1-04 | Review-only never dispatches Implementer or writes source | End-to-end runtime test with denied write and unknown bash |
| P1-05 | Findings include severity, failure, change relation and fixed source location | Defective and clean synthetic commits with independent oracle |
| P1-06 | Placeholder, fabricated location and missing scope cannot succeed | Schema-valid but evidence-invalid fixtures return PARTIAL |
| P2-01 | Scout A survives Scout B timeout without repeated investigation | Checkpoint/recovery test counting actual dispatches |
| P2-02 | Snapshot, scope and dependency changes invalidate affected evidence | Selective checkpoint invalidation tests |
| P2-03 | Soft/hard deadlines and tool limits execute in runtime | Controlled clock/barrier tests; no fabricated partial evidence |
| P2-04 | Recover/replan preserves every lifecycle counter | Repeated recovery and concurrent reservation tests |
| P2-05 | Exhaustion stops scheduling and cannot duplicate writer | BUDGET_EXHAUSTED and uncertain shutdown integration |
| P2-06 | Context carries relevant deltas and spill locator errors are actionable | Bounded prompt capture and invalid locator diagnostic test |
| P3-01 | Simple, Standard and Complex choose minimal sufficient stages; Review-only retains its pinned scope and never enters Development | Reproducible class and dispatch traces; Review-only admission rejection ([adaptive design](adaptive-scheduling-v2.md#classification-and-role-stages)) |
| P3-02 | Scope and risk floors are monotonic for one task; only bounded explicit file leaves with complete criteria may be Simple | Recovery, policy-change, replan, dirty-baseline and out-of-scope-write tests ([classification and role stages](adaptive-scheduling-v2.md#classification-and-role-stages)) |
| P3-03 | Structured role output distinguishes complete success from capability escalation; escalation assertions cannot become receipts or successful artifacts | Valid/invalid envelope fixtures, including mixed branches and fabricated success fields ([response and route policy](adaptive-scheduling-v2.md#response-and-route-policy)) |
| P3-04 | Provider FALLBACK remains distinct from higher-capability ESCALATE and follows normal route policy | Provider failure and capability insufficiency traces; stronger-route fallback remains above the failed capability ([response and route policy](adaptive-scheduling-v2.md#response-and-route-policy)) |
| P3-05 | Escalation reservations are finite, durable, idempotent per recovery epoch, and fail closed on uncertain dispatch or missing history | Crash/recovery tests for every ledger state; no duplicate dispatch or limit reset ([durable escalation](adaptive-scheduling-v2.md#durable-escalation)) |
| P3-06 | Writer failure persists a diagnosis obligation while its lease is held; no later writer starts until the recommendation is durably applied | Disposal/persist/release ordering and writer-admission interruption tests ([writer diagnosis](adaptive-scheduling-v2.md#writer-diagnosis-and-crash-safety)) |
| P3-07 | Read-only diagnosis is source-stable and its repair/replan recommendation binds to the current plan and worktree | Source fingerprint, constrained repair, durable REPLAN, and complete/apply crash tests ([writer diagnosis](adaptive-scheduling-v2.md#writer-diagnosis-and-crash-safety)) |
| P4-01 | Actual request usage persists raw and normalized fields | Unit/replay plus available live provider integration |
| P4-02 | Retries, compaction, caching and replay count exactly once | Durable event/request identity fixtures; unknown usage preserved |
| P4-03 | Missing pricing is UNKNOWN; overlap preserves task wall time | Rate-version/cache and overlapping interval fixtures |
| P4-04 | Four strategies share reproducible inputs and independent oracle | Compiler design, MLIR change, Review and injected recovery fixtures |
| P4-05 | Report quality, first-pass, latency, tokens, cost and failures honestly | Benchmark report validation; unavailable real comparison NOT_RUN |
| ALL-01 | Existing safety, presets, verification and routing remain valid | Relevant existing regression suites and pinned-runtime checks |
| ALL-02 | Each phase is reviewed, committed and pushed independently | Independent verdict, exact commands, commit chain and remote SHA |

## Acceptance records

Each phase report records starting/final HEAD, modules, decisions, RED baseline, GREEN and regression commands/results, reviewer verdict, unresolved risks, commits and push confirmation. Initial state is NOT_RUN; partial or missing evidence remains PARTIAL or NOT_RUN. Original private Session ZIP files are diagnostic inputs, not publishable test artifacts. Deterministic fixtures may reproduce their documented failure patterns without claiming to be original Session evidence.
