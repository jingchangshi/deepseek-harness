---
description: "流式输出退化 guard：在模型输出退化耗尽 token 预算之前停止生成并排队一条有界纠正跟进消息，供选择、配置或排查此插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-degenerate-output-guard

[English](README.md) | 中文

## 概述

本包捕获一种失败模式：模型流式输出坍缩成短周期的重复行，并持续生成直到 token 预算耗尽。guard 观察实时流，在检测点取消退化的生成，保留已流出的全部内容，并在 `abort-and-continue` 下排队一条有界纠正跟进。流监听器只做检测与取消；恢复运行在被中止轮次落定之后。`dsh` 基础组合包以保守的灰度档——`observe`、只观察 `reasoning` 块——发布本包，即记录检测而不触碰对话。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当长时自主生成需要针对重复坍缩的保护时，挂载本插件。无需学习或接线：`dsh` 基础组合包已在运行它，且出厂默认以 `observe` 模式观察 reasoning 流——部署方先从记录的检测中积累信心，再切换干预档位。

### 何时选择它

当 agent 无人值守地产出长 reasoning 或文本流、且重复坍缩会浪费预算或卡死循环时，选择它。当输出很短（窗口不足 `minWindowLines` 行时 guard 从不评判）或合法的重复格式——表格、分隔线、生成的样板——主导尾部窗口时，避免使用它：检测器的去重行比率与精确行周期匹配针对的是急剧坍缩，但部署方随时可以在校准期间退回 `observe`。

### 三个干预档位

`onDetect` 选择窗口判定为退化时发生什么：

- `observe`（默认）——记录一条结构化检测警告；流不受影响地继续。用它校准阈值并度量坍缩签名在你工作负载上的表现。
- `abort-only`——取消生成并让轮次以 aborted 落定；不排队跟进，对话等待下一条人类或驱动器输入。
- `abort-and-continue`——取消，然后排队一条纠正通知，让 agent 在新轮次中从有用上下文继续。

### 配置

```yaml
- name: '@deepseek-ai/dsh-degenerate-output-guard'
  config:
    windowChars: 4000          # trailing window inspected per check
    checkEveryChars: 512       # characters between amortized mid-stream checks
    minWindowLines: 24         # minimum lines before a window is judged
    distinctLineRatio: 0.20    # above this distinct-line ratio the window is healthy
    cyclePeriodMax: 12         # largest line period scanned for a cycle
    cycleMatchRatio: 0.90      # period match fraction required to fire
    onDetect: observe          # observe | abort-only | abort-and-continue
    maxRecoveryAttempts: 1     # corrective followups allowed per recovery chain
    applyTo: reasoning         # reasoning | text | both
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `windowChars` | `4000` | 每次评估审视的尾部字符窗口大小 |
| `checkEveryChars` | `512` | 流中摊销评估之间的字符数；块边界总是评估 |
| `minWindowLines` | `24` | 窗口被评判所需的非空修剪行数 |
| `distinctLineRatio` | `0.20` | 去重行比率高于此值的窗口无论周期如何都视为健康 |
| `cyclePeriodMax` | `12` | 扫描考虑的最大行周期 |
| `cycleMatchRatio` | `0.90` | 检出周期触发所需的匹配行比例 |
| `onDetect` | `observe` | 检测时的干预档位 |
| `maxRecoveryAttempts` | `1` | 每条恢复链——输入为本 guard 自身通知的连续轮次——允许的纠正跟进数 |
| `applyTo` | `reasoning` | 观察哪些流式块类型 |

无效配置会在启动时以清晰错误失败——非整数或越界数值、或 `checkEveryChars` 超过 `windowChars`——绝不会静默改变行为。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-degenerate-output-guard)记录每个受支持的值。

### 你会得到什么

按出厂默认，退化的 reasoning 坍缩会被记录为一条结构化警告，注明块类型、行周期与流位置——不含原始文本。部署方切换到 `abort-and-continue` 后，退化的生成在当前位置停止，轮次以 aborted 落定，新轮次以一条纠正通知开始，告知模型上一代生成已被停止，并要求它从有用上下文继续、执行工具调用或给出结果。恢复链最多允许 `maxRecoveryAttempts` 次连续自动纠正，因此 guard 永远不会让自己陷入重试循环；中间出现的人类消息会更新预算。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节解释 guard 如何检测周期、两阶段"中止并恢复"设计如何工作、以及它如何与 goal 驱动器协作；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计承诺

guard 建立在五项承诺之上：

- **两阶段、单一决策点。** 流监听器只做检测与取消——它先标记 trip 状态再取消，且从不在流中排队恢复工作。恢复运行在 `turn/end` 处理器中，即被中止轮次落定之后，此时追加再次合法。
- **有界内存。** 每个被观察的块只持有其尾部窗口（`windowChars`）、待合并的增量尾部与计数器——与流长度无关——且每次尝试的状态在新流开始时重置。
- **仅结构化遥测。** 检测记录携带块类型、行周期、匹配比例、流位置与标识符；原始流文本绝不进入日志。
- **加载时响亮失败。** 所有配置范围都在 `apply` 中校验并抛出，绝不回退到默认值。
- **按 cause 关联，而非按相邻性。** 取消的 hook cause 内嵌检测 id（`degenerate-output-guard:<agentId>:<turn>/<block>/<charsSeen>`），`turn/end` 恢复只在落定原因与该 cause 精确匹配时消费 trip——被单独取消的轮次绝不会触发恢复。

### 检测：尾部窗口

检测器（位于 `src/detector.ts`）维护最后 `windowChars` 个字符的尾部窗口。每次评估取窗口中非空修剪行，先计算去重行比率：唯一行数除以总行数。高于 `distinctLineRatio` 时窗口健康——变化丰富的行文立即退出，不做周期扫描。否则扫描对从 1 到 `cyclePeriodMax` 的每个周期 `p` 计算"与其前 `p` 行相等的行"的占比；最佳占比达到 `cycleMatchRatio` 即触发，并报告该周期。评估摊销为每累积 `checkEveryChars` 一次，外加块边界上的最终一次评估——只在最后一个不完整区间内才变得可疑的坍缩仍会被捕获。

### 恢复链

恢复将连续被 guard 停止的轮次关联为一条链。当轮次领取的消息不是 guard 自身通知（人类或驱动器轮次中断了链）时，链深度重置；只有 guard 自身通知被领取时深度才递增。当被中止的 trip 落定且 `onDetect` 为 `abort-and-continue` 时，仅在 `depth` 低于 `maxRecoveryAttempts` 时排队纠正通知；预算耗尽的链内再次退化仍会中止，但记录预算耗尽而不排队。待处理通知按消息 id 跟踪：若它在被领取前被丢弃，guard 释放链槽位并记录丢失；若其他生产者的消息同批搭乘，链保持完整。

### Goal 集成

当被中止的轮次属于已武装的 goal 轮次时，guard 在检测时快照 goal 的 id 与 revision。被中止轮次落定后，它重新武装 goal（以快照引用执行 disarm + resume），赶在 goal 驱动器的空闲暂停检查之前，因此 guard 中止的轮次不会暂停 goal 自动化。对已武装 goal，纠正通知通过 `inject` 而非 `followup` 投递：消息停泊为下一步输入且不自带唤醒，由 goal 驱动器的待处理预约提供唤醒，通知搭乘下一轮批次。若检测与恢复之间 goal 状态漂移——不同的 goal、不同的 revision、非活跃阶段——恢复被跳过并记录，而非猜测。

### 投递时机

恢复工作运行在从 `turn/end` 监听器排队的微任务中。该微任务先于 agent 循环的空闲延续恢复运行，一次给出三项保证：追加合法（turn-end 发布已关闭）、goal 恢复赶在驱动器空闲暂停检查之前、排队的通知先于驱动器请求下一次 drive 存在。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、响亮失败的校验、流/轮次/收件箱监听器、恢复链 |
| [`src/detector.ts`](src/detector.ts) | 尾部窗口重复检测器及其调优参数 |
| — | 不发布运行时不变式配套组件；guard 状态是私有的按 agent 记账，且不公开任何可供独立配套组件观察的包自有事件或快照。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

当包级契约不够用时阅读这些页面。它们从 agent 循环的收件箱事件走向详尽的配置与 guard 组地图。

- [核心子系统参考](../../../docs/subsystems/core.zh.md)——本 guard 消费的 agent 循环、收件箱领取/丢弃通知与 hook 取消 cause。
- [Goal 子系统参考](../../../docs/subsystems/goal.zh.md)——恢复协作的 goal 阶段、disarm/resume 引用与轮次驱动器。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-degenerate-output-guard)——每个受支持的配置字段及其源声明。
- [guard 组地图](../README.zh.md)——同组 guard 包与循环卫生家族。

-----

<a id="model-experience"></a>
## 模型体验

### observe 与 abort-only 档位

#### 模型看到什么

什么都不看到。不添加工具 schema、消息或提示词文本；检测警告只进入部署日志。

#### Token 影响

零 token。guard 不持有任何模型可见状态。

#### KV Cache 影响

无：这些档位不添加任何模型可见内容，因此没有可缓存的对象。

### 纠正通知（abort-and-continue）

#### 模型看到什么

被中止的退化轮次之后，下一轮次的输入携带下面的通知，其中 `<period>` 是检出的行周期、`<lines>` 是最终窗口中的重复行数。通知是一条归属于插件的 `user/message`，模型像阅读任何其他消息一样阅读它。文本逐字固定：

##### 纠正通知

```markdown
The previous generation entered a short repetition cycle (period <period>, ~<lines> repeated lines in the final window) and was stopped before it exhausted the output budget.
Do not restate the plan or continue the stopped reasoning. Continue from the useful context and either:
1. execute the required tool/action, or
2. provide the requested result.
```

#### Token 影响

通知是该 agent 的保留历史；其文本固定，因此每条通知增加的 token 恒定，且受每条恢复链的 `maxRecoveryAttempts` 约束。

#### KV Cache 影响

只追加；新可见内容跟随可复用的请求前缀，不会使既有 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了 guard 何时是糟糕的选择。它们是当前的包约束，不是任务清单。

- **仅精确行检测**——周期扫描比较完整的修剪行，行文轻微漂移的周期（计数器、时间戳）保持在 `cycleMatchRatio` 之下；在出现需求证据之前拒绝模糊匹配。
- **仅内存状态**——从持久化恢复的会话以空链状态开始；guard 是运行时守卫，不是被记录的不变式。
- **尾部窗口是唯一证据**——坍缩起点完全落在尾部窗口之前的坍缩，在周期主导窗口之前不可见。
- **恢复复用同一模型**——纠正轮次可能再次退化；预算约束重试次数但不改善重试质量。
- **`text` 块未经校准**——`applyTo: 'text'` 以针对 reasoning 调优的同一组阈值观察回答流；在出货 profile 启用前需按部署校准。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与方向。它明确不具权威性——已发布行为、限制与已接受的理据位于上文的章节、包代码与链接的 Agent Note 中。

[degenerate-output-guard 功能笔记](../../../.agents/notes/implemented/feature/2026-09-19-degenerate-output-guard.zh.md)记录两阶段中止、跨轮次预算、goal 重新武装顺序与灰度计划背后的设计决策。

</details>
