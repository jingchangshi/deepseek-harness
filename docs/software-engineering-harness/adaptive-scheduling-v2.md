# Adaptive Development scheduling V2 design

English | [中文](adaptive-scheduling-v2.zh.md)

## Summary

This reference describes the completed Phase 3 implementation for adaptive task classification, role scheduling, capability escalation, and writer-failure diagnosis. Its implementation and independent acceptance are complete; remote delivery is recorded in the verification report. The existing [architecture](architecture.md) describes deployed behavior. See the [V2 architecture](architecture-v2.md), [implementation plan](implementation-plan-v2.md), and [acceptance matrix](acceptance-matrix-v2.md) for the surrounding design and delivery requirements.

## Table of Contents

- [Classification and role stages](#classification-and-role-stages)
- [Response and route policy](#response-and-route-policy)
- [Durable escalation](#durable-escalation)
- [Writer diagnosis and crash safety](#writer-diagnosis-and-crash-safety)

-----

<a id="classification-and-role-stages"></a>
## Classification and role stages

The classifier assigns `simple`, `standard`, or `complex` from the request, configured scheduling policy, profile, scope facts, and risk facts. It emits stable reason codes, a digest of its inputs, canonical scope paths, and whether investigation or challenge is required. The same inputs produce the same result. Repository policy belongs to `.agent/config/project.yaml`; it accepts `class`, `scopePaths`, `acceptanceCriteria`, `risks`, `needsInvestigation`, and `needsChallenge`.

Deployment workflow configuration in `<DSH_HOME>/engineering/.agent/config/workflow.yaml` owns the top-level `simpleMaxFiles`, `standardMaxFiles`, `maxCapabilityEscalations`, and `repairEscalationThreshold` limits. Their defaults are 3, 12, 2, and 2. Policy can request `auto`, a class, explicit scope paths and acceptance criteria, risks, investigation, and challenge. Recognized risks include concurrency, lifecycle, security, runtime, compiler IR, and cross-module behavior.

Only canonical explicit file leaves with complete acceptance criteria can qualify as simple. A directory, wildcard, unresolved scope, symlink escape, dirty baseline, compiler profile, `.mlir` or IR scope, explicit high-risk marker, or deterministic bilingual risk marker cannot qualify as simple. Unknown facts promote to at least standard; compiler work, high risks, and unknown legacy scope promote to complex. No policy or unknown legacy state defaults to complex. Out-of-scope changes stop acceptance and require explicit `REPLAN_WITH_SCOPE`; the runtime never silently expands write authority or rolls back user data.

Classification and risk floors are monotonic for the entire task identity. Recovery, cumulative journal requests, scope promotion, policy/config changes, and replan cannot lower them. A new task identity is required to start at a lower floor. Review-only retains its immutable changed-file classification and cannot enter Development.

Simple creates a repository-owned scope-and-criteria artifact and a minimal plan from the complete request and actual verification profile, then runs the configured Implementer, deterministic verification, and independent Reviewer. It makes no claim that an agent inspected source. Standard uses Scouts only when policy requests missing evidence, then runs Architect, Implementer, verification, and Reviewer; Challenger runs only when policy requests it. Complex runs bounded scoped investigation, Architect, Challenger for declared high risks or unknown legacy scope, Implementer, verification, and Reviewer. Existing writer leases, verification bindings, and review requirements apply in every class.

At plan freeze, the runtime writes immutable `.agent/tasks/<taskId>/PLAN-SCHEDULING-<workRevision>.json` with the task identity, revision, and classification used by that plan. `BASELINE.json` separately retains the captured repository HEAD. Before accepting a simple task, the runtime requires HEAD to match that baseline and every changed source path to remain within the frozen file scope. If a task has scheduling history but lacks its work-revision artifact, the runtime blocks acceptance and requires explicit scope information and replanning.

<a id="response-and-route-policy"></a>
## Response and route policy

Structured role output uses a root object containing exactly one `response` branch: success carries the complete existing role output; escalation carries a reason, bounded nonempty details, and partial observations or unresolved questions. Branches reject extra fields. Escalation cannot contain success fields. Model-authored partial observations do not count as source receipts; only runtime-acquired evidence does. The owner unwraps success and validates its artifacts. Escalation raises `CapabilityInsufficientError` before artifact completion and cannot reach a successful task or checkpoint state.

Directly injected executor outputs may retain a validated raw-success compatibility form. Actual `structured_output` uses the new envelope. If a response envelope is present, validate it as that envelope; do not fall back to legacy parsing. Structured schema projection preserves nested `oneOf` constraints.

`FALLBACK` handles classified provider, protocol, or output failures using existing fallback policy after confirmed disposal. It does not indicate insufficient capability. `ESCALATE` follows an explicit capability-insufficient result from a read-only role or a durable writer diagnosis. It uses a distinct deployment-configured route with a validated `capabilityLevel` greater than the failed attempt, including a failed fallback attempt. Legacy routes default to level 0; shipped architecture routes use level 1. The level records deployment capability, not price. Writable roles never escalate directly to another writer.

Deployment roles list stronger routes in `escalationRoutes` and optional bounded stronger-route fallbacks in `escalationFallbackRoutes`; model routes set `capabilityLevel`. Both lists belong to `roles.yaml`, and capability levels belong to `models.yaml` under the user deployment. `capabilityLevel` is a non-negative integer and defaults to 0 when omitted. Escalation routes must be distinct from the role's primary and normal fallback routes, have different provider/model pairs, support the selected reasoning effort, and satisfy data-class and premium-route policy. Route capability must exceed the failed attempt. At most two escalation fallback routes are accepted; each must remain above the primary and normal-fallback capability floor and pass the same route policy. The runtime also filters candidates against the exact failed route capability. Missing or unqualified routes fail visibly, and self-contained configuration errors fail at load. Every physical dispatch records `PRIMARY`, `FALLBACK`, or `ESCALATE`; stronger-route fallback also records its parent escalation ID.

Escalation resumes the affected work with actual partial checkpoint receipts and bounded partial structured output. It retains deadlines and tool limits, consumes model/provider/lifecycle budgets, and does not repeat completed sibling investigations. Provider failure on a stronger route follows its separately bounded fallback policy; it does not start another capability escalation automatically.

<a id="durable-escalation"></a>
## Durable escalation

`SCHEDULING.json` stores classification inputs and digests, class and risk facts, and escalation reservations. Development stores it per task; Review-only stores escalation state in its own namespace and remains read-only. The ledger uses atomic serialized writes and binds records to task and workflow identity. Legacy tasks without a ledger remain complex. Missing, torn, or mismatched history cannot reset a known escalation count or authorize a new escalation.

Each escalation record contains an opaque ID, durable failure key, recovery epoch, subject role, trigger reason, source fingerprint, reservation time, and status: `RESERVED`, `DISPATCHING`, `COMPLETE`, `FAILED`, or `UNCERTAIN`. A new reservation consumes the finite task cap once. `beginDispatch` atomically changes `RESERVED` to `DISPATCHING` and binds the model attempt before child invocation. A reservation interrupted before dispatch may resume once under the same charge. Its durable `dispatchInput` retains the failed route ID, bounded partial assertions, and input digest. When the same role and input digest are requested again, the runtime verifies the source fingerprint, resolves the configured stronger routes, restores the saved partial assertions directly, and dispatches under the existing reservation without repeating the failed primary attempt. An interrupted `DISPATCHING` record is uncertain; no further role or writer starts until stopped-work recovery confirms quiescence.

A completed result is reusable only when its persisted output and source/input fingerprint still match. Failed and uncertain results never authorize a writer. Safe explicit recovery increments a durable recovery epoch; retries create a new charged reservation while the cumulative cap remains unchanged. Uncertain recovery requires `confirmedStopped: true` before the old record can become `FAILED`. Idempotency within an epoch cannot dispatch twice. Failure identity uses the actual failed attempt for capability errors, and verification/review evidence digest, work revision, and failure ordinal for repair or design errors. Distinct failures remain distinct; replay of one durable failure does not double-charge it.

<a id="writer-diagnosis-and-crash-safety"></a>
## Writer diagnosis and crash safety

A writable role never escalates directly to another writer. A writer capability failure, repeated verification/repair failures at the configured threshold, or a Reviewer-confirmed design error creates a diagnosis obligation keyed to the durable failure. The runtime first confirms executor disposal. While the old writer lease is still held, it persists a `PENDING` diagnosis obligation with failure identity and worktree fingerprint. Only after persistence succeeds may it release the lease and admit a read-only Architect diagnosis. A crash before persistence retains the old lease; a crash after persistence but before release retains both lease and obligation and requires stopped-work recovery. A persistence failure retains the lease. Uncertain disposal quarantines the task and cannot create a runnable diagnosis. `RoleQuiescenceError` takes precedence over escalation and diagnosis.

Every run and recovery checks diagnosis obligations before admitting a writer. Diagnosis uses a dedicated output with a summary, evidence-based observations, `REPAIR_WITHIN_PLAN` or `REPLAN` recommendation, repair constraints, and unresolved questions. Capture the actual HEAD and worktree identity before and after diagnosis; any change blocks the result and invalidates it. Diagnosis cannot replace a frozen plan or authorize a writer by itself.

The obligation progresses through `PENDING`, `COMPLETE`, and `APPLIED`. `COMPLETE` means the diagnosis output is durable and remains a writer block. Before `APPLIED`, persist the recommendation to task state and plan intent. The frozen design allows `REPAIR_WITHIN_PLAN` only when its constraints fit the exact current plan; the current runtime conservatively records `REPLAN` for either recommendation and requires a new frozen plan before writer work resumes. It persists the applied recommendation and repair constraints in `DIAGNOSIS-APPLICATION.<sha256(failureKey)>.json` before marking the obligation `APPLIED`. A crash after application but before `APPLIED` repeats an idempotent, digest-bound application without another diagnosis dispatch. Only an `APPLIED` obligation permits writer admission.

Workflow interruption tests cover resuming a `RESERVED` Development or Review-only escalation, resuming an interrupted frozen plan, and retaining original scope after a reviewed unexpected source change. Store tests separately cover reservation compare-and-swap, diagnosis-application replay before `APPLIED`, source-fingerprint checks, and writer admission while a diagnosis remains pending. Capability-dispatch tests verify that a diagnosis obligation is persisted before releasing a stopped writer and that persistence failure retains the lease. Additional workflow tests interrupt the writer after its pending obligation is persisted but before lease release, after diagnosis completion but before application, and after application journaling but before `APPLIED`. Resumption reuses the completed diagnosis and its charge; uncertain source mutation continues to block writers.
