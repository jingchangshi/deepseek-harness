# Engineering Harness V2 验证报告

[English](verification-report-v2.md) | 中文

## 概述

本报告记录[验收矩阵](acceptance-matrix-v2.zh.md)的已执行证据。结果仅适用于具名测试路径和命令。Phase 0–3 已验收并推送。Phase 4 聚焦实现检查通过，独立源码评审已批准。HY4 MLIR 运行中 A/B 通过、C 被拒绝、D 超时；Responses role smoke 通过，但 structured output 仍为 NOT_RUN。Run 14 使用当前冻结 persona 和配置路由，在 recovery-latch fixture 中通过 D 的恢复后源码验收；D 的首次实现未通过 oracle，A/B/C 被阻断。另一项固定版 MLIR 运行仍在进行，整体评测目标仍为 partial。

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
| 文档检查 | 已记录的一次 42 项 `doc-sync` 在当前编辑前通过；当前编辑后的最终验证结果随后记录。 | `pnpm run doc-sync`；`pnpm exec tsx scripts/verify-translation-pairing.ts`；`pnpm run verify-md-wrap`；`pnpm run verify-md-links`；`git diff --check` |
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
| 当前编辑前的全量 `doc-sync` | PASS：42 项 gate 通过；当前编辑等待最终汇总检查。 |
| Package hygiene | PARTIAL：16 项 gate 中 15 项通过；一项失败已在基线复现。 |
| 独立实现评审 | APPROVE。 |
| Phase 2 验收与推送 | PASS：已在目标 remote 分支确认已验收的阶段提交。 |
| Phase 3 验收与推送 | PASS：已记录正常推送和 remote 分支确认。 |
| Phase 4 状态 | PARTIAL：聚焦检查通过，独立源码评审已批准；最近一次 Review 运行中 A 通过，固定版 MLIR 运行中 A/B 通过，其他策略被阻断或拒绝。 |

原始私有 Session ZIP 文件因读取返回 `PermissionError` 而不可用。fixture 根据已记录行为编写，不声称复现原始 Session 字节。配置的 worker route 不可用，因此测试设计和实现使用了实际可用的 `gpt-6-luna` 与 `gpt-6.1-sol` 模型。Phase 4 在线 provider 证据见下文；provider 定价和账单证据仍不可用。

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
| 文档 | 已记录的一次 `doc-sync` 的 42 项 gate 通过。 | Phase 1 `doc-sync` 运行。 |
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
| Phase 3 验收与交付 | PASS。已评审阶段已正常推送，remote 分支内容一致。 | `/tmp/dsh-goal-1008/phase3-push.txt`；`/tmp/dsh-goal-1008/phase3-remote-confirmed.txt` |
## Phase 4 证据

| 证据 | 结果 | 一手依据 |
|---|---|---|
| 设计评审 | 已批准；设计已冻结。 | `/tmp/dsh-goal-1008/phase4-interfaces.md`；Phase 4 设计评审结论。 |
| 实施与聚焦验证 | 先前聚焦运行通过了 92 项测试和 8 项后续修正。最终 combined evaluation 在 9 个文件中通过 46 项测试；独立源码评审批准了 diagnostics 和公平性修正。Persona 配置/runtime 套件通过 89 项测试，另有一次 8 项测试的聚焦 persona 运行。定向 typecheck 和 lint 通过。 | `/tmp/dsh-goal-1008/phase4-final-green.txt`；`/tmp/dsh-goal-1008/phase4-final-corrections-green.txt`；`/tmp/dsh-goal-1008/phase4-final-types-complete.txt`；`/tmp/dsh-goal-1008/phase4-final-lint-complete.txt`；`/tmp/dsh-goal-1008/phase4-independent-review-latest.txt`；`/tmp/dsh-goal-1009/final-all-evaluation-green.txt`；`/tmp/dsh-goal-1009/final-all-types.txt`；`/tmp/dsh-goal-1009/final-review-verdict.txt`；`/tmp/dsh-goal-1009/diagnostics-lint.log`；`/tmp/dsh-goal-1009/fairness-lint.log`；`/tmp/dsh-goal-1009/review-persona-focused.txt`；`/tmp/dsh-goal-1009/review-persona-green.txt` |
| 命名的写入前恢复保护 | 修复前两个预期 RED 用例失败。修复后五个 recovery-binding 用例全部通过，包括 outer fixture；独立安全评审为 APPROVED。30 秒 diagnostic automatic runner 通过 64/64。默认 5 秒 automatic run 超时（一次 101/112，串行运行 54/64），因此不声称整个 automatic 套件通过。Strict block-assumption 用例在默认 5 秒下通过；repository 回归 48/48 通过。 | `tools/agent/tests/evaluation-recovery-binding.spec.ts`；automatic runner 和 repository 回归记录。 |
| Persona 与 snapshot 评审 | Persona 修改已批准。刷新后的 Engineering Harness snapshot replay 通过 1 个用例。 | `/tmp/dsh-goal-1009/review-persona-green.txt`；`/tmp/dsh-goal-1009/final-snapshot-refresh.txt`；`/tmp/dsh-goal-1009/final-snapshot-replay.txt` |
| Workspace 与 writer lease 回归 | 有效 RED 运行有 3 项失败、1 项通过。修正后 4 项测试全部通过。隔离重放另有 3 项产品失败和 1 项无关的 spawn `MODULE_NOT_FOUND` 初始化失败；环境失败不计入行为数量。 | `/tmp/dsh-goal-1009/baseline-lease-red.txt`；`/tmp/dsh-goal-1009/baseline-lease-green.txt`；`/tmp/dsh-goal-1009/recovery-negative-diagnostic.txt` |
| 录制会话快照 | 刷新受影响的 Review-only system-prompt 预期值后回放通过：1 项通过，140 项无关用例跳过。 | `/tmp/dsh-goal-1009/final-snapshot-refresh.txt`；`/tmp/dsh-goal-1009/final-snapshot-replay.txt`；`snapshots/session/engineering-harness/system-prompt.7.expected.md` |
| Pebble 在线对比 | 四种策略都有已验证的 lifecycle 证据。A：7 个 request/66007 个已知 token；B：17/166883，另有一个未知 request；C：17/260665 个已知 token；D：28/134712，另有一个未知 request。全部被阻断；D 耗尽预算，独立 oracle 拒绝其输出。 | `/tmp/dsh-engineering-comparison-1778374b-f731-491b-8537-62aef19b62f5.json`；`evaluation-evidence-v2.json` |
| 修正 workflow 前的 Review 对比 | 四种策略均被阻断：A 缺少冻结的验证产物；B 的 finding 证据不完整或无效；C 达到 challenger 时限；D 未完成持久化 review。此运行作为早期运行证据保留。 | `/tmp/dsh-engineering-comparison-30bd3417-6a8c-4395-ba60-fad05fe08e7e.json`；`evaluation-evidence-v2.json` |
| 最近一次 Review 对比 | A 通过独立的缺陷 commit、干净 control 和源码证据验收（6 个 request/43864 个已知 token）。B 因引用无效和 scope 问题未解决而被阻断；C 在 challenger 时限处被阻断；D 有 1 个 finding 和 3 项 evidence，但被拒绝。此运行 dispatch 了 35 个 request，已知 token 为 248055；其中 1 个 request 的 token 总量未知。此运行早于共享 criteria 公平性修正；各策略总量不能作为受控效率对比。 | `/tmp/dsh-engineering-comparison-442a0327-47f8-4409-bc42-50532b005f5a.json`；`evaluation-evidence-v2.json` |
| Review 语义重试（备用部署） | D 通过缺陷 commit、干净 control、源码和 diff oracle 证据验收（2 个 request/16024 个已知 token）。A/B/C 因证据不完整而被阻断。本次语义重试使用隔离的备用部署，将 `scout-secondary` 和 `challenger` 的 `worker-secondary` 路由改为 `worker`；角色 snapshot 和 freeze manifest 未改变。默认 Review 部署仍未验证，因此该结果不证明默认 Review 路由成功，也不证明策略节省。 | `/tmp/dsh-engineering-comparison-9005b30f-9932-4af9-adfc-0c34ef0ab406.json`；`evaluation-evidence-v2.json` |
| MLIR 在线对比 | A 无法在可写 workspace 中访问 fixture；B 和 C 达到角色时限；D 耗尽预算，独立 oracle 拒绝未更改的输出。oracle 使用固定版本 `mlir-opt` 15.0.6。此运行 dispatch 了 76 个 request，已知 token 为 850335。 | `/tmp/dsh-engineering-comparison-37366fd1-670c-49c7-9d44-2d31142e0ede.json`；`evaluation-evidence-v2.json` |
| MLIR 源 workflow 运行 | 所有策略均因角色时限被阻断。未配置固定版本的 MLIR oracle，因此语法验证状态为 NOT_RUN。此运行 dispatch 了 63 个 request，已知 token 为 688373；两个 request 的 token 总量未知。 | `/tmp/dsh-engineering-comparison-73f8a819-ffee-444b-b873-9aa9bdb110c2.json`；`/tmp/dsh-goal-1009/live-mlir-driver.txt`；`evaluation-evidence-v2.json` |
| 最近一次固定版 MLIR 运行 | A/B 首次尝试即通过，并通过源码和 LLVM 15.0.6 语法检查；C/D 被阻断。此运行 dispatch 了 77 个 request，已知 token 为 1021692；两个 request 的 token 总量未知。 | `/tmp/dsh-engineering-comparison-08dd71a6-88a7-465a-a814-8fae307b70c6.json`；`evaluation-evidence-v2.json` |
| HY4 完整 MLIR 运行 | A/B 通过源码及固定版 `mlir-opt` 15.0.6 语法检查。C 的源码和 LLVM 语法 oracle 通过，但 Reviewer 结果为 FAILED，因此整体状态为 REJECTED；具体原因 UNKNOWN。D 在 challenger 300 秒超时后被阻断。GLM fallback 尝试在 provider dispatch 前失败，原因 UNKNOWN；Qwen fallback 未尝试。运行共使用 90 个 provider request，已知 token 为 1191545，另有一个 request 的 token 数未知。 | `/tmp/dsh-engineering-comparison-2e60b9cf-42ef-4801-a9e3-5e543d1bef48.json`；`evaluation-evidence-v2.json` |
| Responses role smoke | 七个配置角色和两个 fallback role smoke 均通过。这些仅是角色级结果：structured-output 检查为 NOT_RUN，因此不能证明完整 workflow 成功。 | `/tmp/dsh-goal-1009/responses-role-smokes.json`；`evaluation-evidence-v2.json` |
| Responses 600 秒 MLIR 尝试 | 在 2400 秒 CLI 时限处 TIMEOUT（`CLI_TIMEOUT`）。CLI 未捕获 `reportPath`，但从磁盘恢复了完整 comparison report，记为 run 12。A 通过；B 在 dispatch 修改工具后因没有 structured output 被阻断，故 fallback 被禁用；C 虽通过源码和 LLVM 语法 oracle，仍为 REJECTED，具体原因 UNKNOWN；D 被阻断，49 个 request 中已知 token 为 440017，另有一个 request 总量未知，源码 oracle exit code 为 1。完整评测目标未通过。Primary Session 确认 Challenger 连续执行三轮，均为 `attemptIndex: 1`，使用配置路由且未使用 provider fallback。前两轮未触发 role timeout，分别在 274808 和 442828 ms 后正常以 REVISE 结束，分别有 8 和 10 个 finding。第三轮记录 46980 ms，但没有 turn-end 结果，因此状态 UNKNOWN。每次 REVISE 后 task 保持 INVESTIGATED，并进入下一轮 Architect/Challenger；只有 ACCEPT decision 才会冻结 plan。Finding 质量尚未评估。超时的 driver attempt 不计入已选 engineering totals；从该 attempt 恢复的 comparison report 作为 run 12 计入一次。Primary report、driver 和 stdout/stderr 路径只作为本机参考；不包含原始日志或 Session 内容。Session UUID 和本机 artifact 路径模式见 `evaluation-evidence-v2.json`。 | `/tmp/dsh-goal-1008/dsh-live-comparison-3614556-1791516213216.json`；`/tmp/dsh-goal-1009/responses-600s-mlir-driver.txt`；`/tmp/dsh-engineering-comparison-271daedf-9ccb-4e1d-b521-5c8939cca903.json`；`evaluation-evidence-v2.json` |
| 旧 persona Recovery-latch 对比 | Run 13 使用此前复制的 persona。A/B 在写入前被注入故障阻断，策略 request 为 0；C 被拒绝；D 虽被阻断，但 oracle 接受了范围内的源码修改，且 `firstImplementationPass: false`。该运行使用 92 个 request 和 1744339 个已知 token。它不代表恢复最终验收，也不能验证当前 persona 编辑。 | `/tmp/dsh-engineering-comparison-41a004d1-e309-4b53-a1c0-fe1f8a7ed306.json`；`evaluation-evidence-v2.json` |
| Fixed-recovery 尝试 | 首次 fixed-persona 尝试因 provider 服务过载，在调用 evaluation tool 前退出，没有策略结果。重试已完成并记为 run 14，使用当前冻结 persona 和配置路由。D 在同一 task 的实现失败后恢复，随后独立 oracle ACCEPTED 最终源码；69 条 request usage 记录均与 Session 证据匹配。D 的首次实现未通过 oracle；A/B/C 被命名的注入故障阻断。本次运行共 dispatch 90 个 request，已知 token 为 1336864，没有 token 总量未知的 request。这只证明 D 在 recovery-latch 上恢复后的源码验收；整体比较质量仍为 PARTIAL，MLIR 运行仍在进行，成本为 UNKNOWN。 | `/tmp/dsh-goal-1009/responses-fixed-recovery-driver.txt`；`/tmp/dsh-goal-1009/responses-fixed-recovery-retry-driver.txt`；`/tmp/dsh-engineering-comparison-8deef849-6044-48f3-bbdd-321b5690e2a8.json`；`evaluation-evidence-v2.json` |
| 当前固定版 MLIR 尝试 | RUNNING，CLI 时限为 3600 秒，role 时限为 600 秒。报告更新时尚无 comparison 结果。 | `/tmp/dsh-goal-1009/responses-fixed-mlir-driver.txt`；`evaluation-evidence-v2.json` |
| Recovery 源 workflow 运行 | 所有策略均被阻断：共享故障注入在修改源码前停止 A、B（0 个 provider request）；C 达到 challenger 时限；D 的 Scout-secondary 角色超时。此运行 dispatch 了 59 个 request，已知 token 为 635418；三个 request 的 token 总量未知。此运行与固定版 MLIR 同时运行，因此两者 wall time 不能对比。 | `/tmp/dsh-engineering-comparison-d016b96a-392f-45b3-98bc-dde72a9ebd50.json`；`/tmp/dsh-goal-1009/live-recovery-driver.txt`；`evaluation-evidence-v2.json` |
| 已记录对比总量 | 所选 engineering runs 3–14 共 dispatch 821 个 provider request，已知 token 小计为 10186384，另有 12 个 request 的 token 总量未知。Run 12 恢复的 MLIR report 和 run 14 恢复的 recovery-latch report 均只计入一次，不重复计入 CLI attempt。Run 10 使用备用 secondary 路由，run 11 使用 HY4 路由，run 13 使用旧 persona；这些运行分别记录，不构成受控对比。Role smoke、没有策略报告的 CLI attempt 和外层 coordinator 失败均排除。共享的外层 Coordinator request 未归属到某个策略。总量包含共享 criteria 公平性修正前的运行，不能支持受控效率对比。MLIR 和 Recovery 同时运行，因此两者 wall time 不能对比。策略节省和成本仍为 UNKNOWN。 | `evaluation-evidence-v2.json` |
| 成本与定价 | 尚不能证明策略节省。由于缺少已核实的定价和账单证据，估算成本和实际账单金额均为 UNKNOWN；各策略 ledger 不包括共享的外层 Coordinator request。 | `evaluation-evidence-v2.json` |
| Task 时间 | Repository 状态和 lifecycle 时间是分开写入的。写入中断或缺失时，task 时长为 UNKNOWN。 | `tools/agent/src/automatic.ts`；`tools/agent/src/lifecycle.ts` |
