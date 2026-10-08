# Review-only Git review

English | [中文](review-only.zh.md)

## Summary

The Coordinator can review a local Git change set without starting Development or dispatching an Implementer. A result is `REVIEW_COMPLETE` only when the reviewer and the runtime account for every changed path with complete, observed Git evidence.

## Table of Contents

- [Request a review](#request-a-review)
- [Pinned snapshot](#pinned-snapshot)
- [Evidence tools](#evidence-tools)
- [Coverage and findings](#coverage-and-findings)
- [Saved state and recovery](#saved-state-and-recovery)
- [Further Exploration](#further-exploration)

-----

<a id="request-a-review"></a>
## Request a review

Call `engineering_review` from the top-level Coordinator. Supply `targetKind` and `target`; `base` and `taskId` are optional fields. A target kind selects a local commit, branch tip, commit range, or an existing local pull-request ref.

| `targetKind` | `target` | `base` |
|---|---|---|
| `commit` | `HEAD` or a full commit SHA | Optional full base SHA; defaults to the commit parent, or the empty tree for a root commit. |
| `branch` | A local branch name | Optional full base SHA; defaults to the branch tip's parent, or the empty tree for a root commit. |
| `range` | `<base-SHA>..<target-SHA>` with full commit SHAs | Included in `target`; omit `base`. |
| `pr` | A positive local pull-request number | Required full base SHA; target reads `refs/pull/<number>/head`. |

The review reads the current local repository objects. It does not fetch a branch, query a remote, or update a Git ref. A pull-request review works only when its local `refs/pull/<number>/head` already exists.

The optional `taskId` selects a saved review. When omitted, the runtime creates a review ID. Reuse the same `taskId` and exact target selector to resume or read that review; a different selector for that ID is rejected.

<a id="pinned-snapshot"></a>
## Pinned snapshot

The first run resolves the selected target and base to full commit IDs and stores them with the canonical repository path, Git object format, and a snapshot ID. An omitted base selects the target commit's first parent; a root commit uses the empty tree.

The saved snapshot fixes later reads even when a local branch or `HEAD` moves. A resumed review uses the persisted snapshot and changed-path scope instead of resolving the selector again. The snapshot ID binds the repository path, base commit, target commit, and object format.

<a id="evidence-tools"></a>
## Evidence tools

The Reviewer receives `git_snapshot`, `git_changed_files`, `git_diff`, `git_show`, and `git_history`, plus configured read tools. The runtime filters out shell, write, edit, and nested workflow tools. Git reads use fixed `execFile` argument arrays against the pinned commits; the review does not run arbitrary Git commands or modify `.git`.

Each evidence query returns an `evidenceId`, the snapshot ID, and completeness metadata. `git_show` and `git_diff` also return a SHA-256 hash for each text page. `git_changed_files` and `git_history` return paged records. `git_diff` returns paged diff text with a continuation offset. `git_show` returns target-commit source lines with a continuation line. Follow every continuation until `completeness.complete` is true.

Workflow configuration sets the maximum direct-file count, maximum Scout count, Git command timeout, subprocess output limit, and default evidence page size. Defaults are 4 files, 2 Scouts, 30 seconds, 8 MiB, and 16,384 operation units. More than the direct-file limit assigns disjoint path groups to configured Scout roles; the Reviewer still checks the complete changed scope independently.

<a id="coverage-and-findings"></a>
## Coverage and findings

Every changed path needs complete target-source and diff evidence. A finding must name the pinned target commit, a changed path, source lines that overlap a changed target line, a concrete failure condition, how the change causes it, and observed evidence IDs for that path. The runtime rejects fabricated, unobserved, incomplete, out-of-scope, or placeholder evidence.

Deleted files and binary content cannot provide complete target source evidence. A source or diff page that cannot be read completely also leaves the scope incomplete. These cases produce `PARTIAL` with unresolved questions and no accepted findings; an empty findings list does not waive path coverage.

`REVIEW_COMPLETE` means deterministic evidence checks found complete scope and valid citations. It does not mean the change is safe for every deployment or replace project-specific tests. `PARTIAL` records missing, unsupported, or invalid evidence. `BLOCKED` records uncertain child cleanup or an attempted potentially mutating dispatch.

<a id="saved-state-and-recovery"></a>
## Saved state and recovery

Review records live under `.agent/reviews/<task-id>/`: `TASK.json` pins the selector, snapshot, classified scope, and data class; `STATE.json` stores the revisioned stage; `RESULT.json` stores the result. Review state has no development writer lease. The stage path is `REQUEST -> SNAPSHOT -> SCOPE_CLASSIFIED -> REVIEW_INVESTIGATION -> INDEPENDENT_REVIEW -> EVIDENCE_VALIDATION`, then `REVIEW_COMPLETE`, `PARTIAL`, or `BLOCKED`.

`RESULT.json` stores the validated findings and cited evidence IDs. It does not copy Git source or diff pages into the review directory.

`engineering_status` lists saved reviews. A nonterminal review resumes from its persisted state, snapshot, and scope. `engineering_review` returns a saved terminal result for the same task ID and selector. If cleanup or a potentially mutating dispatch leaves a review `BLOCKED` with `requiresStopConfirmation`, stop the child and its work, call `engineering_recover` with that review ID and `confirmedStopped: true`, then call `engineering_review` with the same ID and target. Recovery keeps the pinned snapshot and resumes at independent review.

<a id="further-exploration"></a>
## Further Exploration

- [Engineering task protocol](task-protocol.md)
- [Engineering architecture](architecture.md)
- [Verification policy design](verification-policy-design.md)

## Dev Note

None.
