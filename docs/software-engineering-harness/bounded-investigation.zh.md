# 有界调查与生命周期预算

[English](bounded-investigation.md) | 中文

## 概述

Deployment owner 可设置每个角色的时限、工具上限、任务累计预算，以及上下文和调查范围上限。只读 Scout 工作会拆分为有范围的单元；当任务范围和源文件仍匹配时，可恢复使用已验证的证据。

## 目录

- [Deployment 限制](#deployment-limits)
- [调查单元](#investigation-units)
- [检查点与复用](#checkpoints-and-reuse)
- [预算耗尽与恢复](#budget-exhaustion-and-recovery)
- [进一步探索](#further-exploration)

<a id="deployment-limits"></a>
## Deployment 限制

在已部署 engineering profile 的 `.agent/config/workflow.yaml` 中设置运行时限制。下方数值与解析器校验的默认值一致。除非 deployment owner 明确选择，否则不设置可选的 token 和成本上限。

```yaml
lifecycleBudget:
  maxLogicalInvocations: 60
  maxModelAttempts: 120
  maxProviderRequests: 600
  maxToolCalls: 1200
  maxElapsedMs: 7200000
roleBounds:
  scout-primary:
    softDeadlineMs: 90000
    hardDeadlineMs: 240000
    maxToolCalls: 40
  scout-secondary:
    softDeadlineMs: 90000
    hardDeadlineMs: 240000
    maxToolCalls: 40
  architect:
    softDeadlineMs: 300000
    hardDeadlineMs: 480000
    maxToolCalls: 40
  challenger:
    softDeadlineMs: 180000
    hardDeadlineMs: 300000
    maxToolCalls: 30
  reviewer:
    softDeadlineMs: 300000
    hardDeadlineMs: 600000
    maxToolCalls: 50
  implementer:
    softDeadlineMs: 300000
    hardDeadlineMs: 600000
    maxToolCalls: 100
maxInvestigationPaths: 40
maxRoleContextBytes: 32768
```

`lifecycleBudget` 对一个 development 或 Review-only task 生效，并在重试、恢复和重新规划期间累计。它统计逻辑角色调用、模型 route 尝试、最终 adapter 请求、工具执行、经过时间和已观测 token。`.agent/config/project.yaml` 中的项目 `maxRoleCalls` 也会限制 `maxLogicalInvocations`。省略 `maxTotalTokens` 和 `maxKnownCostUsd` 时，不启用相应上限。ledger 会把未知用量和成本记录为未知；依赖未知数据的已配置上限会阻止后续 provider 请求。

Lifecycle ledger 不计算 provider 价格。`knownCostUsd` 表示已知成本小计，目前保持为零；这不代表实际支出为零。由于已预留的 provider 请求没有价格归属，启用 `maxKnownCostUsd` 时，仅当 ledger 没有既有请求或历史未知成本状态时允许首次请求，之后的 provider 分发会以 `unknownCost` 阻止。在 provider 价格计量可用前，不要把该字段用作支出上限。

`roleBounds` 为每个已知角色设置限制。软时限会要求 child 根据已取得的证据提交结构化交接；它不能保证模型生成部分结果。硬时限会取消 child 并等待清理完成。工具执行受 `maxToolCalls` 限制。一次逻辑调用及其配置的 fallback attempts 共用同一组角色限制。软时限必须小于硬时限。

`maxInvestigationPaths` 限制每个调查单元的源文件数，也限制自动 Scout 划分范围。`maxRoleContextBytes` 限制序列化后的角色上下文；超限上下文会写入 task 自有文件，并以绑定摘要的引用替代。这两个设置都必须是正整数。

<a id="investigation-units"></a>
## 调查单元

项目 owner 可在 `.agent/config/project.yaml` 中指定一个或两个 Scout 问题：

```yaml
investigationUnits:
  - id: api-flow
    role: scout-primary
    question: Trace the request validation and dispatch path.
    allowedPaths:
      - packages/api/src
```

每个单元指定唯一 ID、Scout 角色、问题和非空的仓库相对 `allowedPaths`。两个单元必须使用不同 Scout 角色，且路径不得重叠。范围路径不得越出仓库、进入 `.git` 或 `.agent`，也不能跟随符号链接。未设置 `investigationUnits` 时，运行时会从已跟踪源文件派生有界 Scout 工作；范围较大的项目必须提供明确的问题和路径。

<a id="checkpoints-and-reuse"></a>
## 检查点与复用

运行时从成功的读取工具结果生成检查回执，其中包含路径和源内容哈希。它会将单元检查点保存在该 task 的 `checkpoints/` 目录中。已完成单元还必须包含通过校验的结构化输出；模型自述不算已检查证据。

对 Development Scout，运行时会在复用前比较 task 问题和单元范围、repository snapshot、范围成员以及每个源文件哈希。匹配的检查点可以在 revision 变化后复用。问题、路径集合、源文件或范围成员变化时，该单元失效。后续尝试只会收到部分 Development 检查点中已有的证据。

对 Review-only Scout，已完成的检查点会绑定不可变 Git snapshot 和变更路径范围。复用前，运行时会检查保留的 Git 页面、实际工具执行回执，以及依据确定性证据规则校验的评审输出。恢复后可复用一个完整且有效的同伴检查点；未完成的 Scout 会重新分派。不同的 snapshot 或变化的范围不能复用检查点。Scout 检查点不能授权写入工作。

<a id="budget-exhaustion-and-recovery"></a>
## 预算耗尽与恢复

Development 期间的累计预算或角色预算耗尽时，task 进入 `BUDGET_EXHAUSTED`，`engineering_run` 返回 `nextAction: INCREASE_BUDGET`。Review-only 返回 `status: BUDGET_EXHAUSTED`，不带 `nextAction` 字段。任一工作流耗尽预算时，都应先增加适用的 deployment 或项目限制，再恢复任务。使用相同 task ID 调用 `engineering_recover` 并传入 `confirmedStopped: false`。使用 `engineering_run` 恢复 Development；使用 `engineering_review`、相同 task ID 和原始 target selector 恢复 Review-only。生命周期预算拒绝请求后，运行时不会 fallback 到其他模型 route。持久化的 `LIFECYCLE.json` 计数会跨恢复和重新规划保留；修改限制不会清除先前用量。状态处理见[任务协议](task-protocol.zh.md#recovery)。

Lifecycle ledger 观察最终的 LLM adapter 分发。Awaited pre-dispatch event 可在调用 adapter 前拒绝请求；adapter iterator 关闭后，post-dispatch 会记录最新 usage chunk 和 outcome。被 replay 短路的请求不会触发这些 event。SDK 内部 HTTP retry 不会逐次观测，因此 ledger 会将其保留为未知。

<a id="further-exploration"></a>
## 进一步探索

- [工程任务协议](task-protocol.zh.md)
- [工程架构](architecture.zh.md)
