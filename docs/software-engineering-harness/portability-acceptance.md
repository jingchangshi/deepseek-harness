# Repository-independent Engineering Acceptance

English | [中文](portability-acceptance.zh.md)

This reference records the executable acceptance oracle for the repository-independent engineering refactor. It supplements the [existing acceptance plan](acceptance-plan.md); passing installation checks do not qualify repository presets or hardware execution.

## Summary

The runtime installs repository-independent `engineering` and `engineering-run` profiles and uses one user deployment snapshot for provider bootstrap, authorization, and role dispatch. Repository-defined profile IDs pass schema, CLI, automatic workflow, and recovery validation. Ascend and TileLang presets, repository knowledge, scoped verification, policy identity, acceptance tiers, named runners and a third compiler fixture have positive coverage. Native compiler qualification and hardware execution remain separate evidence.

## Table of Contents

- [Source baseline](#source-baseline)
- [Executable oracle](#executable-oracle)
- [Coverage limits](#coverage-limits)
- [Verification commands](#verification-commands)

## Source baseline

The inspected harness branch is `ascendnpu-engineering-harness`, and its local head matches the remote branch. The supplied design and goal files are untracked inputs. The inspected TileLang checkout is on `main`, is clean, and matches the remote HEAD. Exact identities are inspected with `git rev-parse HEAD` and `git ls-remote`, rather than retained as commit references in maintained documentation.

The installer renders `engineering` and `engineering-run` with a user-owned `deploymentRoot`, not a repository path. Profile IDs use lowercase ASCII letters, digits, and hyphens, starting with a letter or digit; repository profile files must exist and match their declarations before task writes or role dispatch. Installer-owned legacy schemas can be refreshed without rewriting task metadata; initialization alone preserves existing schemas. Source, policy, profile and command-input identity are bound separately. [Scoped verification](scoped-verification.md) identifies instances by name and canonical JSON scope. Named runners report command identity and quiescence; Docker recovery uses declared runner kind, not executable names.

## Executable oracle

The new [portability suite](../../tools/agent/tests/portability-acceptance.spec.ts) uses temporary repositories, the public CLI, actual Node commands, persisted artifacts, and injected role responses. Model-role fixtures do not require credentials. Git configuration is isolated, source output is tracked, commands write distinct execution records, and teardown cancels and awaits owned automatic work before removing repositories.

| Requirement | Current result | Direct observation |
|---|---|---|
| Repository-independent installation rendering | PASS | Changing the target repository does not change installed profile content |
| Generic profile names and launcher default | PASS | The installer renders `engineering` and `engineering-run` |
| One installed deployment across two repositories | PASS | The real DSH profile completes both repositories without reinstalling; the second has no repository model, role, workflow, data-policy, or persona files |
| Shared routing and authorization snapshot | PASS | Provider bootstrap and role dispatch share the snapshot; a restricted snapshot denies dispatch even when repository files declare a more permissive route |
| Deployment configuration ownership | PASS | Repository initialization does not copy model routes, role mappings, workflow limits, data policy, or personas; user deployment edits survive reinstallation |
| Deployment write protection | PASS | Implementer cannot edit a deployment inside the repository or reach it through a symlink alias |
| Generic initialization without an Ascend adapter | PASS | Default initialization installs an empty local adapter; Ascend requires explicit preset selection |
| Arbitrary profile ID in schema, project loader, CLI, and automatic workflow | PASS | A valid `synthetic-compiler` profile completes the workflow and initial-task recovery |
| Profile grammar before filesystem access | PASS | Traversal, uppercase, underscore, empty IDs, and trailing line breaks are rejected |
| Verification-policy identity at acceptance | PASS | Mutating profile requirements, adapter configuration, project settings, command inputs or impact-policy declarations invalidates the bound attempt before acceptance |
| Always-required gates omitted by Architect | PASS | Each required command executes and has a passing persisted command-evidence record |
| Deterministic path-impact and tier requirements | PASS | Profile, impact, tier and model-extra requirements form a frozen monotonic set; unrelated paths leave optional verification `NOT_RUN` |
| Same gate in two repository-defined scopes | PASS | Separate commands, statuses, evidence and required-instance acceptance; missing scopes and borrowed evidence are rejected |
| Local exit and cancellation quiescence | PASS | Linux commands use an OS-owned systemd scope; detached descendants are reaped before `CONFIRMED`; unsupported containment returns `NOT_RUN` |
| Docker timeout and cancellation recovery | PASS | Fake and real `s00653124_build` payloads return `UNCERTAIN`; automatic recovery persists `BLOCKED` without a decision |
| Synthetic third-compiler workflow | PASS | Pebble parses IR, folds constants, emits stack/register IR, rejects invalid input, and reaches acceptance under two profile IDs |
| Third-repository zero-core-change proof | PASS | Complete `tools/agent/src` and `tools/agent/runtime` path/content inventories remain unchanged during onboarding and execution |

## Coverage limits

This oracle separates architecture acceptance from native qualification. A loader check or rendered profile comparison cannot substitute for compiler evidence.

| Goal group | Missing evidence |
|---|---|
| A: repository-independent profile | Covered by the installed-profile two-repository integration test |
| B: arbitrary profile ID | Covered by schema, loader, CLI, project, pending recovery, invalid declarations, and owned legacy-schema migration tests |
| C: presets | Ascend and TileLang initialization, editable policies across legacy reinstallation, independent core/preset identities, and preset admission are covered; native compiler qualification remains separate |
| D: policy identity | Covered by persisted source, policy, profile, command-input and preset identities across Plan, Verify, Review and Accept |
| E: deterministic impact requirements | Covered by frozen monotonic requirements, path impact, tier selection, model extras, failed/unavailable required gates and stale-attempt rejection. The [policy design](verification-policy-design.md) defines source sealing |
| F: scoped verification | Covered by independent executions, rejection of missing or mismatched required instances, scoped evidence, legacy-generation refusal, and an installed-profile snapshot |
| G: runners | Linux managed-range cancellation, Docker uncertain cancellation and timeout to BLOCKED, structured environment, typed argv and dispatch independent of executable basename |
| H: third repository | Pebble compiler fixture, two arbitrary profiles, complete artifact chain and complete generic source/runtime path-content inventory |

Deployment/repository configuration separation, core/preset freeze separation, and declared repository knowledge discovery have focused regression coverage. A keyless installed-profile snapshot checks the actual model input against recorded child Session logs without preloading Markdown bodies. The inspected TileLang checkout passes the preset's read-only syntax command for 403 Python sources; empty and malformed source fixtures fail. Its nine existing skills are discovered from copied repository documents and skill files. Native build, focused pytest, hardware, benchmarks, and real-provider qualification remain `NOT_RUN`, not `PASS`.

Acceptance tiers, structured environment, typed argv expansion, task-persisted preset identity, deterministic impact rules, both SDK projections when affected, and the complete final acceptance matrix remain required. Syntax and catalog evidence do not qualify native semantic checks or backend execution.

## Verification commands

These commands are executed separately. The first covers the portability oracle. The second excludes only platform-specific freeze fixtures and checks the remaining harness regression suite.

```sh
pnpm exec vitest run --config tools/agent/vitest.config.ts tools/agent/tests/portability-acceptance.spec.ts
pnpm exec vitest run --config tools/agent/vitest.config.ts --exclude tools/agent/tests/portability-acceptance.spec.ts
```

The portability suite includes independent assertions for scoped evidence, policy refusal, command evidence, isolated Git configuration, and owned-work teardown. The coverage limits above identify qualification evidence that is outside this source-level oracle.

## Dev Note

None.
