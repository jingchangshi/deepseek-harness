# Adaptive Development 调度 V2 设计

[English](adaptive-scheduling-v2.md) | 中文

## 概述

本参考文档描述已完成的 Phase 3 实现，包括自适应 task 分类、角色调度、能力升级和 writer 失败诊断。其验收仍待最终评审和交付。现有[架构](architecture.zh.md)描述已部署行为。周边设计和交付要求见 [V2 架构](architecture-v2.zh.md)、[实现计划](implementation-plan-v2.zh.md)和[验收矩阵](acceptance-matrix-v2.zh.md)。

## 目录

- [分类与角色阶段](#classification-and-role-stages)
- [响应与路由策略](#response-and-route-policy)
- [持久化升级](#durable-escalation)
- [Writer 诊断与崩溃安全](#writer-diagnosis-and-crash-safety)

-----

<a id="classification-and-role-stages"></a>
## 分类与角色阶段

分类器根据 request、已配置的调度策略、profile、范围事实和风险事实，将 task 归为 `simple`、`standard` 或 `complex`。分类结果包含稳定的原因代码、输入摘要、规范化范围路径，以及是否需要调查或挑战。同一组输入会产生相同结果。仓库策略保存在 `.agent/config/project.yaml`，字段包括 `class`、`scopePaths`、`acceptanceCriteria`、`risks`、`needsInvestigation` 和 `needsChallenge`。

部署侧 `<DSH_HOME>/engineering/.agent/config/workflow.yaml` 顶层的 `simpleMaxFiles`、`standardMaxFiles`、`maxCapabilityEscalations` 和 `repairEscalationThreshold` 负责这些限制，默认值分别为 3、12、2 和 2。策略可请求 `auto` 或指定分类，并提供显式范围路径、验收条件、风险、调查及挑战要求。已知风险包括并发、生命周期、安全、runtime、compiler IR 和跨模块行为。

只有规范化的显式文件路径且验收条件完整时，task 才能归为 simple。目录、通配符、未解析范围、符号链接越界、dirty baseline、compiler profile、`.mlir` 或 IR 范围、显式高风险标记及确定性双语风险标记都不能归为 simple。未知事实至少提升到 standard；编译器工作、高风险和未知旧任务范围提升到 complex。缺少策略或旧状态未知时，默认按 complex 处理。发生越界变更时停止验收，并要求显式 `REPLAN_WITH_SCOPE`；runtime 不会悄然扩大写入权限或回滚用户数据。

同一 task identity 的分类与风险下限只能保持或提高。恢复、累计 journal request、范围提升、策略/配置变更和 replan 都不能降低下限。只有新 task identity 才能从更低的下限开始。Review-only 保留不可变的变更文件分类，不能进入 Development。

Simple 会生成 repository 所有的范围与验收条件记录，并依据完整 request 和实际验证 profile 生成最简 plan，随后运行配置的 Implementer、确定性验证和独立 Reviewer。它不会声称 agent 检查过源码。Standard 仅在策略要求补充缺失证据时运行 Scout，之后运行 Architect、Implementer、验证和 Reviewer；只有策略明确要求时才运行 Challenger。Complex 会运行有界范围调查、Architect、高风险或未知旧范围所需的 Challenger、Implementer、验证和 Reviewer。所有分类都遵守现有 writer lease、验证绑定和评审要求。

冻结 plan 时，runtime 会写入不可变文件 `.agent/tasks/<taskId>/PLAN-SCHEDULING-<workRevision>.json`，记录该 plan 使用的 task identity、revision 和分类。`BASELINE.json` 单独保存捕获的 repository HEAD。接受 simple task 前，runtime 要求 HEAD 与 baseline 相同，并要求所有变更源码路径都位于冻结的文件范围内。若 task 有调度历史但缺少其 work revision artifact，runtime 会阻止验收，并要求提供明确范围信息后重新规划。

<a id="response-and-route-policy"></a>
## 响应与路由策略

结构化角色输出使用 root object，其中只包含一个 `response` 分支：成功分支携带完整的现有角色输出；升级分支携带原因、长度受限且非空的详情，以及部分观察或未解决问题。分支拒绝额外字段，升级分支不能包含成功字段。模型写出的部分观察不算源码回执；只有 runtime 获取的证据才算。所属验证器会解包成功结果并校验其产物。升级会在产物完成前抛出 `CapabilityInsufficientError`，不能进入 task 或 checkpoint 的成功状态。

直接注入的 executor 输出可以保留经过验证的原始成功格式。实际 `structured_output` 使用新 envelope。只要出现 `response` envelope，就必须按该 envelope 校验，不得回退到旧解析方式。结构化 schema 投影必须保留嵌套的 `oneOf` 约束。

`FALLBACK` 在确认清理完成后，依据现有策略处理已分类的 provider、协议或输出失败；它不表示能力不足。只读 role 的显式能力不足结果或持久化 writer 诊断会触发 `ESCALATE`。它使用独立配置且经过校验的更高 `capabilityLevel` route；该 level 必须高于失败的 attempt，包括失败的 fallback attempt。旧 route 默认 level 0，已发布的 architecture route 使用 level 1。该 level 表示部署方声明的能力，不表示价格。可写 role 不会直接升级到另一个 writer。

部署角色在 `roles.yaml` 中用 `escalationRoutes` 声明更强的 route，并可用 `escalationFallbackRoutes` 声明有界的更强 route 备用项；模型 route 的 `capabilityLevel` 位于用户 deployment 的 `models.yaml`。`capabilityLevel` 是非负整数；省略时默认为 0。两组路由都必须与角色主路由和普通 fallback 不同，provider/model 组合不同，支持所选 reasoning effort，并通过数据分类和 premium route 策略。Route 能力必须高于失败的 attempt。最多可配置两个 escalation fallback route；每个都必须高于主路由与普通 fallback 的能力下限，并通过相同路由策略。Runtime 还会针对准确的失败 route 能力过滤候选项。缺少或不合格的 route 会明确失败；自包含的配置错误会在加载时被拒绝。每次物理 dispatch 都记录为 `PRIMARY`、`FALLBACK` 或 `ESCALATE`；更强 route 的 fallback 还要记录所属升级 ID。

升级会携带实际的部分 checkpoint 回执和有界的结构化部分输出，继续受影响的工作。它保留 deadline 和 tool limit，消耗 model/provider/lifecycle 预算，并且不会重复已完成的同伴调查。更强 route 的 provider 失败只遵守单独配置的有界 fallback 策略；不会自动开始另一次能力升级。

<a id="durable-escalation"></a>
## 持久化升级

`SCHEDULING.json` 保存分类输入与摘要、分类及风险事实和升级预留。Development 按 task 保存；Review-only 将升级状态保存在自己的 namespace，并保持只读。账本使用原子串行写入，并绑定 task 与 workflow identity。没有账本的旧 task 仍按 complex 处理。缺失、损坏或不匹配的历史记录不能重置已知升级次数，也不能授权新升级。

每条升级记录包含不透明 ID、持久化 failure key、recovery epoch、目标 role、触发原因、源码指纹、预留时间和以下状态之一：`RESERVED`、`DISPATCHING`、`COMPLETE`、`FAILED` 或 `UNCERTAIN`。新的预留只消耗一次有限 task 上限。子任务调用前，`beginDispatch` 会通过原子比较并交换将状态改为 `DISPATCHING`，并绑定 model attempt。dispatch 前中断的预留可以在相同额度下恢复一次。其持久化的 `dispatchInput` 会保留失败 route ID、有界的部分断言和输入摘要。再次请求相同 role 和输入摘要时，runtime 会验证源码指纹、重新解析已配置的更强 route、直接恢复已保存的部分断言，并使用原预留 dispatch，不会重试失败的 primary attempt。处于 `DISPATCHING` 的记录若在中断后无法确定状态，就属于 uncertain；在操作员通过停工恢复确认 quiescence 前，不得启动其他 role 或 writer。

只有持久化输出及其输入/源码指纹仍匹配时，才可复用已完成结果。失败和不确定结果不能授权 writer。安全的显式恢复会递增持久化 recovery epoch；重试会创建新的计费预留，但累计上限不变。不确定状态恢复前，必须传入 `confirmedStopped: true`，才能将旧记录改为 `FAILED`。一个 epoch 内幂等处理不能造成第二次 dispatch。能力错误的 failure identity 使用实际失败 attempt；修复或设计错误使用验证/评审证据摘要、work revision 和 failure ordinal。不同失败保持独立；重放同一持久化失败不会重复计数。

<a id="writer-diagnosis-and-crash-safety"></a>
## Writer 诊断与崩溃安全

可写 role 不能直接升级到另一个 writer。Writer 能力失败、达到配置阈值的重复验证/修复失败，或 Reviewer 确认的设计错误，会按持久化 failure identity 创建诊断义务。Runtime 首先确认 executor 已销毁。此时仍持有旧 writer lease，并先持久化包含 failure identity 和 worktree fingerprint 的 `PENDING` 诊断义务。只有持久化成功后，才可释放 lease 并准入只读 Architect 诊断。如果在持久化义务前崩溃，旧 lease 必须保留；如果在义务持久化后、lease 释放前崩溃，lease 和义务都保留，并要求停工恢复。持久化失败时必须保留 lease。销毁状态不确定时，隔离 task，不能创建可执行的诊断。`RoleQuiescenceError` 优先于升级和诊断。

每次运行和恢复都会在准入 writer 前检查诊断义务。诊断使用专用输出格式：摘要、基于证据的观察、`REPAIR_WITHIN_PLAN` 或 `REPLAN` 建议、修复约束和未解决问题。诊断前后都要读取实际 HEAD 和 worktree identity；任何变化都会阻止使用结果并使诊断失效。诊断不能替换冻结的 plan，也不能自行授权 writer。

义务依次经过 `PENDING`、`COMPLETE` 和 `APPLIED`。`COMPLETE` 表示诊断输出已持久化，但仍阻止 writer。变为 `APPLIED` 前，必须将建议持久化到 task 状态和 plan 意图中。冻结设计仅当 `REPAIR_WITHIN_PLAN` 的约束符合当前准确 plan 时才允许该建议；当前 runtime 对两种建议都保守地记录为 `REPLAN`，并要求先冻结新的 plan，才恢复 writer 工作。Runtime 会先把已应用的建议和修复约束保存到 `DIAGNOSIS-APPLICATION.<sha256(failureKey)>.json`，再将义务标为 `APPLIED`。若在应用建议后、标记 `APPLIED` 前发生崩溃，恢复会以幂等且绑定 digest 的方式重复应用，不会重新 dispatch 诊断。只有状态为 `APPLIED` 后才允许准入 writer。

Workflow 中断测试覆盖恢复 `RESERVED` 状态的 Development 或 Review-only 升级、恢复中断的冻结 plan，以及 reviewed unexpected source change 后保留原始 scope。Store 测试分别覆盖 reservation compare-and-swap、`APPLIED` 前重放 diagnosis application、源码指纹检查，以及 diagnosis pending 时阻止 writer 准入。Capability-dispatch 测试验证释放已停止的 writer 前先持久化 diagnosis obligation，并验证持久化失败时保留 lease。补充的 workflow 测试在 pending 义务持久化后、释放 writer lease 前，在诊断完成后、应用前，以及在应用记录持久化后、`APPLIED` 前注入中断。恢复复用已完成的诊断和已消耗的配额；源码修改不确定时仍阻止 writer。
