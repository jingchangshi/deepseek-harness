---
kind: upgrade-guide
description: 工程 profile 新增自适应 task 策略、能力升级路由和持久化调度产物。
---

# 工程自适应调度

[English](guide.md) | 中文

## 变更

工程 profile 现在会根据仓库范围、验收条件、风险和部署策略为 Development task 分类，并选择角色阶段。部署 workflow 新增文件数阈值和有限升级次数。角色配置可以选择更强的路由；模型路由声明能力等级。现有部署文件由用户所有，安装不会向已有文件添加这些设置。缺少调度策略的 task 使用保守分类并保持 complex；现有 task 产物会保留。

角色模型现在返回以 `response` 为根对象的 envelope，其中包含完整的 `success` 输出或 `escalate` 请求。能力升级使用独立部署路由和持久化 `SCHEDULING.json` 状态。Writer 诊断始终要求新的冻结 plan，即使模型建议 `REPAIR_WITHIN_PLAN` 也一样。

当选中的路由不支持角色的默认推理等级时，在部署 `roles.yaml` 中显式声明 `roles.<role>.routeReasoningEfforts.<routeId>`。对模板中的 Implementer 和 architecture 路由，设置 `implementer.routeReasoningEfforts.architecture: high`。加载器会在派发前拒绝未知路由和不支持的等级。安装会保留现有文件，因此使用更强路由的已有部署需要添加此映射。

## 迁移

1. 在 `<DSH_HOME>/engineering/.agent/config/workflow.yaml` 中添加顶层设置 `simpleMaxFiles`、`standardMaxFiles`、`maxCapabilityEscalations` 和 `repairEscalationThreshold`。默认值分别为 3、12、2 和 2。
2. 在部署 `models.yaml` 中为可能执行升级的路由设置 `capabilityLevel`；省略时默认为 0。在 `roles.yaml` 中添加合格的 `escalationRoutes`，必要时添加最多两个 `escalationFallbackRoutes`。更强路由的等级必须高于失败路由；provider/model 必须经过授权、支持所需 reasoning effort，并通过数据分类和 premium 策略。详见[模型路由](../../../software-engineering-harness/model-routing.zh.md)。
3. 对可归为 simple 的 task，在目标仓库 `.agent/config/project.yaml` 中添加 `scheduling`，设置分类、显式文件叶子 `scopePaths` 和 `acceptanceCriteria`。已知风险值为 `concurrency`、`lifecycle`、`security`、`runtime`、`compiler-ir` 和 `cross-module`。Compiler profile 始终保持 complex。全部策略字段和范围规则见[自适应调度参考](../../../software-engineering-harness/adaptive-scheduling-v2.zh.md)。
4. 重启 engineering profile。运行一个有界 task，并检查 `.agent/tasks/<taskId>/SCHEDULING.json`、`BASELINE.json` 和 `PLAN-SCHEDULING-<workRevision>.json`。确认冻结分类符合仓库策略，且 simple task 的修改仍在列出的文件范围内。保留这些 task 产物；不要修改其中的计数或手动重建文件。
