# Scoped Verification

English | [中文](scoped-verification.zh.md)

This reference specifies repository-defined verification instances and their acceptance rules for the [engineering architecture](architecture.md).

## Summary

A verification instance is a check name and a JSON scope. Equal names with different scopes are independent instances. The generic runtime treats backend, compiler layer, hardware, and execution mode as repository data.

## Table of Contents

- [Instance identity](#instance-identity)
- [Execution and evidence](#execution-and-evidence)
- [Acceptance](#acceptance)
- [Persistence](#persistence)

## Instance identity

Scopes are lossless JSON objects. Object keys are sorted recursively for identity; array order is significant. An instance ID is SHA-256 of the canonical JSON pair `[name, scope]`. Category describes the check but does not create another instance. Repeated name-and-scope pairs are rejected, including pairs with different categories or required flags.

Profile schema version 1 resolves an omitted scope to `{}` and an omitted adapter selector to the check name. An explicit `adapter` selects a repository command independently of the instance name. No compiler or backend enum participates in identity or routing.

## Execution and evidence

Every instance executes independently. Results are an ordered array containing the instance, resolved command, and terminal result; names are not map keys. Required and optional instances retain their own status, including `NOT_RUN` for unconfigured adapters. Command evidence records the instance name, category, scope, resolved argv and cwd, bounded output, and work revision. A fresh run UUID plus the instance ID distinguishes repeated executions.

## Acceptance

Acceptance reloads the current repository profile. Each required instance must appear exactly once, with the same category, `required: true`, `PASS`, and nonempty evidence references. Duplicate verification instances are invalid even when optional or passing. A passing result from another scope cannot satisfy a missing instance. Every acceptance entry point requires referenced command evidence with matching task, work revision, category and scope, exit code zero, and no timeout. Missing references and ambiguous referenced evidence IDs are rejected. Unreferenced duplicate legacy CLI records neither satisfy nor block a fresh verification; their bytes remain unchanged. Reviewer approval cannot override these requirements.

## Persistence

New verification artifacts use schema version 3 with per-check category and scope, plus a source and policy attempt identity. The predecessor schemas remain readable through explicit version dispatch; they are not fallback or downgrade targets and cannot authorize acceptance. Replan and run verification with the successor schemas. Existing task and evidence bytes remain unchanged. [Verification policy and source sealing](verification-policy-design.md) defines identity matching and cumulative requirements.

## Dev Note

None.
