# Multi-Agent Engineering Policy

Use a planner / worker / reviewer workflow for non-trivial engineering tasks.

## Main Agent

The main agent owns:

- repository understanding;
- architecture;
- critical-path reasoning;
- task decomposition;
- acceptance criteria;
- integration;
- final validation;
- final completion decision.

For meaningful engineering tasks, inspect the relevant repository source before implementation.

Do not delegate architectural ownership to workers.

## Worker Agent

Use the `worker` agent for bounded implementation tasks after architecture, scope, constraints, invariants, and acceptance criteria are established.

Suitable tasks include:

- localized implementation;
- tests;
- bounded refactoring;
- mechanical changes;
- bounded debugging;
- focused source investigation;
- independent non-overlapping implementation tasks.

Workers may edit source and execute focused validation.

Workers do not own overall architecture or final acceptance.

## Reviewer Agent

Use the `reviewer` agent after meaningful implementation changes.

The reviewer independently evaluates:

- original goal;
- architecture;
- actual implementation;
- correctness;
- scope;
- maintainability;
- regression risk;
- tests;
- acceptance evidence.

A reviewer must inspect primary evidence rather than relying on worker summaries.

## Required Workflow

For non-trivial engineering tasks:

1. Inspect
2. Understand
3. Define architecture and invariants
4. Define acceptance criteria
5. Decompose
6. Delegate bounded implementation to `worker`
7. Inspect the actual worker diff
8. Integrate
9. Delegate independent review to `reviewer`
10. Address review findings
11. Run final validation
12. Compare final state against the original goal
13. Only then declare completion

## Delegation Rules

Delegate only when the task has a sufficiently clear boundary.

Each worker assignment should include:

- objective;
- relevant context;
- scope;
- architecture constraints;
- invariants;
- acceptance criteria;
- expected validation.

Avoid overlapping write scopes between concurrent workers.

Do not delegate merely to maximize parallelism.

Keep work on the main agent when it requires:

- global architectural reasoning;
- tightly coupled cross-module decisions;
- difficult sequential debugging;
- broad repository context;
- resolution of conflicting implementation/review conclusions.

## Review Loop

If the reviewer returns `CHANGES_REQUIRED`:

1. The main agent evaluates each finding.
2. Appropriate corrections are delegated to `worker`.
3. The main agent inspects the correction.
4. A substantive correction receives another independent review.

Do not mechanically accept every reviewer suggestion. The main agent remains responsible for architectural decisions.

## Acceptance Policy

Passing tests is evidence, not proof of completion.

Do not declare the goal complete solely because:

- a worker reports success;
- a reviewer reports approval;
- focused tests pass;
- the build succeeds;
- the worktree is clean.

The main agent must independently compare the final repository state against the original goal and acceptance criteria.

## Evidence Policy

Classify important evidence as:

- VERIFIED
- INFERRED
- NOT RUN
- UNKNOWN

Never convert missing evidence into success.
