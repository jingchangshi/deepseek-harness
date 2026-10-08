# Engineering Harness V2 验证报告

[English](verification-report-v2.md) | 中文

## 概述

本报告记录[验收矩阵](acceptance-matrix-v2.zh.md)的已执行证据。结果仅适用于具名测试路径和命令。Phase 0–2 已验收并推送。Phase 3 已验收，等待交付；Phase 4 为 `NOT_RUN`。

## Phase 0 证据

| 证据 | 结果 | 一手依据 |
|---|---|---|
| Mutation 回归基线 | 观察到 RED：7 项失败、6 项通过，共 13 项。 | `tools/agent/tests/runtime-mutation.spec.ts` |
| Dispatch observer 能力基线 | 观察到 RED：22 项失败；随后扩展到 28 个用例。最终 28 个用例通过。 | `packages/core/tools/tests/body-start.spec.ts` |
| 原始 `$id` schema 基线 | 观察到 3 项失败、25 项通过。验证器隔离后，最终 observer/schema 套件通过。 | `packages/core/tools/tests/body-start.spec.ts` |
| 不确定 writer cleanup 基线 | 观察到 2 项失败。 | `tools/agent/tests/automatic.spec.ts` |
| 直接 writer 准入基线 | 观察到 7 项失败、51 项通过。 | `tools/agent/tests/repository.spec.ts` |
| Mutation runtime GREEN | 13 个测试通过。 | `tools/agent/tests/runtime-mutation.spec.ts` |
| Writer 套件 GREEN | automatic、repository 和 state-machine 套件共 123 个测试通过。 | `tools/agent/tests/automatic.spec.ts`、`tools/agent/tests/repository.spec.ts`、`tools/agent/tests/state-machine.spec.ts` |
| Profile 回归 | 29 个测试通过。 | Phase 0 最终验证中的 profile 回归命令。 |
| Lifecycle 集成回归 | 历史集成运行：198 项通过、2 项因 fixture 失败。修正 fixture 后，定向 lifecycle 套件 8 项全部通过。 | `tools/agent/tests/runtime-lifecycle.spec.ts`、`snapshots/session/engineering-harness/` |
| Core 工具回归 | 五个文件中的 318 个已有测试和全部 28 个 observer/schema 用例通过。 | `packages/core/tools/tests/`、`packages/core/tools/tests/body-start.spec.ts` |
| Structured-output 回归 | 30 个测试通过。 | `packages/subagent/subagent-in-process-driver/tests/structured.spec.ts` |
| Read-capability 回归 | 初次运行 581 项通过、1 项失败，原因为过时的 spill hint。修正后的定向回归 1 项通过；不声称 582 项全部通过。 | Phase 0 最终验证中的 read-capability 回归命令和修正后的定向 spill-hint 测试。 |
| 录制会话行为 | 对全部六个子角色各执行一次录制刷新和回放，均通过；覆盖 unknown bash、无效 structured output，以及输出有效且不改文件时接受任务。 | `tools/agent/tests/runtime-mutation.spec.ts`、`snapshots/` |
| 文档检查 | 最新一次 `doc-sync` 的 42 项 gate 通过；本报告通过定向 pairing、换行、链接和 diff 检查。 | `pnpm run doc-sync`；`pnpm exec tsx scripts/verify-translation-pairing.ts`；`pnpm run verify-md-wrap`；`pnpm run verify-md-links`；`git diff --check` |
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
| 新增本报告后的全量 `doc-sync` | PASS：最新 42 项 gate 通过。 |
| Package hygiene | PARTIAL：16 项 gate 中 15 项通过；一项失败已在基线复现。 |
| 独立实现评审 | APPROVE。 |
| Phase 2 验收与推送 | PASS：已在目标 remote 分支确认已验收的阶段提交。 |
| Phase 3 最终审查和交付 | APPROVE；等待推送。 |
| Phase 4 验证 | NOT_RUN。 |

原始私有 Session ZIP 文件因读取返回 `PermissionError` 而不可用。fixture 根据已记录行为编写，不声称复现原始 Session 字节。配置的 worker route 不可用，因此测试设计和实现使用了实际可用的 `gpt-6-luna` 与 `gpt-6.1-sol` 模型。本文不声称有在线 provider、benchmark、token 成本或定价证据。

## Phase 1 证据

| 证据 | 结果 | 一手依据 |
|---|---|---|
| 独立实现评审 | APPROVE。 | Phase 1 评审结果。 |
| Git evidence、review-only 和 runtime review | 最终合并运行共 52 个测试通过。 | `tools/agent/tests/git-evidence.spec.ts`、`tools/agent/tests/review-only.spec.ts`、`tools/agent/tests/runtime-review.spec.ts` |
| RED 历史 | 初次因缺少能力而失败的运行执行了 0 个测试，不属于行为 RED。之后一次有效运行有 5 项失败、49 项通过。新增的 reviewer 负例与修复同时加入，没有 RED 基线。 | `/tmp/dsh-goal-1008/phase1-review-red.txt`、`/tmp/dsh-goal-1008/phase1-review-followup.txt` |
| Schema 回归 | 40 个测试通过。 | Phase 1 schema 回归命令。 |
| 现有 automatic 回归 | 最终串行运行 64 个测试通过。较早的一次宽范围运行有 23 项超时、41 项通过；定向普通和诊断运行分别通过 6 项和 30 项，且超时情况没有变化。 | `tools/agent/tests/automatic.spec.ts`；Phase 1 automatic 回归记录。 |
| Typecheck 和定向 lint | 通过。 | Phase 1 最终 typecheck 和定向 lint 命令。 |
| Engineering Harness 快照 | 七个子角色的刷新和回放均通过。root-hash 元组仅在 fixture 中修正，未修改共享 normalizer。 | `snapshots/session/engineering-harness/`；Phase 1 快照刷新和回放记录。 |
| 文档 | 最新一次 `doc-sync` 的 42 项 gate 通过。 | Phase 1 `doc-sync` 运行。 |
| Package hygiene | PARTIAL：16 项 gate 中 15 项通过；vendor rescope 失败可在起始基线上复现。 | Package hygiene 基线记录。 |
| 在线 provider 运行 | NOT_RUN；不声称执行过在线 provider。 | Phase 1 执行记录。 |
| Freeze 更新检查 | PASS。 | Phase 1 freeze 更新和检查记录。 |
| 推送前 typecheck | PASS。 | Phase 1 推送前检查。 |
| Phase 1 提交和推送 | PASS；已在配置的目标 remote 分支确认推送的准确提交。 | Phase 1 交付记录。 |

首次 reviewer RED 尝试在模块导入时失败，没有执行测试，因此不构成行为证据。上表分别记录了有效 RED 运行和后续 GREEN 结果。下方记录 Phase 2 证据；Phase 3 和 Phase 4 的证据见对应章节。

## Phase 2 证据

| 证据 | 结果 | 一手依据 |
|---|---|---|
| 独立源码评审 | 最终结论为 APPROVE。评审者核验了六个文件中的 52 个测试，并在独立重跑排序回归、检查并发证据后批准同步准入排序修正。 | `/tmp/dsh-goal-1008/phase2-review-verdict.txt` |
| 定向实现覆盖 | 六个文件中的 52 个唯一测试均通过并经独立核验，覆盖 provider dispatch 观察、累计生命周期限制、检查点恢复、Review-only 复用、调查检查及运行时预算。 | `packages/llm/llm/tests/dispatch-observation.spec.ts`；`tools/agent/tests/lifecycle-budget.spec.ts`；`tools/agent/tests/investigation-checkpoints.spec.ts`；`tools/agent/tests/review-checkpoints.spec.ts`；`tools/agent/tests/runtime-inspection.spec.ts`；`tools/agent/tests/runtime-budgets.spec.ts`；`/tmp/dsh-goal-1008/phase2-acceptance-final.txt`；`/tmp/dsh-goal-1008/phase2-final-review-regressions-green.txt` |
| 既有回归 | 集成后 64 个 automatic 测试及 99 个 repository/schema 测试通过。 | `/tmp/dsh-goal-1008/phase2-automatic-regression-final.txt`；`/tmp/dsh-goal-1008/phase2-repository-schema-regression.txt` |
| Runtime 和 fixture 回归 | 13 个 runtime mutation 与 migration 测试通过。最终修改后的真实 adapter 销毁检查通过。 | `/tmp/dsh-goal-1008/phase2-mutation-migration-green.txt`；`/tmp/dsh-goal-1008/phase2-runtime-lifetime-final-green.txt` |
| 快照回放 | Engineering Harness 按顺序启动 Scout 的回放通过。 | `/tmp/dsh-goal-1008/phase2-snapshot-ordered-replay.txt` |
| RED 证据 | 初始恢复 RED：1 项失败；生命周期 ledger 评审 RED：7 项失败、12 项通过；检查点回执验证 RED：1 项失败。之后，四个安全用例在隔离的修复前控制副本中失败。这些运行验证了用例，不代表最终源码失败。导入失败或无关超时不计作行为证据。 | `/tmp/dsh-goal-1008/phase2-recovery-red.txt`；`/tmp/dsh-goal-1008/phase2-ledger-review-red.txt`；`/tmp/dsh-goal-1008/phase2-checkpoints-red.txt`；`/tmp/dsh-goal-1008/phase2-final-review-negative-red.txt` |
| 初次文档总检查 | 42 项 gate 中 37 项通过。五项失败包括两个过期的生成目录/图、过期的持久化清单，以及并行编辑文档时的双语代码块配对失败。 | `/tmp/dsh-goal-1008/phase2-doc-sync.txt` |
| 最终文档总检查 | PASS：42 项 gate 全部通过，0 项失败、0 项跳过。 | `/tmp/dsh-goal-1008/phase2-doc-sync-final.txt` |
| 同步准入排序 | 修正后的确定性回归测试通过。隔离的反序控制按预期失败；评审者也检查了现有并发通过结果，并批准最终修改。 | `/tmp/dsh-goal-1008/phase2-scout-start-order-latched-green.txt`；`/tmp/dsh-goal-1008/phase2-scout-start-order-latched-negative-red.txt`；`/tmp/dsh-goal-1008/phase2-review-verdict.txt` |
| Provider 成本证据 | NOT_RUN。Provider 定价尚未核验；成本仍未知，未定价请求会使 `maxKnownCostUsd` 关闭后续请求，因此它不是支出上限。 | `/tmp/dsh-goal-1008/provider-availability.json` |
| Phase 2 验收与交付 | PASS。已验收的提交已推送到 `ascendnpu-engineering-harness`；远端确认一致。 | `/tmp/dsh-goal-1008/phase2-push.txt`；`/tmp/dsh-goal-1008/phase2-remote-confirmed.txt` |

Phase 2 验收和推送均为 PASS。

## Phase 3 证据

| 证据 | 结果 | 一手依据 |
|---|---|---|
| Phase 3 定向行为测试 | 四个由独立测试设计者维护的文件共 59 个测试通过。此前定向运行有重叠，不计入累计数量。 | `/tmp/dsh-goal-1008/phase3-final-independent.txt`；`/tmp/dsh-goal-1008/phase3-diagnosis-durable-output.txt` |
| Scheduling store 回归 | 三个文件中的 70 个测试通过。 | `/tmp/dsh-goal-1008/phase3-store-regression.txt` |
| Runtime 回归 | 三个文件中的 88 个测试通过。 | `/tmp/dsh-goal-1008/phase3-runtime-regression.txt` |
| Freeze 检查 | 三个测试通过。 | `/tmp/dsh-goal-1008/phase3-freeze-green.txt` |
| Engineering Harness 快照 | 一次录制刷新和一次回放通过。 | `/tmp/dsh-goal-1008/phase3-snapshot-refresh.txt`；`/tmp/dsh-goal-1008/phase3-snapshot-replay.txt` |
| Typecheck 和定向 lint | PASS。 | `/tmp/dsh-goal-1008/phase3-typecheck-final.txt`；`/tmp/dsh-goal-1008/phase3-lint.txt` |
| RED 证据 | 行为回归：adaptive scheduling 修复前 3 项失败、1 项通过；capability dispatch 修复前 4 项失败。更早的 ledger 检查有 15 项失败，原因为新 API 尚不存在；这些缺少 API 的检查与行为回归分开记录。 | `/tmp/dsh-goal-1008/phase3-adaptive-focused-red.txt`；`/tmp/dsh-goal-1008/phase3-capability-dispatch-red.txt`；`/tmp/dsh-goal-1008/phase3-scheduling-final-capability-red.txt` |
| 设计评审 | APPROVE。 | `/tmp/dsh-goal-1008/phase3-interfaces.md`；Phase 3 设计评审结论。 |
| 独立源码审查 | 最终结论：APPROVE。Reviewer 检查了代码、崩溃回归和最终文档证据。 | `/tmp/dsh-goal-1008/phase3-review-verdict.txt` |
| Phase 3 验收 | PASS；等待普通推送。最终文档汇总的 42 个 gate 全部通过，没有失败或跳过。 | `/tmp/dsh-goal-1008/phase3-doc-sync-final.txt`；Phase 3 交付记录。 |
| Phase 4 验证 | NOT_RUN。 | 尚未开始。 |
