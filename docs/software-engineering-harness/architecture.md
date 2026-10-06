# Frozen Multi-model Engineering Harness Architecture

English | [中文](architecture.zh.md)

This document describes a software-engineering harness maintained on a DSH branch based on DeepSeek Harness `dsh-v0.2.1-alpha.1`. The implementation belongs outside DSH core and keeps engineering state in the target Git repository. The DSH branch maintains its runtime and project templates under the freeze rules in [Pinned DSH Runtime](dsh-pinned-runtime.md).

## Summary

Named `engineering` and `engineering-run` profiles load an engineering runtime from the pinned DSH checkout. A user starts DSH in the target repository and enters one natural-language requirement. The runtime dispatches fixed-route subagents, while the repository state engine owns task artifacts, transitions, deterministic verification, repair limits, and acceptance. No model output can directly mark a task accepted.

## Table of Contents

- [Pinned basis](#pinned-basis)
- [Responsibility split](#responsibility-split)
- [DSH findings](#dsh-findings)
- [System structure](#system-structure)
- [Role routing](#role-routing)
- [Task protocol](#task-protocol)
- [Execution policy](#execution-policy)
- [Verification and acceptance](#verification-and-acceptance)
- [Data policy](#data-policy)
- [Failure and recovery](#failure-and-recovery)
- [Implementation stages](#implementation-stages)

-----

<a id="pinned-basis"></a>
## Pinned basis

The runtime baseline is tag `dsh-v0.2.1-alpha.1`. The freeze manifest requires its tag and commit reference to resolve identically, verifies that this baseline is an ancestor of the harness branch, and checks the toolchain and listed file hashes. Harness commits may follow the release tag; `HEAD` need not equal that tag. The manifest owns exact versions and hashes.

DSH remains an installed orchestration runtime. The project adds profile overlays, repository configuration, deterministic CLI code, schemas, and documentation. Engineering orchestration stays outside the agent loop. The tool execution API exposes the sequence of an existing logged call for durable invocation receipts; it does not add or change released Session fields.

<a id="responsibility-split"></a>
## Responsibility split

| Owner | Responsibilities | Not authoritative for |
|---|---|---|
| DSH | LLM adapters, profile composition, subagents, workflows, jobs, goals, tool execution, Session logs | Engineering task state or final acceptance |
| Project orchestration | Role routing, stage selection, bounded repair policy, one-writer admission | Test correctness or model-provider behavior |
| Models | Investigation, architecture proposals, implementation, challenge, review | State transitions, deterministic results, acceptance |
| Deterministic harness | Commands, exit status, structured result capture, scope matrices, timeouts | Choosing product intent |
| Git repository | Task artifacts, revisions, evidence, decisions, configuration, freeze manifest | Live DSH process state |

The repository state machine is the only authority for engineering progress. DSH Session history remains useful diagnostic and conversational evidence but cannot replace the repository artifacts.

<a id="dsh-findings"></a>
## DSH findings

The pinned source supports role-specific child `agentOptions`, persona, tool filtering, and a maximum depth when the selected subagent backend advertises those capabilities. The engineering runtime invokes that service directly; the Coordinator receives engineering workflow tools instead of independently callable role tools.

The in-process `spawn` backend starts a fresh child without parent conversation and supports route options, persona, tool filtering, structured output, and numeric depth enforcement. It is the default backend for fixed roles. A configured `maxDepth: 1` permits only direct children. The `dsh-subagent` service also caps resident continuable children, but that cap does not cover one-shot or external-provider runs.

The DSH SDK backend starts a complete child Harness process and supports route options only. It rejects persona, tool filtering, structured output, and numeric depth constraints. A role that uses this backend must express tool and recursion policy in the child profile and must use `maxDepth: provider-managed`; the initial implementation does not use it for ordinary roles.

The workflow engine is foreground-only and has no journal or restart resume. It can enforce `maxConcurrentAgents`, `maxTotalAgents`, and per-call item limits, so the project configures `maxConcurrentAgents: 3` and uses workflow only for genuine fan-out. Workflow output never becomes repository task state without `agentctl` validation.

Ralph runs a bounded sequence of fresh children over one immutable objective and carries only a structured handoff between rounds. Its completion is a worker self-report, it has no independent evaluator, and it is disabled in shipped defaults. The project enables it only in an explicit overlay and never treats its terminal status as acceptance.

DSH Goal persists one same-session objective in the Session log, while continuation authority is process-local. It is suitable for resuming a coordinator conversation but not for repository workflow state. Local jobs are process-local and disappear with the Harness process; their configurable per-owner limit does not provide durable work scheduling.

The `llm-pi-ai` adapter can declare installed providers, OpenAI-compatible gateways, and hand-declared routes. Each exact model can declare its own reasoning-effort keys and wire values. Provider IDs, model IDs, and effort mappings therefore remain configuration data. Credential references resolve through the DSH credential service; secrets do not enter committed configuration.

The pinned package contracts supporting these decisions are:

| Primitive | Source-backed constraint |
|---|---|
| [Agent loop](../../packages/core/agent-loop/README.md) | DSH owns request execution and durable model-visible history; project state stays outside it. |
| [Subagent tool](../../packages/subagent/tool-subagent/README.md) | Instances have distinct names and fixed child route/policy settings. |
| [In-process spawn](../../packages/subagent/subagent-spawn-in-process/README.md) | Fresh children support route, persona, tool, structured-output, and depth policy. |
| [DSH SDK backend](../../packages/subagent/subagent-dsh-sdk/README.md) | Child processes support route options but reject the other start-time policies. |
| [Workflow engine](../../packages/workflow/workflow-ptc/README.md) | Concurrency is bounded, but runs are foreground-only and not journaled. |
| [Ralph tool](../../packages/workflow/tool-ralph/README.md) | Rounds are fresh and bounded; completion remains worker-reported. |
| [Goal service](../../packages/goal/goal/README.md) | Goal state is Session-owned and continuation authority is process-local. |
| [Local jobs](../../packages/jobs/jobs-local/README.md) | Background records and concurrency limits are process-local. |
| [Multi-provider adapter](../../packages/llm/llm-pi-ai/README.md) | Custom gateways and model-specific effort mappings are configuration. |

<a id="system-structure"></a>
## System structure

The DSH branch owns the reusable runtime, generic `.agent/` templates, and data-defined [repository presets](repository-presets.md). Initialization separates repository policy from user deployment configuration and preserves existing task state:

```text
.agent/
  config/          project policy and user-deployment seed templates
  profiles/        repository-defined verification profiles
  roles/           user-deployment persona seed templates
  schemas/         JSON Schemas for committed artifacts
  tasks/<task-id>/ repository task records
  preset.json      initial scaffold identity when explicitly selected
tools/agent/
  runtime/         profile bootstrap and role dispatch
  src/             automatic driver and deterministic state engine
  tests/           unit and real-composition coverage
  profiles/        DSH Cordis overlays
  presets/         independently versioned repository scaffolds
docs/software-engineering-harness/
  ...              architecture, operations, profiles, routing, and security
```

The [installer](operations.md) installs user profiles and a launcher, optionally initializing a repository. File-hash records govern managed profiles and artifact schemas; conflicting managed edits are rejected. Repository policies are missing-only scaffolds, not installer-owned files. Deployment routing and personas never enter repository initialization. Task artifacts remain project-owned and are never template installation targets.

The installed profile bootstraps configured providers, fixes the Coordinator route, and registers `engineering_run`, `engineering_status`, and `engineering_recover`. The automatic driver reads the Session working directory, runs the role sequence, invokes configured commands, and commits through the state engine. `agentctl` exposes the same repository protocol for diagnostics and maintenance, not for the daily path.

<a id="role-routing"></a>
## Role routing

Logical role names are stable; provider and model identifiers are deployment values. User deployment configuration under `<DSH_HOME>/engineering/.agent` owns model routes, role mappings, global data policy, workflow admission limits, and personas. Session cwd selects only the repository project declaration, verification profile, adapters, and task state. Bootstrap and role dispatch use the same user deployment, independently of repository model declarations.

Repository expertise comes from declared [instruction files and skill roots](repository-presets.md#repository-knowledge), not new logical roles or modified deployment personas. Isolated roles receive a logged metadata catalog and read relevant files on demand. The [TileLang preset](tilelang-integration.md) uses the repository's existing documentation and skills.

The bootstrap fixes the Coordinator to its deployment route even when a UI requests another model. Architect, scouts, implementer, challenger, and reviewer each run as a fresh `spawn` child with role-specific model options, persona, result schema, and tools. The default workflow does not dispatch the disabled arbiter. Reviewer runs cannot inherit the Implementer's conversation.

Only the two Scouts run concurrently. Other roles run in sequence under step and role-call budgets. Exactly one active writer lease may exist for a task. Read-only roles do not receive write tools; the Implementer's write executor rejects `.agent`, `.git`, outside-root paths, and symlink aliases. The Implementer may also hold the platform shell tool, whose starting working directory is confined by that same rule; the command body itself stays the deployment sandbox's responsibility. Required project commands remain owned by the deterministic driver.

[Model routing](model-routing.md) configures DeepSeek primary workers and MiMo secondary workers through Magpie, with one Qwen or GLM fallback per worker. A fallback requires child quiescence; Implementer cannot switch after a potentially mutating tool starts. Coordinator, Architect, and Reviewer use GPT-6.1-Sol.

<a id="task-protocol"></a>
## Task protocol

Every task directory contains an immutable task identity and revisioned state. State transitions are pure, explicit, and validated against the latest revision:

```text
NEW -> BASELINED -> INVESTIGATED -> PLAN_FROZEN -> IMPLEMENTING
IMPLEMENTING -> VERIFYING -> VERIFIED -> REVIEWING -> REVIEWED -> ACCEPTED
BASELINED | INVESTIGATED | PLAN_FROZEN | IMPLEMENTING -> REPLAN
VERIFYING | VERIFIED | REVIEWING | REVIEWED | BLOCKED -> REPLAN
any nonterminal state -> BLOCKED
REPLAN -> INVESTIGATED
```

Failed verification returns to `IMPLEMENTING` only while the frozen plan's bounded-fix count is below two. A reviewer decision of `FIX_BOUNDED` increments that count. The second failed bounded repair forces `REPLAN`. `ACCEPTED` has no outgoing transition, and a repeated acceptance is an error.

Each write uses compare-and-set semantics over `revision`. Artifact writes use a temporary sibling file followed by an atomic rename, then update `STATE.json` last. A process interruption can leave an unreferenced temporary file but cannot publish a partial authoritative revision.

[Task protocol](task-protocol.md) defines repository-wide active-run admission, durable Session/tool-call replay receipts, and explicit `nextAction` responses. Replayed calls cannot create another workflow, and `BLOCKED` repetition cannot redispatch roles.

<a id="execution-policy"></a>
## Execution policy

The automatic sequence captures the Git baseline, runs two Scouts concurrently, asks the Architect for a plan, requires Challenger approval, admits one Implementer, runs the selected verification profile, and asks a fresh Reviewer. Every role returns JSON validated against its stage schema. DSH may continue the Coordinator Session, while `engineering_status` reconstructs engineering progress solely from repository artifacts.

Project commands are arrays of executable plus arguments, with an explicit working directory, environment allowlist, timeout, expected outputs, and verification category. The runner does not invoke Bash, PowerShell, `cmd.exe`, or command strings. Compiler adapters may declare Linux-only commands; the state engine and webapp adapters remain portable across Linux and Windows.

<a id="verification-and-acceptance"></a>
## Verification and acceptance

[Scoped verification](scoped-verification.md) defines check-name-and-scope identity, independent instance execution, resolved command evidence, required-instance matching, and explicit verification artifact generations.

[Verification policy design](verification-policy-design.md) specifies deterministic path impact, monotonic acceptance tiers, immutable plan intent, repository-owned source sealing, and separate policy and repository-profile identities.

[Command runners](command-runners.md) defines execution providers, explicit environments, typed argv expansion and termination reporting. Repository declarations select providers; the workflow blocks uncertain termination without inspecting executable names.

Verification results use exactly `PASS`, `FAIL`, `NOT_RUN`, or `INCOMPLETE`. Each result records command identity, start and finish time, exit information, bounded output references, tested scope, and the task revision. A verification profile declares which checks are required for acceptance. Only required checks with `PASS` satisfy the profile; `NOT_RUN` and `INCOMPLETE` never satisfy it.

Compiler results preserve target and mode matrices plus correctness and performance categories. Webapp results preserve typecheck, lint, unit, API, migration, integration, E2E, build, and deployment-smoke categories. A profile may mark a category inapplicable before execution, but a model cannot reinterpret a required missing result.

Acceptance requires all of the following at the same task revision: a frozen plan, a complete verification artifact whose required checks pass, an `ACCEPT` review, no unresolved assumptions marked acceptance-blocking, no active writer lease, and successful artifact/schema validation. `agentctl accept` evaluates these facts and writes the decision; reviewer prose has no direct transition authority.

<a id="data-policy"></a>
## Data policy

Every task is classified as `public`, `internal`, or `sensitive`. Every route declares the highest data class it may receive and whether it is an external relay. Before model dispatch, orchestration computes the requested task class and route allowance. A sensitive task may use only synthetic, anonymized, or explicitly approved input; the approval is a repository artifact naming the data source, route, approver, and expiry.

The policy covers prompts and attached evidence. It does not claim to isolate provider credentials from same-user tool processes; DSH's local credential store explicitly provides discretion rather than an OS security boundary. Secrets remain in credential references or environment injection; deployment review scans committed artifacts for the forbidden categories named in `data-policy.yaml`.

<a id="failure-and-recovery"></a>
## Failure and recovery

Interrupted model work does not advance repository state. `AUTO.json` journals budgets, the pending task identity, and the verified Git HEAD and worktree fingerprint. Resumption rejects a changed requirement unless the task has explicitly entered `REPLAN`, and it never reuses verification after HEAD or project files change. An interrupted writer must be released before another Implementer can run.

Local command cancellation kills the complete POSIX process group and waits for close. Docker cancellation or timeout moves the task to `BLOCKED`: stopping the client cannot establish that work inside an existing container has stopped. After the operator confirms that previous agent and container work ended, `engineering_recover` releases any writer, moves the task to `REPLAN`, and clears the previous run's bounded counters and verification checkpoints under the run lock. Requirements remain attached to the task.

Corrupt or missing authoritative artifacts fail closed. Stale writers cannot publish because revision comparison occurs immediately before the atomic state update. A failed deterministic check cannot be overridden by review or arbitration. Provider-route failures remain model-routing evidence and do not become verification success.

<a id="implementation-stages"></a>
## Implementation stages

Stage A freezes this architecture and the [acceptance plan](acceptance-plan.md). Stage B adds schemas, the state engine, CLI, and focused tests. Stage C adds pinned DSH overlays and fixed role tools. Stage D adds route validation and mock/real smoke commands. Stage E connects orchestration without changing DSH core. Stage F adds compiler and webapp profiles with fake end-to-end examples. Stage G adds recovery and negative coverage. Stage H adds a bounded AscendNPU-IR adapter design and wrappers over existing commands. Stage I records the freeze manifest, completes operations documentation, and runs the final acceptance matrix.

## Further Exploration

- [DSH architecture](../architecture.md)
- [Subagent subsystem](../subsystems/subagent.md)
- [Workflow subsystem](../subsystems/workflow.md)
- [Goal subsystem](../subsystems/goal.md)
- [Jobs subsystem](../subsystems/jobs.md)
- [Provider configuration guide](../user/guide/providers.md)

## Dev Note

None.
