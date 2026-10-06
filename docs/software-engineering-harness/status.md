# Frozen Engineering Harness Status

English | [中文](status.zh.md)

This page records the implementation state of the [frozen multi-model engineering harness](architecture.md). It reports completed evidence and known unavailable external checks without treating plans as delivered behavior.

## Summary

Stages A through I are implemented for credential-free use. The repository state engine, installed DSH profiles, automatic role runtime, verification profiles, recovery behavior, real-composition mock-provider examples, Ascend integration, and freeze manifest have focused coverage. External provider qualification has not passed; device qualification remains `NOT_RUN`.

## Stage Status

| Stage | Status | Evidence |
|---|---|---|
| A: evidence and architecture | Complete | Architecture, pinned-source findings, and acceptance matrix |
| B: minimal state machine | Complete | Nine artifact schemas, state engine, atomic store, CLI, and automatic driver |
| C: pinned DSH profile | Complete | Installed Web and headless profiles with startup freeze verification |
| D: provider and mock routing | Complete | Exact-route validator, mock matrix, and conditional real-route runner; latest real-route attempts `FAIL` at the Coordinator with `RATE_LIMIT` |
| E: orchestration | Complete | Coordinator tool, real spawned roles, scout-only concurrency, and 82 focused tests |
| F: compiler and webapp profiles | Complete | Argv runner, structured scope, and two synthetic E2E examples |
| G: failure and recovery | Complete | Stale state, corrupt artifact, interrupted write, timeout, and retry coverage |
| H: AscendNPU-IR integration | Complete | Containerized build and 1,135-test reference suite passed; device checks `NOT_RUN` |
| I: freeze | Complete | Hash-checked runtime, toolchain, lockfile, and configuration manifest |

## Stage A Evidence

- Runtime tag: `dsh-v0.2.1-alpha.1`.
- Runtime commit: resolved locally from the pinned tag; the Stage I manifest owns the exact value.
- Investigation toolchain: Node `v22.22.2`, pnpm `11.7.0`.
- Lockfile SHA-256: `640f05f383247ae579ec4e52e7e498dbd5cd49ac45bd0e306a85db1c67d95476`.
- Design owner: [architecture.md](architecture.md).
- Acceptance owner: [acceptance-plan.md](acceptance-plan.md).

## External Evidence

The Magpie deployment uses API-confirmed model IDs. Simple live requests for GPT-6.1-Sol, DeepSeek, MiMo, GLM, and Qwen return HTTP 200 with the requested response. MiMo requires Chat Completions despite its catalog endpoint metadata. Pinned DSH smokes also pass GPT-6.1-Sol and DeepSeek roles and the corrected MiMo, Qwen, and GLM routes with child dispatch and read-tool evidence. Ascend device checks remain `NOT_RUN`; the containerized build and MLIR regression suite have passed independently.

## Deployment Qualification

Provide the deployment-specific model IDs, endpoints, effort spellings, and credentials listed in [provider-smoke-tests.md](provider-smoke-tests.md) and resolve the gateway failure before rerunning real-route qualification. Provide target-device access and task-specific runtime inputs to qualify hardware checks. Until then, the implementation is reproducible and MLIR-qualified but not production-route or hardware qualified.

## Dev Note

None.
