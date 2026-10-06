# Pinned DSH Runtime

English | [中文](dsh-pinned-runtime.zh.md)

This harness runs from a DSH branch based on the release identified by [`.agent/FREEZE.json`](../../.agent/FREEZE.json). The core manifest records the release tag and commit reference, toolchain, and hashes for package manifests, orchestration sources, profile composition, deployment seed templates, and artifact schemas. Repository project declarations, command adapters, verification profiles, and preset content do not belong to core freeze; [repository presets](repository-presets.md) have independent scaffold identities.

## Validate the Freeze

Run `pnpm exec vitest run --config tools/agent/vitest.config.ts tools/agent/tests/freeze.spec.ts`. The check requires the tag and `commitRef` to resolve to the same commit and that commit to be an ancestor of the branch's `HEAD`. It does not require `HEAD` to equal the release tag. Node and pnpm versions and every listed file hash must also match.

The installer runs this check before copying templates and profiles. Passing it verifies the recorded baseline and files; it does not establish that all branch changes are committed. Preserve the reviewed branch commit together with the manifest for a reproducible checkout.

After reviewed core source changes, run `node tools/agent/agentctl.mjs freeze --root . --update true` from this checkout to regenerate file hashes, then run `node tools/agent/agentctl.mjs freeze --root .` to verify them. The generator preserves the release and toolchain, includes new engineering source and runtime modules, and refuses an incompatible baseline. Never edit generated hashes by hand.

## Upgrade Procedure

Create an upgrade branch, select an explicit DSH tag, and inspect the same pinned-source areas listed in [architecture.md](architecture.md). Update configuration only after its assumptions are confirmed. Run the focused state, routing, profile, recovery, E2E, Cordis dump, documentation, and real-provider checks. Replace the manifest values only after those checks pass. Never point the manifest at `latest` or a moving branch.

## Current Qualification

Credential-free checks pass at `dsh-v0.2.1-alpha.1`. Company gateway routes, relay routes, OpenAI arbitration, and Ascend device execution remain `NOT_RUN` until deployment-specific IDs, credentials, endpoints, and hardware are supplied.

## Dev Note

None.
