# Engineering Harness V2 Verification Report

English | [中文](verification-report-v2.zh.md)

## Summary

This report records executed evidence for the [acceptance matrix](acceptance-matrix-v2.md). Results apply only to the named test paths and commands. Phases 0–3 are accepted and pushed. Phase 4 implementation is complete with focused verification PASS; full live comparison is PARTIAL.

## Phase 0 evidence

| Evidence | Result | Primary reference |
|---|---|---|
| Mutation regression baseline | RED observed: 7 failed, 6 passed, 13 total. | `tools/agent/tests/runtime-mutation.spec.ts` |
| Dispatch observer capability baseline | RED observed: 22 failures; the suite was then expanded to 28 cases. The final 28-case suite passed. | `packages/core/tools/tests/body-start.spec.ts` |
| Raw `$id` schema baseline | 3 failures and 25 passes were observed. The final observer/schema suite passed after validator isolation. | `packages/core/tools/tests/body-start.spec.ts` |
| Uncertain writer cleanup baseline | 2 failures were observed. | `tools/agent/tests/automatic.spec.ts` |
| Direct writer admission baseline | 7 failures and 51 passes were observed. | `tools/agent/tests/repository.spec.ts` |
| Mutation runtime GREEN | 13 tests passed. | `tools/agent/tests/runtime-mutation.spec.ts` |
| Writer suites GREEN | 123 tests passed across the automatic, repository, and state-machine suites. | `tools/agent/tests/automatic.spec.ts`, `tools/agent/tests/repository.spec.ts`, `tools/agent/tests/state-machine.spec.ts` |
| Profile regression | 29 tests passed. | Profile regression command from the Phase 0 final validation. |
| Lifecycle integration regression | Historical integration run: 198 passed, 2 failed because of fixtures. After correcting the fixtures, the focused lifecycle suite passed all 8 tests. | `tools/agent/tests/runtime-lifecycle.spec.ts`, `snapshots/session/engineering-harness/` |
| Core tool regression | 318 existing tests across five files and all 28 observer/schema cases passed. | `packages/core/tools/tests/`, `packages/core/tools/tests/body-start.spec.ts` |
| Structured-output regression | 30 tests passed. | `packages/subagent/subagent-in-process-driver/tests/structured.spec.ts` |
| Read-capability regression | Initial run: 581 passed, 1 failed due to an obsolete spill hint. The corrected focused regression passed 1 test; no 582-test green result is claimed. | Read-capability regression command and corrected focused spill-hint test from the Phase 0 final validation. |
| Recorded-session behavior | One authored refresh and one replay passed for all six child roles, including unknown bash, invalid structured output, and valid output accepted without file changes. | `tools/agent/tests/runtime-mutation.spec.ts`, `snapshots/` |
| Documentation checks | The latest 42 `doc-sync` gates passed; the reports pass focused pairing, wrapping, link, and diff checks. | `pnpm run doc-sync`; `pnpm exec tsx scripts/verify-translation-pairing.ts`; `pnpm run verify-md-wrap`; `pnpm run verify-md-links`; `git diff --check` |
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
| Corpus `doc-sync` after adding these reports | PASS: latest 42 gates passed. |
| Package hygiene | PARTIAL: 15/16 gates; one reproduced baseline failure. |
| Independent implementation review | APPROVE. |
| Phase 2 acceptance and push | PASS: accepted phase commit is confirmed on the target remote branch. |
| Phase 3 acceptance and push | PASS: normal push and remote branch confirmation are recorded. |
| Phase 4 status | PARTIAL: implementation and focused verification PASS; live D budget-limited run recorded; A/B/C comparison NOT_RUN. |

Original private Session ZIP files were unreadable because access returned `PermissionError`. Fixtures use the documented behavior; they do not claim to reproduce original Session bytes. The configured worker route was unavailable, so the actual test-design and implementation routes used supported `gpt-6-luna` and `gpt-6.1-sol` models. No live provider, benchmark, token-cost, or pricing evidence is claimed.

## Phase 1 evidence

| Evidence | Result | Primary reference |
|---|---|---|
| Independent implementation review | APPROVE. | Phase 1 review result. |
| Git evidence, review-only, and runtime review | 52 tests passed in the final combined run. | `tools/agent/tests/git-evidence.spec.ts`, `tools/agent/tests/review-only.spec.ts`, `tools/agent/tests/runtime-review.spec.ts` |
| RED history | The initial missing-capability run executed 0 tests and is not a behavioral RED. A later meaningful run had 5 failures and 49 passes. Newly added reviewer negative cases landed with their fixes and have no RED baseline. | `/tmp/dsh-goal-1008/phase1-review-red.txt`, `/tmp/dsh-goal-1008/phase1-review-followup.txt` |
| Schema regression | 40 tests passed. | Phase 1 schema regression command. |
| Existing automatic regression | Final serial run: 64 tests passed. An earlier broad run had 23 timeouts and 41 passes; focused normal and diagnostic runs passed 6 and 30 tests respectively, with no timeout change. | `tools/agent/tests/automatic.spec.ts`; Phase 1 automatic regression logs. |
| Typecheck and scoped lint | Passed. | Phase 1 final typecheck and scoped lint commands. |
| Engineering Harness snapshot | Authored refresh and replay passed for seven child roles. The root-hash tuple was fixed in the fixture; shared normalizers were unchanged. | `snapshots/session/engineering-harness/`; Phase 1 snapshot refresh and replay logs. |
| Documentation | Latest `doc-sync`: 42 gates passed. | Phase 1 `doc-sync` run. |
| Package hygiene | PARTIAL: 15 of 16 gates passed; the vendor rescope failure reproduces on the starting baseline. | Package hygiene baseline logs. |
| Live provider run | PARTIAL: supported engineering-run reached BUDGET_EXHAUSTED; 32 requests, 474,943 known tokens, answer check failed, original file preserved. | `/tmp/dsh-live-evaluation-1418323-1791472342988.json` |
| Freeze update check | PASS. | Phase 1 freeze update and check logs. |
| Pre-push typecheck | PASS. | Phase 1 pre-push check. |
| Phase 1 commit and push | PASS; the exact pushed commit was confirmed on the configured target remote branch. | Phase 1 delivery record. |

The first reviewer-only RED attempt failed during module import and ran no tests. It is not behavioral evidence. The meaningful RED run and later GREEN results are reported separately above. Phase 2 evidence follows; Phase 3 and Phase 4 evidence are recorded in their respective sections.

## Phase 2 evidence

| Evidence | Result | Primary reference |
|---|---|---|
| Independent source review | Final verdict: APPROVE. The reviewer verified 52 tests across six files and approved the synchronous admission-ordering follow-up after independently rerunning its regression and reviewing concurrency evidence. | `/tmp/dsh-goal-1008/phase2-review-verdict.txt` |
| Focused implementation coverage | 52 unique independently verified tests passed across six files, including provider dispatch observation, cumulative lifecycle limits, checkpoint recovery, Review-only reuse, investigation inspection, and runtime budgets. | `packages/llm/llm/tests/dispatch-observation.spec.ts`; `tools/agent/tests/lifecycle-budget.spec.ts`; `tools/agent/tests/investigation-checkpoints.spec.ts`; `tools/agent/tests/review-checkpoints.spec.ts`; `tools/agent/tests/runtime-inspection.spec.ts`; `tools/agent/tests/runtime-budgets.spec.ts`; `/tmp/dsh-goal-1008/phase2-acceptance-final.txt`; `/tmp/dsh-goal-1008/phase2-final-review-regressions-green.txt` |
| Existing regressions | 64 automatic tests and 99 repository/schema tests passed after integration. | `/tmp/dsh-goal-1008/phase2-automatic-regression-final.txt`; `/tmp/dsh-goal-1008/phase2-repository-schema-regression.txt` |
| Runtime and fixture regressions | 13 runtime mutation and migration tests passed. The actual adapter disposal check passed after final changes. | `/tmp/dsh-goal-1008/phase2-mutation-migration-green.txt`; `/tmp/dsh-goal-1008/phase2-runtime-lifetime-final-green.txt` |
| Snapshot replay | The Engineering Harness replay passed with ordered Scout starts. | `/tmp/dsh-goal-1008/phase2-snapshot-ordered-replay.txt` |
| RED evidence | Initial recovery RED: 1 failure; lifecycle-ledger review RED: 7 failures and 12 passes; checkpoint receipt-validation RED: 1 failure. A later isolated pre-fix control copy had four safety-case failures. These validate the cases and are not failures of the final source. No failed import or unrelated timeout is counted as behavioral evidence. | `/tmp/dsh-goal-1008/phase2-recovery-red.txt`; `/tmp/dsh-goal-1008/phase2-ledger-review-red.txt`; `/tmp/dsh-goal-1008/phase2-checkpoints-red.txt`; `/tmp/dsh-goal-1008/phase2-final-review-negative-red.txt` |
| Initial documentation aggregate | 37 of 42 gates passed. The five failures were two stale generated catalog/graph outputs, stale persistence inventories, and bilingual code-block pairing during concurrent documentation edits. | `/tmp/dsh-goal-1008/phase2-doc-sync.txt` |
| Final documentation aggregate | PASS: all 42 gates passed, with 0 failures and 0 skipped. | `/tmp/dsh-goal-1008/phase2-doc-sync-final.txt` |
| Synchronous admission ordering | The corrected deterministic regression passed. An isolated reversed-order control failed as expected; the reviewer also checked the existing concurrency pass and approved the final change. | `/tmp/dsh-goal-1008/phase2-scout-start-order-latched-green.txt`; `/tmp/dsh-goal-1008/phase2-scout-start-order-latched-negative-red.txt`; `/tmp/dsh-goal-1008/phase2-review-verdict.txt` |
| Provider cost evidence | NOT_RUN. Provider pricing is unverified; cost remains unknown, and `maxKnownCostUsd` fails closed after an unpriced request rather than acting as a spend cap. | `/tmp/dsh-goal-1008/provider-availability.json` |
| Phase 2 acceptance and delivery | PASS. The accepted commit was pushed to `ascendnpu-engineering-harness`; remote confirmation matches. | `/tmp/dsh-goal-1008/phase2-push.txt`; `/tmp/dsh-goal-1008/phase2-remote-confirmed.txt` |

Phase 2 acceptance and push are PASS.

## Phase 3 evidence

| Evidence | Result | Primary reference |
|---|---|---|
| Focused Phase 3 behavior tests | 59 tests passed across four independently maintained files. Earlier focused runs overlap and are not added to this count. | `/tmp/dsh-goal-1008/phase3-final-independent.txt`; `/tmp/dsh-goal-1008/phase3-diagnosis-durable-output.txt` |
| Scheduling store regressions | 70 tests passed across three files. | `/tmp/dsh-goal-1008/phase3-store-regression.txt` |
| Runtime regressions | 88 tests passed across three files. | `/tmp/dsh-goal-1008/phase3-runtime-regression.txt` |
| Freeze checks | Three tests passed. | `/tmp/dsh-goal-1008/phase3-freeze-green.txt` |
| Engineering Harness snapshot | One authored refresh and one replay passed. | `/tmp/dsh-goal-1008/phase3-snapshot-refresh.txt`; `/tmp/dsh-goal-1008/phase3-snapshot-replay.txt` |
| Typecheck and scoped lint | PASS. | `/tmp/dsh-goal-1008/phase3-typecheck-final.txt`; `/tmp/dsh-goal-1008/phase3-lint.txt` |
| RED evidence | Behavioral: adaptive scheduling had three failures and one pass before correction; capability dispatch had four failures before correction. The earlier ledger check had 15 failures because the new API was not yet present; those missing-API checks are separate from behavioral regressions. | `/tmp/dsh-goal-1008/phase3-adaptive-focused-red.txt`; `/tmp/dsh-goal-1008/phase3-capability-dispatch-red.txt`; `/tmp/dsh-goal-1008/phase3-scheduling-final-capability-red.txt` |
| Design review | APPROVE. | `/tmp/dsh-goal-1008/phase3-interfaces.md`; Phase 3 design-review verdict. |
| Independent source review | Final verdict: APPROVE. The reviewer checked code, crash regressions and final documentation evidence. | `/tmp/dsh-goal-1008/phase3-review-verdict.txt` |
| Phase 3 acceptance and delivery | PASS. The reviewed phase was normally pushed, and the remote branch matches. | `/tmp/dsh-goal-1008/phase3-push.txt`; `/tmp/dsh-goal-1008/phase3-remote-confirmed.txt` |
| Phase 4 design review | APPROVED; design frozen. | `/tmp/dsh-goal-1008/phase4-interfaces.md`; Phase 4 design-review verdict. |
| Phase 4 implementation and verification | PASS focused: 47 Phase 4 tests, typecheck, lint, doc-sync; live strategy comparison PARTIAL. | `/tmp/dsh-goal-1008/phase4-acceptance-tests.txt` |
