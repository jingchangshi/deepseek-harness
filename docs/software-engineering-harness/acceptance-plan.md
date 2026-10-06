# Frozen Engineering Harness Acceptance Plan

English | [中文](acceptance-plan.zh.md)

This plan defines falsifiable evidence for each implementation stage of the [frozen multi-model engineering harness](architecture.md). A stage is complete only when every required check has current evidence; absence, `NOT_RUN`, and `INCOMPLETE` are not success.

## Summary

Acceptance combines focused unit tests, invalid-case tests, mock model routes, fake compiler and webapp repositories, configuration inspection, and separately invoked real-provider smoke tests. The final decision is produced by `agentctl accept` from repository artifacts, never by model prose.

## Table of Contents

- [Evidence rules](#evidence-rules)
- [Stage A: architecture](#stage-a-architecture)
- [Stage B: state machine](#stage-b-state-machine)
- [Stage C: pinned DSH profile](#stage-c-pinned-dsh-profile)
- [Stage D: model routing](#stage-d-model-routing)
- [Stage E: orchestration](#stage-e-orchestration)
- [Stage F: verification profiles](#stage-f-verification-profiles)
- [Stage G: failure and recovery](#stage-g-failure-and-recovery)
- [Stage H: AscendNPU-IR integration](#stage-h-ascendnpu-ir-integration)
- [Stage I: freeze](#stage-i-freeze)
- [External gates](#external-gates)

-----

<a id="evidence-rules"></a>
## Evidence rules

Each machine check records its command, exit code, task revision, and result artifact. A passing narrow test proves only the behavior it exercises. Real-provider checks are separate from credential-free automated tests. Any unavailable external dependency is recorded as `NOT_RUN` with its exact reason and cannot satisfy a required production check.

For every validator, the test suite includes at least one valid fixture and one invalid fixture that reaches the top-level command. Tests inspect public CLI behavior and committed artifact fields rather than private helper calls alone.

<a id="stage-a-architecture"></a>
## Stage A: architecture

| ID | Requirement | Falsifying evidence | Required evidence |
|---|---|---|---|
| A1 | Runtime is exactly pinned | Tag, commit, or manifest differs | Tag and commit inspection plus freeze facts in architecture |
| A2 | DSH assumptions use pinned source | A claimed capability is absent or unsupported | Source links for subagent, workflow, Ralph, goal, jobs, profiles, and reasoning |
| A3 | DSH core stays unchanged | Planned implementation edits an existing DSH runtime package | Responsibility and placement review |
| A4 | Acceptance is deterministic | A model can directly write `ACCEPTED` | Architecture review and Stage B negative test design |
| A5 | Every later requirement has a check | A goal requirement lacks an evidence owner | This complete stage matrix |

<a id="stage-b-state-machine"></a>
## Stage B: state machine

| ID | Requirement | Required check |
|---|---|---|
| B1 | All task artifacts validate | Schema unit tests for valid and malformed documents |
| B2 | Legal transitions succeed | Table-driven transition tests |
| B3 | Illegal and stale transitions fail | CLI tests for invalid edge, stale revision, and corrupted state |
| B4 | Acceptance is terminal | Double-acceptance and post-acceptance mutation tests |
| B5 | Repair count is bounded | Two-fix sequence forces `REPLAN` |
| B6 | Writes survive interruption | Fault-injection test leaves the last complete revision readable |
| B7 | CLI is cross-platform | Unit tests use Node filesystem/process APIs with no shell command strings |

<a id="stage-c-pinned-dsh-profile"></a>
## Stage C: pinned DSH profile

| ID | Requirement | Required check |
|---|---|---|
| C1 | One fixed tool exists per delegated role | `dsh --profile ... --dump-config` inspection |
| C2 | Each role has an explicit route | Configuration validator rejects missing provider, model, effort, or token limit |
| C3 | Depth is one | Dumped in-process role tools have `maxDepth: 1`; nested delegation fails |
| C4 | Default concurrency is three | Workflow engine config reports `maxConcurrentAgents: 3`; orchestration admission rejects a fourth worker |
| C5 | Only implementer may write | Role-policy tests reject writer lease acquisition by every other role |
| C6 | Arbiter is optional | Default orchestration trace contains no arbiter call |
| C7 | No DSH package changed | Diff check excludes existing `packages/` runtime sources |

<a id="stage-d-model-routing"></a>
## Stage D: model routing

| ID | Requirement | Required check |
|---|---|---|
| D1 | Logical role resolves exact route | Table-driven route tests over all roles |
| D2 | Unknown provider or model fails | Mock catalog negative tests before child creation |
| D3 | Unsupported effort fails | Mock exact-model capability test |
| D4 | Expensive route use is explicit | Cost-class policy rejects unauthorized role mapping |
| D5 | Basic completion and tool use work | Credential-free mock provider smoke tests |
| D6 | Subagent and background execution work | Mock child and job smoke tests with bounded collection |
| D7 | Structured output works where required | Mock structured response validation |
| D8 | Cancellation is bounded | Timeout test observes terminated child/job and terminal evidence |
| D9 | Actual route is diagnosable | Smoke artifact records provider, model, effort, and evidence source |

<a id="stage-e-orchestration"></a>
## Stage E: orchestration

| ID | Requirement | Required check |
|---|---|---|
| E1 | Plain subagent is the normal path | Scenario trace for architecture, implementation, and review |
| E2 | Workflow is fan-out only | Validator rejects workflow stages with fewer than two independent branches |
| E3 | Ralph is explicitly requested | Default profile keeps Ralph disabled; explicit overlay enables it |
| E4 | Goal is not repository authority | Resume test reconstructs state with no Goal Session available |
| E5 | One writer is enforced | Concurrent writer-admission test grants exactly one lease |
| E6 | Repository revisions bind outputs | Stale subagent result cannot update a newer task revision |

<a id="stage-f-verification-profiles"></a>
## Stage F: verification profiles

| ID | Requirement | Required check |
|---|---|---|
| F1 | Four result states remain distinct | Parser and acceptance tests for `PASS`, `FAIL`, `NOT_RUN`, and `INCOMPLETE` |
| F2 | Partial compiler scope is preserved | Target/mode matrix fixture with mixed statuses |
| F3 | Compiler commands are adapters | Synthetic repository config supplies every invoked command |
| F4 | Webapp categories are configurable | Fake typecheck, unit, API/E2E, and build commands |
| F5 | Failed process is not pass | Nonzero exit and timeout fixtures |
| F6 | Compiler mock E2E completes | Full state path including one failed verification and successful bounded fix |
| F7 | Webapp mock E2E completes | Full state path through its configured verification profile |

<a id="stage-g-failure-and-recovery"></a>
## Stage G: failure and recovery

| ID | Requirement | Required check |
|---|---|---|
| G1 | Interrupted command is recoverable | Kill fixture followed by `status` and resume |
| G2 | Interrupted subagent does not advance state | Mock cancellation scenario |
| G3 | Missing or corrupt artifacts fail closed | CLI end-to-end negative fixtures |
| G4 | Reviewer cannot bypass checks | `ACCEPT` review plus failed verification is rejected |
| G5 | Bounded review repair is enforced | Two `FIX_BOUNDED` decisions force `REPLAN` |
| G6 | Sensitive data policy is enforced | Disallowed route fixture and expired approval fixture |
| G7 | Secrets are not committed | Focused fixture scan rejects credential values and permits references |

<a id="stage-h-ascendnpu-ir-integration"></a>
## Stage H: AscendNPU-IR integration

| ID | Requirement | Required check |
|---|---|---|
| H1 | Existing commands remain authoritative | Adapter configuration names project-owned build/test commands |
| H2 | Results are structured and scoped | Fixture covers build, test, IR verify/diff, reference, benchmark, and profile categories |
| H3 | Missing hardware is explicit | Device-dependent check records `NOT_RUN` with target and reason |
| H4 | First integration stays bounded | Design contains no custom compiler analysis engine |

<a id="stage-i-freeze"></a>
## Stage I: freeze

| ID | Requirement | Required check |
|---|---|---|
| I1 | Runtime and toolchain are recorded | Freeze manifest validation against tag, commit, Node, pnpm, and lock hash |
| I2 | Config is reproducible | Fresh temporary Harness home resolves the committed profile overlays |
| I3 | Documentation matches commands | Every documented command is executed in the final validation pass |
| I4 | Upgrade is explicit | Upgrade guide requires a new manifest and complete regression matrix |
| I5 | Automated checks pass | Focused unit, negative, and both fake E2E suites pass |
| I6 | Final acceptance is machine-derived | `agentctl accept` succeeds only on a complete accepted fixture |

<a id="external-gates"></a>
## External gates

Real-provider smoke tests require deployment-specific endpoints, model IDs, and credentials. Until supplied, the final report lists each route as `NOT_RUN` with the missing credential or deployment value. Real Ascend device checks likewise remain `NOT_RUN` when the required target is unavailable. These results do not block development of the generic harness, but they do block a claim that the corresponding production route or device target is qualified.

## Further Exploration

- [Architecture](architecture.md)
- [DSH provider guide](../user/guide/providers.md)
- [DSH testing policy](../testing.md)

## Dev Note

None.
