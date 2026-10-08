# Engineering Harness V2 验证报告

[English](verification-report-v2.md) | 中文

## 概述

本报告按[验收矩阵](acceptance-matrix-v2.zh.md)记录已执行的证据。结果仅适用于所列测试路径和命令；未完成的最终套件仍标记为待完成。Phase 0 验收为 `PARTIAL`，Phase 1–4 为 `NOT_RUN`。

## Phase 0 证据

| 证据 | 结果 | 一手依据 |
|---|---|---|
| Mutation 回归基线 | 观察到 RED：7 项失败、6 项通过，共 13 项。 | `tools/agent/tests/runtime-mutation.spec.ts` |
| Dispatch observer 能力基线 | 观察到 RED：22 项失败；随后扩展到 28 个用例。最终 28 个用例通过。 | `packages/core/tools/tests/body-start.spec.ts` |
| 原始 `$id` schema 基线 | 观察到 3 项失败、25 项通过。验证器隔离后，最终 observer/schema 套件通过。 | `packages/core/tools/tests/body-start.spec.ts` |
| 不确定 writer cleanup 基线 | 观察到 2 项失败。 | `tools/agent/tests/automatic.spec.ts` |
| 直接 writer 准入基线 | 观察到 7 项失败、51 项通过。 | `tools/agent/tests/repository.spec.ts` |
| Mutation runtime GREEN | 13 个测试通过。 | `tools/agent/tests/runtime-mutation.spec.ts` |
| Writer 套件 GREEN | 123 个测试通过。 | `tools/agent/tests/runtime-lifecycle.spec.ts`、`tools/agent/tests/automatic.spec.ts`、`tools/agent/tests/repository.spec.ts`、`tools/agent/tests/state-machine.spec.ts` |
| Profile 回归 | 29 个测试通过。 | Phase 0 最终验证中的 profile 回归命令。 |
| Core 工具回归 | 五个文件中的 318 个已有测试和全部 28 个 observer/schema 用例通过。 | `packages/core/tools/tests/`、`packages/core/tools/tests/body-start.spec.ts` |
| Structured-output 回归 | 30 个测试通过。 | `packages/subagent/subagent-in-process-driver/tests/structured.spec.ts` |
| Read-capability 回归 | 初次运行 581 项通过、1 项失败，原因为过时的 spill hint。修正后的定向回归 1 项通过；不声称 582 项全部通过。 | Phase 0 最终验证中的 read-capability 回归命令和修正后的定向 spill-hint 测试。 |
| 录制会话行为 | 对全部六个子角色各执行一次录制刷新和回放，均通过；覆盖 unknown bash、无效 structured output，以及输出有效且不改文件时接受任务。 | `tools/agent/tests/runtime-mutation.spec.ts`、`snapshots/` |
| 文档检查 | 新增本报告前，一次 `doc-sync` 的 42 项 gate 通过；本报告通过定向 pairing、换行、链接和 diff 检查。 | `pnpm run doc-sync`；`pnpm exec tsx scripts/verify-translation-pairing.ts`；`pnpm run verify-md-wrap`；`pnpm run verify-md-links`；`git diff --check` |
| 构建与定向 lint | 通过。 | Phase 0 最终验证中使用的构建和定向 lint 命令。 |
| Package hygiene | PARTIAL：16 项 gate 中 15 项通过。vendor rescope gate 在 16 个未修改路径上失败；从起始 HEAD 的 detached worktree 中复现了相同失败。 | Package hygiene 命令和起始 HEAD 的 detached worktree 基线。 |
| 独立设计评审 | APPROVED。 | `docs/software-engineering-harness/architecture-v2.zh.md` |
| 独立实现评审 | APPROVE；修正后的最终结论。 | 上述 Phase 0 源码与测试路径 |

## 待完成证据

| 检查 | 状态 |
|---|---|
| Observer/schema 套件 | PASS：28 个用例。 |
| Profile 回归套件 | PASS：29 个用例。 |
| 构建与定向 lint | PASS。 |
| 新增本报告后的全量 `doc-sync` | PENDING |
| Package hygiene | PARTIAL：16 项 gate 中 15 项通过；一项失败已在基线复现。 |
| 独立实现评审 | APPROVE。 |
| 提交与推送确认 | NOT_RUN |
| Phase 1–4 验证 | NOT_RUN |

原始私有 Session ZIP 文件因读取返回 `PermissionError` 而不可用。fixture 根据已记录行为编写，不声称复现原始 Session 字节。配置的 worker route 不可用，因此测试设计和实现使用了实际可用的 `gpt-6-luna` 与 `gpt-6.1-sol` 模型。本文不声称有在线 provider、benchmark、token 成本或定价证据。
