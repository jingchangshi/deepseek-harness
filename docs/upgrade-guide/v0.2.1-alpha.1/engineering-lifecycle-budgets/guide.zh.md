---
kind: upgrade-guide
description: 工程任务现在会执行持久化累计生命周期预算，并在达到配置上限时返回 BUDGET_EXHAUSTED。
---

# 工程生命周期预算

[English](guide.md) | 中文

## 变更

工程任务现在会在 `LIFECYCLE.json` 中持久化累计的角色调用、模型尝试、provider 请求、工具调用、经过时间，以及可选的 token 用量。Ledger 也会记录成本未知状态。配置上限阻止新的资源预留时，Development 返回 `BUDGET_EXHAUSTED` 和 `nextAction: INCREASE_BUDGET`；Review-only 返回 `status: BUDGET_EXHAUSTED`，不带 `nextAction` 字段。恢复和重新规划会保留 ledger，因此任务不会在同一个已耗尽的上限下重复工作。实际 provider 用量和结果会按请求结算。部署路由可提供已验证的价格估算；未定价或不完整的用量仍为 `UNKNOWN`。发生无价格请求后，`maxKnownCostUsd` 会 fail closed，不能作为实际账单支出的上限。

## 迁移

1. 如果已部署的默认值足够，无需更改配置。要提高上限，请在 `<DSH_HOME>/engineering/.agent/config/workflow.yaml` 的 `lifecycleBudget` 下修改设置，例如 `maxProviderRequests` 或 `maxElapsedMs`。`maxTotalTokens` 是可选项。除非每条实际派发路由都有已验证的价格与完整用量，否则请省略 `maxKnownCostUsd`；详见[用量统计](../../../software-engineering-harness/usage-evaluation-v2.zh.md)。无价格请求后它会 fail closed，不能限制实际账单支出。如果项目 `maxRoleCalls` 同时限制逻辑调用次数，也要在目标仓库的 `.agent/config/project.yaml` 中提高该字段。
2. 重启 engineering profile，使其加载更新后的 deployment 配置。
3. 对返回 `BUDGET_EXHAUSTED` 的 Development task，使用原有 `taskId` 调用 `engineering_recover`，并设置 `confirmedStopped: false`；随后通过 `engineering_run` 传入该 `taskId` 且不提供新 request，以恢复任务。对 Review-only，使用原有 review task ID 和 `confirmedStopped: false` 执行恢复，再用原始 target selector 调用 `engineering_review`。不要删除 `LIFECYCLE.json` 或修改其中的计数。
4. 确认运行已离开预算耗尽状态。持久化 ledger 会保留先前预留，并将提高后的上限用于后续工作。
