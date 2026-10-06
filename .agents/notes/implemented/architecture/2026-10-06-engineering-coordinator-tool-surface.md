# Agent Note: Engineering coordinator tool surface

Status: implemented

English | [中文](2026-10-06-engineering-coordinator-tool-surface.zh.md)

## Problem

A recorded multi-agent run of the engineering harness surfaced two failures with one root: the Coordinator was offered tools the workflow does not want it to use.

The runtime restricts a Coordinator to `engineering_run`, `engineering_status`, and `engineering_recover`, but the standing `tool-subagent` row registers its `subagent` tool into each Agent's own scope. The tool registry applies a restriction layer only to the surface a scope *inherits*; a scope's own registrations stay outside the filter, because that exemption is what keeps a child's structured-output transport alive under a child capability filter. The `subagent` row therefore stayed visible next to the workflow tools, and the model called it. The workflow guard rejected the call, so each attempt cost a turn and produced no progress. Delegated roles saw the same row and spent calls on `subagent` calls that the depth cap then rejected.

Web fetch produced the same class of failure: `file:` URLs and `127.0.0.1` hosts were refused with messages that named only the rule, so a role retried a shape that could never succeed.

## Decision

A coordinator-only composition removes the delegation group instead of filtering it at runtime, and role-facing failures name the next action.

The `engineering` and `engineering-run` profiles are built on the Web bundle. [`installationFiles`](../../../../tools/agent/src/installation.ts) now reads that bundle's shipped `standard` preset, drops the `delegation` group through [`classifyPresetRows`](../../../../tools/agent/src/preset-rows.ts), resolves the preset's two `!!js` platform conditions, and writes the result as an id-keyed `preset-standard` row in the managed profile patch. The composed tree replaces the bundle row by id, so the profile layer never restates the bundle's sibling declarations. The preset is generated at install time rather than edited in the bundle because the shipped preset is a Web product surface that non-engineering profiles keep unchanged, and an overlay that rewrote `config.plugins` would have to restate the whole child list.

Composition is the only layer that can suppress this row. A `!!js` `disabled` expression inside the preset's child list is not patchable: entry patches address the composed tree, while a preset's `plugins` are evaluated when the preset mounts. A runtime `tools.restrict()` call cannot mask an own-scope registration by design.

The coordinator's prompt-visible work also needed `get_goal` and `update_goal`. The workflow lists them in [`COORDINATOR_TOOLS`](../../../../tools/agent/runtime/index.ts), so the restriction keeps them and the guard admits them. The restriction itself now filters to names the Session exposes, because `tools.restrict()` rejects an unknown name and a deployment may omit the goal tools.

Role failures carry the recovery action. [`SubagentDepthError`](../../../../packages/subagent/subagent/src/child-agent.ts) states that the Session cannot delegate further and the role must finish with its own tools. The [web-fetch policy](../../../../packages/web/web-fetch-http/src/policy.ts) names the read/search tools for a local path and states that only public internet hosts are reachable. A policy refusal from the model endpoint is classified as [`POLICY_REFUSAL`](../../../../packages/llm/llm/src/error.ts). Retrying that route cannot succeed, but a read-only role can use its single configured alternate route after independent policy checks.

## Alternatives considered

**Resolve the restriction mismatch in `dsh-tools`.** Rejected: masking own-scope registrations would break the per-child capability filter, which relies on that exemption to keep a child's structured-output tool reachable.

**Filter the coordinator by name at dispatch only.** Rejected: the model would still see `subagent` in its tool list, which is what produced the calls.

**Delete the delegation group from the shipped Web preset.** Rejected: the standard preset is a product surface that other profiles keep unchanged.

**Patch the preset's child list from the profile layer.** Rejected: a preset row's `config` is replaced as a whole, so an overlay would have to restate every child and would silently drop any the bundle adds later.

## Consequences

The engineering profiles depend on the Web bundle's `standard` preset identity (`preset-standard`) and on the `delegation` group id inside it. A bundle rename fails the install loudly rather than shipping a coordinator with a delegation tool. The generated preset resolves only the shipped preset's platform conditions; a new `!!js` condition refuses the install instead of writing a literal that would silently disable a row.

A deployment that has not reinstalled its profiles keeps the old patch and the old behavior; `dsh plugin install` regenerates it.

## Testing

[Preset-row unit tests](../../../../tools/agent/tests/preset-rows.spec.ts) cover which groups survive. [Installation tests](../../../../tools/agent/tests/installation.spec.ts) assert that the managed profile patch drops the delegation group, keeps the goal tool, and resolves the platform conditions without leaking `__jsExpr` nodes.
