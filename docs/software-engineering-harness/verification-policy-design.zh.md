# 验证策略设计

[English](verification-policy-design.md) | 中文

本设计规定[工程架构](architecture.zh.md)中的确定性验证要求与产物标识。[验收矩阵](portability-acceptance.zh.md)区分这些要求和已执行的证据。

## 摘要

仓库策略选择验证层级和必需的作用域实例。模型可增加实例，但不能删除确定性要求。仓库拥有的源码封印在验证前将实现后的源码标识附加到冻结的规划意图。验证、审查、恢复和验收使用相同的最终标识。

## 目录

- [策略所有权](#policy-ownership)
- [必需实例](#required-instances)
- [标识输入](#identity-inputs)
- [源码封印](#source-sealing)
- [验收与恢复](#acceptance-and-recovery)
- [兼容性](#compatibility)

<a id="policy-ownership"></a>
## 策略所有权

可选的项目声明选择仓库内的相对路径验证策略文件。策略声明 `schemaVersion`、默认层级、允许的层级、始终必需的实例、层级要求和路径影响规则。层级名称为 `development`、`presubmit` 和 `qualification`；较高层级包含较低层级的要求。显式的用户层级选择可以提高默认层级，但不能降低。审查者输出没有选择层级的权限。

项目键为 `verificationPolicy`。策略版本 1 使用以下声明格式；每个被引用的实例也必须在所选验证 profile 中声明：

```yaml
schemaVersion: 1
defaultTier: development
allowedTiers: [development, presubmit, qualification]
alwaysRequired: []
tiers:
  development: []
  presubmit:
    - { name: semantic-regression, scope: { compilerLayer: analysis } }
  qualification: []
impactRules:
  - paths: ["compiler/**"]
    require:
      - { name: semantic-regression, scope: { compilerLayer: analysis } }
```

策略引用使用[名称与作用域标识](scoped-verification.zh.md)，而不只使用名称。任务派发前，每个引用必须解析到仓库 profile 中的实例。路径模式是仓库内的相对 POSIX glob 模式，绝对路径和路径穿越均被拒绝。后端和编译器层值保持为任意 JSON 作用域数据。Deployment 路由和 persona 不属于策略输入。

<a id="required-instances"></a>
## 必需实例

冻结的必需集合是 profile 必需实例、始终必需实例、所选层级要求、确定性路径影响要求和模型请求的额外实例的并集。模型请求的额外实例必须解析到 profile 实例，并成为必需项，即使 profile 将其标记为可选项。未知引用报错，不会静默跳过检查。

影响路径通过比较持久化的基线源码清单与封印源码清单获得，包括暂存、未暂存、删除和未跟踪的源码文件。HEAD 相对记录的基线移动时被拒绝，不会作为新的比较基准。重命名和删除检查包含旧路径以及存在时的新路径。Architect scope 只是补充信息，不能替代实际观察的路径。基线脏路径保留在保守的变更集合中。实现和每次有界修复后重新计算影响；同一工作修订内的要求可以增加，但不能减少。持久化的必需集合记录每个实例及要求来源，使验收能够重建决策。

硬件可用性不会改变必需性。不可用的可选硬件实例保持 `NOT_RUN`。不可用的层级必需实例不能满足验收。审查不能覆盖 `FAIL`、必需的 `NOT_RUN` 或必需的 `INCOMPLETE`。

<a id="identity-inputs"></a>
## 标识输入

`sourceTreeDigest` 标识 Git HEAD 和源码文件内容，包括脏文件、未跟踪文件和删除。它排除 Git 内部文件以及运行时拥有的任务、锁、Session 和安装产物。仓库验证配置不会被排除在标识之外：它属于独立的策略和 profile 摘要。

`verificationPolicyDigest` 标识验证 profile、命令 adapter、影响规则、所选层级、冻结的模型请求额外实例，以及参与这些声明的每个配置文件。它标识策略程序，而不是变更的源码路径或每轮输出。已解析必需集合的摘要是独立的封印字段：确定性影响可以增加要求，而不改变策略声明。`repositoryProfileDigest` 标识仓库项目声明、声明的知识配置、指令和 skill 目录，以及存在时的初始 preset 身份。摘要项包含逻辑路径、解析后的仓库相对目标、存在时的链接目标元数据和内容摘要，并按逻辑路径排序。路径必须解析到仓库内；符号链接目标变化和声明输入缺失均使标识失效，即使替代目标的内容相同。

任务独立于可编辑的仓库策略，持久化其初始 preset ID、版本和摘要。没有 preset 时使用显式的无 preset 标识，而不是推断编译器。重新应用脚手架不会改变任务记录的 preset 身份。仓库接入和增加后端只要求仓库数据，不改变通用 TypeScript 或 core freeze。

<a id="source-sealing"></a>
## 源码封印

冻结的规划意图由规划字段及其摘要组成，同一工作修订内保持不可变。规划还包含仓库拥有的绑定字段：所选层级、必需实例、策略标识、profile 标识和最终源码封印引用。实现前，该引用显式处于未封印状态，不会声称基线源码就是实现后的源码。

Writer 关闭时先确认 writer 及其后代工作达到 quiescence，然后捕获最终源码摘要，验证策略和 profile 输入未变，重新计算实际路径影响，并在任务状态锁下将所得源码封印附加到规划。只有这些仓库拥有的绑定字段可以改变；冻结的意图摘要必须保持相同。封印记录任务、工作修订、验证轮次、三个标识摘要和已解析必需集合的摘要。源码变化或必需集合增长会创建新的轮次，已验证轮次的封印不会原地修改。封印持久化后才能开始验证。

有界修复使此前的源码封印失效，并要求再次关闭 Writer、执行新的验证轮次。它不允许改变规划意图、降低层级、删除必需实例，或改变策略和 Profile 标识。这些变更要求显式重新规划。`FROZEN_PLAN.<workRevision>.json` 独立保留已验证的原始计划；`ATTEMPT.<workRevision>.<attempt>.json` 保留累积要求和每次源码封存。两者使用计划版本 2 的 Schema。状态修订决定哪些轮次记录已提交；编辑当前计划不能降低其声明轮次或必需集合。命令执行在派发前获取身份。追加证据检查该身份和派发状态修订，不会重新绑定旧结果。

<a id="acceptance-and-recovery"></a>
## 验收与恢复

规划绑定、验证、审查和验收决策必须携带相同的任务、工作修订、验证轮次、最终 `sourceTreeDigest`、`verificationPolicyDigest`、`repositoryProfileDigest` 和已解析必需集合摘要。验收持有任务状态锁时重新加载每个标识输入并重新计算要求。源码或配置变化会在写入任何决策前拒绝验收。审查者批准不能修复标识不匹配。

恢复在复用检查点前验证标识。未封印或中断的 writer 不能提供可复用验证。策略、层级、profile、preset 身份或冻结意图变化要求显式重新规划；实现后的源码变化要求新的封印和验证。缺少对应状态转换的持久化产物写入仍受常规陈旧修订检查约束，不能授权验收。

<a id="compatibility"></a>
## 兼容性

持久化版本使用显式 Schema 版本分派。已提交的前代 Schema 保持不可变且可读；缺少必需标识字段不会提供隐式默认值、降级或验收路径。使用前代产物的任务必须显式重新规划，并使用携带标识的版本验证。安装增加后继 Schema，不改写已有任务或证据字节。

## 开发说明

无。
