# Verification Policy Design

English | [中文](verification-policy-design.zh.md)

This design specifies deterministic requirements and artifact identities for the [engineering architecture](architecture.md). The [acceptance matrix](portability-acceptance.md) distinguishes these requirements from executed evidence.

## Summary

Repository policy selects a verification tier and required scoped instances. Models may add instances, but cannot remove deterministic requirements. A repository-owned source seal attaches the implemented source identity to frozen plan intent before verification. Verification, review, recovery and acceptance use the same final identities.

## Table of Contents

- [Policy ownership](#policy-ownership)
- [Required instances](#required-instances)
- [Identity inputs](#identity-inputs)
- [Source sealing](#source-sealing)
- [Acceptance and recovery](#acceptance-and-recovery)
- [Compatibility](#compatibility)

## Policy ownership

An optional project declaration selects a repository-relative verification policy file. The policy declares `schemaVersion`, a default tier, allowed tiers, always-required instances, tier requirements and path-impact rules. Tier names are `development`, `presubmit` and `qualification`; each higher tier includes the lower tier's requirements. An explicit user tier selection may raise the default, but cannot lower it. Reviewer output has no tier-selection authority.

The project key is `verificationPolicy`. Policy version 1 uses this declaration format; every referenced instance must also be declared in the selected verification profile:

```yaml
schemaVersion: 1
defaultTier: development
allowedTiers: [development, presubmit, qualification]
alwaysRequired: []
tiers:
  development: []
  presubmit:
    - { name: semantic-regression, scope: { compilerLayer: analysis } }
  qualification: []
impactRules:
  - paths: ["compiler/**"]
    require:
      - { name: semantic-regression, scope: { compilerLayer: analysis } }
```

Policy references use the [name-and-scope identity](scoped-verification.md), not names alone. Each reference must resolve to an instance in the repository profile before a task is dispatched. Path patterns are repository-relative POSIX glob patterns; absolute paths and traversal are rejected. Backend and compiler-layer values remain arbitrary JSON scope data. Deployment routing and personas are not policy inputs.

## Required instances

The frozen required set is the union of profile-required instances, always-required instances, the selected tier's requirements, deterministic path-impact requirements and model-requested extras. Model-requested extras must resolve to profile instances and become required, even when the profile marks them optional. Unknown references are errors, not silently skipped checks.

Impact paths compare the persisted baseline source inventory with the sealed source inventory, including staged, unstaged, deleted and untracked source files. HEAD movement from the recorded baseline is rejected rather than used as a new comparison base. Rename and deletion checks include the old path as well as any new path. Architect scope is additional information, never a substitute for observed paths. Baseline dirty paths remain part of the conservative change set. Recompute impact after implementation and every bounded fix; requirements can grow within a work revision, but cannot shrink. The persisted required set records each instance and its requirement sources so acceptance can reconstruct the decision.

Hardware availability does not change requiredness. An unavailable optional hardware instance remains `NOT_RUN`. An unavailable tier-required instance cannot satisfy acceptance. `FAIL`, required `NOT_RUN`, and required `INCOMPLETE` cannot be overridden by review.

## Identity inputs

`sourceTreeDigest` identifies Git HEAD and source file content, including dirty and untracked files and deletions. It excludes Git internals and runtime-owned task, lock, Session and installation artifacts. Repository verification configuration is not excluded from identity: it belongs to separate policy and profile digests.

`verificationPolicyDigest` identifies the verification profile, command adapters, impact rules, selected tier, frozen model-requested extras and every configuration file that contributes to those declarations. It identifies the policy program, not the changed source paths or its per-attempt output. The resolved required-set digest is a separate seal field: deterministic impact can add requirements without changing policy declarations. `repositoryProfileDigest` identifies the repository project declaration, declared knowledge configuration, instruction and skill catalogs, and the initial preset identity when present. Digest entries include the logical path, resolved repository-relative target, link-target metadata when present, and content digest, sorted by logical path. Paths resolve inside the repository; changed symlink targets and missing declared inputs invalidate identity, even when replacement targets have identical content.

The task persists its initial preset ID, version and digest independently of editable repository policy. An absent preset is an explicit no-preset identity, not an inferred compiler choice. Reapplying a scaffold does not change a task's recorded preset identity. Repository onboarding and backend additions require only repository data and do not alter generic TypeScript or the core freeze.

## Source sealing

Frozen plan intent consists of the planning fields and their digest. It is immutable for a work revision. The plan also contains repository-owned binding fields: selected tier, required instances, policy identity, profile identity and a final source-seal reference. Before implementation, that reference is explicitly unsealed; it does not claim that baseline source is the implemented source.

Writer closure first establishes quiescence of the writer and its descendants, then captures the final source digest, verifies unchanged policy and profile inputs, recomputes actual path impact, and attaches the resulting source seal to the plan under the task state lock. Only these repository-owned binding fields may change; the frozen intent digest must remain identical. The seal records task, work revision, verification attempt, all three identity digests and the resolved required-set digest. Changed source or a growing required set creates a new attempt; a validated attempt's seal is never modified in place. Verification cannot start until the seal is durable.

A bounded fix invalidates the previous source seal and requires another writer closure and verification attempt. It does not permit changing plan intent, lowering the tier, removing required instances, or changing policy and profile identities. Those changes require explicit replanning. `FROZEN_PLAN.<workRevision>.json` independently preserves the original validated plan; `ATTEMPT.<workRevision>.<attempt>.json` preserves cumulative requirements and each source seal. Both use the plan version 2 schema. The state revision determines which attempt records are committed; editing the current plan cannot lower its advertised attempt or required set. Command execution captures its identity before dispatch. Evidence append checks that identity and dispatch state revision without rebinding old results.

## Acceptance and recovery

Plan bindings, verification, review and acceptance decisions must carry the same task, work revision, verification attempt, final `sourceTreeDigest`, `verificationPolicyDigest`, `repositoryProfileDigest` and resolved required-set digest. Acceptance reloads every identity input and recomputes requirements while holding the task state lock. Source or configuration changes reject acceptance before any decision is written. Reviewer approval cannot repair an identity mismatch.

Recovery validates identities before reusing a checkpoint. An unsealed or interrupted writer cannot supply reusable verification. A changed policy, tier, profile, preset identity or frozen intent requires explicit replanning; changed implemented source requires a fresh seal and verification. A durable artifact write without its corresponding state transition remains subject to normal stale-revision checks and cannot authorize acceptance.

## Compatibility

Persisted generations use explicit schema-version dispatch. Committed predecessor schemas remain immutable and readable; their absence of required identity fields never supplies an implicit default, downgrade or acceptance path. Tasks using predecessor artifacts must explicitly replan and verify with identity-bearing generations. Installation adds successor schemas without rewriting existing task or evidence bytes.

## Dev Note

None.
