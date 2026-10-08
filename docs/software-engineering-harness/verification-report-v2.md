# Engineering Harness V2 Verification Report

English | [中文](verification-report-v2.zh.md)

## Summary

This report records executed evidence for the [acceptance matrix](acceptance-matrix-v2.md). Results apply only to the named test paths and commands; incomplete final suites remain pending. Phase 0 acceptance is `PARTIAL`, and Phases 1–4 are `NOT_RUN`.

## Phase 0 evidence

| Evidence | Result | Primary reference |
|---|---|---|
| Mutation regression baseline | RED observed: 7 failed, 6 passed, 13 total. | `tools/agent/tests/runtime-mutation.spec.ts` |
| Dispatch observer capability baseline | RED observed: 22 failures; the suite was then expanded to 28 cases. The final 28-case suite passed. | `packages/core/tools/tests/body-start.spec.ts` |
| Raw `$id` schema baseline | 3 failures and 25 passes were observed. The final observer/schema suite passed after validator isolation. | `packages/core/tools/tests/body-start.spec.ts` |
| Uncertain writer cleanup baseline | 2 failures were observed. | `tools/agent/tests/automatic.spec.ts` |
| Direct writer admission baseline | 7 failures and 51 passes were observed. | `tools/agent/tests/repository.spec.ts` |
| Mutation runtime GREEN | 13 tests passed. | `tools/agent/tests/runtime-mutation.spec.ts` |
| Writer suites GREEN | 123 tests passed. | `tools/agent/tests/runtime-lifecycle.spec.ts`, `tools/agent/tests/automatic.spec.ts`, `tools/agent/tests/repository.spec.ts`, `tools/agent/tests/state-machine.spec.ts` |
| Profile regression | 29 tests passed. | Profile regression command from the Phase 0 final validation. |
| Core tool regression | 318 existing tests across five files and all 28 observer/schema cases passed. | `packages/core/tools/tests/`, `packages/core/tools/tests/body-start.spec.ts` |
| Structured-output regression | 30 tests passed. | `packages/subagent/subagent-in-process-driver/tests/structured.spec.ts` |
| Read-capability regression | Initial run: 581 passed, 1 failed due to an obsolete spill hint. The corrected focused regression passed 1 test; no 582-test green result is claimed. | Read-capability regression command and corrected focused spill-hint test from the Phase 0 final validation. |
| Recorded-session behavior | One authored refresh and one replay passed for all six child roles, including unknown bash, invalid structured output, and valid output accepted without file changes. | `tools/agent/tests/runtime-mutation.spec.ts`, `snapshots/` |
| Documentation checks | 42 `doc-sync` gates passed before these reports were added; the reports pass focused pairing, wrapping, link, and diff checks. | `pnpm run doc-sync`; `pnpm exec tsx scripts/verify-translation-pairing.ts`; `pnpm run verify-md-wrap`; `pnpm run verify-md-links`; `git diff --check` |
| Build and scoped lint | Passed. | Build and scoped lint commands from the Phase 0 final validation. |
| Package hygiene | PARTIAL: 15 of 16 gates passed. The vendor rescope gate failed on 16 unchanged paths; the same failures reproduced in a detached worktree at the starting HEAD. | Package hygiene command and baseline detached worktree at starting HEAD. |
| Independent design review | APPROVED. | `docs/software-engineering-harness/architecture-v2.md` |
| Independent implementation review | APPROVE; final verdict after corrections. | Phase 0 source and tests listed above. |

## Pending evidence

| Check | Status |
|---|---|
| Observer/schema suite | PASS: 28 cases. |
| Profile regression suite | PASS: 29 cases. |
| Build and scoped lint | PASS. |
| Corpus `doc-sync` after adding these reports | PENDING |
| Package hygiene | PARTIAL: 15/16 gates; one reproduced baseline failure. |
| Independent implementation review | APPROVE. |
| Commit and push confirmation | NOT_RUN |
| Phases 1–4 verification | NOT_RUN |

Original private Session ZIP files were unreadable because access returned `PermissionError`. Fixtures use the documented behavior; they do not claim to reproduce original Session bytes. The configured worker route was unavailable, so the actual test-design and implementation routes used supported `gpt-6-luna` and `gpt-6.1-sol` models. No live provider, benchmark, token-cost, or pricing evidence is claimed.
