# 冻结版多模型软件工程 Harness 架构

[English](architecture.md) | 中文

本文描述维护在 DeepSeek Harness `dsh-v0.2.1-alpha.1` 基线分支上的软件工程 Harness。实现位于 DSH core 之外，工程状态保存在目标 Git 仓库。DSH 分支维护 runtime 和项目模板，并遵循[固定的 DSH 运行时](dsh-pinned-runtime.zh.md)中的 freeze 规则。

## 摘要

命名的 `engineering` 和 `engineering-run` profile 从固定 DSH checkout 加载工程 runtime。用户在目标仓库启动 DSH，并输入一条自然语言需求。Runtime 调度固定 route 的 subagent，repository state engine 负责任务 artifact、状态转换、确定性验证、修复次数限制和 acceptance。任何模型输出都不能直接把任务标记为已接受。

## 目录

- [固定基线](#pinned-basis)
- [职责划分](#responsibility-split)
- [DSH 调查结论](#dsh-findings)
- [系统结构](#system-structure)
- [角色路由](#role-routing)
- [任务协议](#task-protocol)
- [执行策略](#execution-policy)
- [验证与接受](#verification-and-acceptance)
- [数据策略](#data-policy)
- [失败与恢复](#failure-and-recovery)
- [实现阶段](#implementation-stages)

-----

<a id="pinned-basis"></a>
## 固定基线

运行时基线是 tag `dsh-v0.2.1-alpha.1`。Freeze manifest 要求 tag 和 commit reference 解析到同一 commit，验证该基线是 harness 分支的祖先，并检查工具链和清单中的文件哈希。Harness commit 可以位于版本 tag 之后，`HEAD` 不必等于该 tag。准确版本和哈希统一由清单维护。

DSH 始终是已安装的 orchestration runtime。项目仅新增 profile overlay、repository 配置、确定性 CLI 代码、schema 和文档，不修改 `packages/core/agent-loop`、任何 DSH service contract 或已发布的 Session 数据。

<a id="responsibility-split"></a>
## 职责划分

| 负责人 | 职责 | 不作为以下内容的权威来源 |
|---|---|---|
| DSH | LLM adapter、profile composition、subagent、workflow、job、goal、tool execution、Session log | 工程任务状态或最终 acceptance |
| 项目 orchestration | 角色路由、阶段选择、有界修复策略、单 writer 准入 | 测试正确性或 model-provider 行为 |
| 模型 | 调查、架构提案、实现、challenge、review | 状态转换、确定性结果、acceptance |
| 确定性 harness | 命令、退出状态、结构化结果采集、scope matrix、timeout | 选择产品意图 |
| Git repository | 任务 artifact、revision、evidence、decision、配置、freeze manifest | DSH 进程内实时状态 |

repository state machine 是工程进度的唯一权威来源。DSH Session history 仍可作为诊断和对话证据，但不能替代 repository artifact。

<a id="dsh-findings"></a>
## DSH 调查结论

当所选 subagent backend 声明对应 capability 时，固定版本源码支持角色专用 child `agentOptions`、persona、tool filtering 和最大深度。工程 runtime 直接调用该 service；Coordinator 获得工程 workflow 工具，而不是可以独立调用的角色工具。

进程内 `spawn` backend 创建不继承 parent conversation 的 fresh child，并支持 route option、persona、tool filtering、structured output 和数值深度限制。它是固定角色的默认 backend。配置 `maxDepth: 1` 后仅允许 direct child。`dsh-subagent` service 还可限制常驻 continuable child 数量，但该限制不覆盖 one-shot 或 external-provider run。

DSH SDK backend 创建完整的 child Harness 进程，只支持 route option，并会拒绝 persona、tool filtering、structured output 和数值深度限制。使用该 backend 的角色必须在 child profile 中表达工具和递归策略，并使用 `maxDepth: provider-managed`；初始实现不会把它用于普通角色。

workflow engine 仅支持 foreground，且没有 journal 或 restart resume。它可以执行 `maxConcurrentAgents`、`maxTotalAgents` 和每次调用的 item limit，因此项目配置 `maxConcurrentAgents: 3`，并只在真正 fan-out 时使用 workflow。未经 `agentctl` 验证，workflow 输出不会成为 repository task state。

Ralph 针对一个 immutable objective 运行有界 fresh child 序列，轮次之间只传递 structured handoff。其 completion 是 worker self-report，没有独立 evaluator，并且在发布配置中默认禁用。项目只通过显式 overlay 启用 Ralph，且绝不把其 terminal status 当作 acceptance。

DSH Goal 在 Session log 中持久化一个 same-session objective，但 continuation authority 是 process-local。它适合恢复 coordinator 对话，不适合作为 repository workflow state。Local job 也是 process-local，随 Harness 进程退出而消失；其每 owner 并发限制不能提供 durable work scheduling。

`llm-pi-ai` adapter 可声明已安装 provider、OpenAI-compatible gateway 和手工定义 route。每个 exact model 都可声明自己的 reasoning-effort key 和 wire value。因此 provider ID、model ID 和 effort mapping 均为配置数据。Credential reference 通过 DSH credential service 解析，secret 不进入已提交配置。

以下固定版本 package contract 支撑这些决定：

| Primitive | Source-backed constraint |
|---|---|
| [Agent loop](../../packages/core/agent-loop/README.zh.md) | DSH 负责 request execution 与 durable model-visible history；project state 保留在其外部。 |
| [Subagent tool](../../packages/subagent/tool-subagent/README.zh.md) | 实例具有不同名称和固定 child route/policy setting。 |
| [In-process spawn](../../packages/subagent/subagent-spawn-in-process/README.zh.md) | Fresh child 支持 route、persona、tool、structured-output 与 depth policy。 |
| [DSH SDK backend](../../packages/subagent/subagent-dsh-sdk/README.zh.md) | Child process 支持 route option，但拒绝其他 start-time policy。 |
| [Workflow engine](../../packages/workflow/workflow-ptc/README.zh.md) | Concurrency 有界，但 run 仅支持 foreground 且不 journal。 |
| [Ralph tool](../../packages/workflow/tool-ralph/README.zh.md) | Round 是 fresh 且有界的；completion 仍由 worker report。 |
| [Goal service](../../packages/goal/goal/README.zh.md) | Goal state 属于 Session，continuation authority 是 process-local。 |
| [Local jobs](../../packages/jobs/jobs-local/README.zh.md) | Background record 与 concurrency limit 是 process-local。 |
| [Multi-provider adapter](../../packages/llm/llm-pi-ai/README.zh.md) | Custom gateway 与 model-specific effort mapping 来自配置。 |

<a id="system-structure"></a>
## 系统结构

DSH 分支持有可复用 runtime、通用 `.agent/` 模板和数据定义的[仓库 preset](repository-presets.zh.md)。初始化分离仓库策略和用户 deployment 配置，并保留现有任务状态：

```text
.agent/
  config/          project policy and user-deployment seed templates
  profiles/        repository-defined verification profiles
  roles/           user-deployment persona seed templates
  schemas/         JSON Schemas for committed artifacts
  tasks/<task-id>/ repository task records
  preset.json      initial scaffold identity when explicitly selected
tools/agent/
  runtime/         profile bootstrap and role dispatch
  src/             automatic driver and deterministic state engine
  tests/           unit and real-composition coverage
  profiles/        DSH Cordis overlays
  presets/         independently versioned repository scaffolds
docs/software-engineering-harness/
  ...              architecture, operations, profiles, routing, and security
```

[安装器](operations.zh.md)安装用户 profile 和 launcher，并可选地初始化仓库。文件哈希记录管理 profile 和 artifact schema；冲突的 managed 编辑会被拒绝。仓库策略是仅补缺失文件的脚手架，不归安装器所有。Deployment 路由和 persona 绝不进入仓库初始化。任务 artifact 始终由项目持有，不属于模板安装目标。

安装的 profile 启动已配置 provider，固定 Coordinator route，并注册 `engineering_run`、`engineering_status` 和 `engineering_recover`。Automatic driver 读取 Session working directory，运行角色序列，调用已配置命令，并通过 state engine 提交。`agentctl` 暴露相同 repository protocol，用于诊断和维护，不属于日常路径。

<a id="role-routing"></a>
## 角色路由

逻辑角色名保持稳定，provider 和 model identifier 属于部署配置。`<DSH_HOME>/engineering/.agent` 下的用户部署配置拥有模型 route、角色映射、全局数据策略、workflow 准入限制和 persona。Session cwd 只选择仓库项目声明、verification profile、adapter 和任务状态。Bootstrap 和角色 dispatch 使用同一份用户部署配置，不依赖仓库模型声明。

仓库领域知识来自声明的[指令文件和 skill root](repository-presets.zh.md#repository-knowledge)，而不是新增逻辑角色或修改 deployment persona。隔离角色获得已记录的元数据目录，并按需读取相关文件。[TileLang preset](tilelang-integration.zh.md) 使用仓库已有文档和 skill。

即使 UI 请求其他模型，bootstrap 也把 Coordinator 固定到部署 route。Architect、Scout、Implementer、Challenger 和 Reviewer 都作为 fresh `spawn` child 运行，并使用角色专用 model option、persona、result schema 和 tool。默认 workflow 不调度已禁用的 arbiter。Reviewer 不能继承 Implementer conversation。

只有两个 Scout 并行运行，其他角色在 step 和 role-call budget 下依次运行。每个任务最多存在一个 active writer lease。Read-only role 不获得 write tool；Implementer 的 write executor 拒绝 `.agent`、`.git`、root 外路径和 symlink alias。Implementer 还可持有平台 shell tool，其起始 working directory 受同一规则约束；命令内容本身由 deployment sandbox 负责。Required project command 始终由 deterministic driver 持有。

[模型路由](model-routing.zh.md)定义只读 secondary Scout 和 Challenger 在失败子 agent 静止后的单一配置 fallback。候选尝试共享一次逻辑角色调用和仓库 revision；Implementer 不得通过 fallback 切换模型。Architect 和 Reviewer 解析部署的 `DSH_ARCHITECT_MODEL_ID`。

<a id="task-protocol"></a>
## 任务协议

每个 task directory 包含 immutable task identity 和 revisioned state。状态转换是 pure、explicit 的，并依据最新 revision 验证：

```text
NEW -> BASELINED -> INVESTIGATED -> PLAN_FROZEN -> IMPLEMENTING
IMPLEMENTING -> VERIFYING -> VERIFIED -> REVIEWING -> REVIEWED -> ACCEPTED
BASELINED | INVESTIGATED | PLAN_FROZEN | IMPLEMENTING -> REPLAN
VERIFYING | VERIFIED | REVIEWING | REVIEWED | BLOCKED -> REPLAN
any nonterminal state -> BLOCKED
REPLAN -> INVESTIGATED
```

只有 frozen plan 的 bounded-fix count 小于二时，失败验证才能回到 `IMPLEMENTING`。reviewer 的 `FIX_BOUNDED` 决定会增加该计数。第二次 bounded repair 失败后必须进入 `REPLAN`。`ACCEPTED` 没有 outgoing transition，重复 acceptance 是错误。

每次写入都对 `revision` 执行 compare-and-set。Artifact 先写入 sibling temporary file，再 atomic rename，并且最后更新 `STATE.json`。进程中断可能留下无引用 temporary file，但不能发布部分 authoritative revision。

[任务协议](task-protocol.zh.md)定义仓库级 active-run 准入、持久化 Session/tool-call 重放回执，以及显式 `nextAction` 响应。重放调用不能创建另一条工作流；重复调用 `BLOCKED` 任务不能重新派发角色。

<a id="execution-policy"></a>
## 执行策略

Automatic sequence 捕获 Git baseline，并行运行两个 Scout，请 Architect 制定计划，要求 Challenger 批准，准入一个 Implementer，运行选定 verification profile，再请求 fresh Reviewer。每个角色返回经过对应 stage schema 验证的 JSON。DSH 可以继续 Coordinator Session，而 `engineering_status` 仅从 repository artifact 重建工程进度。

项目命令以 executable 与 argument array 表示，并具有显式 working directory、environment allowlist、timeout、expected output 和 verification category。runner 不调用 Bash、PowerShell、`cmd.exe` 或 command string。compiler adapter 可声明 Linux-only command；state engine 与 webapp adapter 在 Linux 和 Windows 上保持可移植。

<a id="verification-and-acceptance"></a>
## 验证与接受

[作用域验证](scoped-verification.zh.md)定义检查名称与作用域标识、实例独立执行、已解析命令证据、必需实例匹配以及显式验证产物版本。

[验证策略设计](verification-policy-design.zh.md)规定确定性路径影响、单调的验收层级、不可变规划意图、仓库拥有的源码封印，以及独立的策略和仓库 profile 标识。

[命令运行器](command-runners.zh.md)定义执行提供者、显式环境、类型化参数展开和停机报告。仓库声明选择运行器；工作流不检查可执行文件名，直接阻断停机不确定的任务。

验证结果只使用 `PASS`、`FAIL`、`NOT_RUN` 或 `INCOMPLETE`。每个结果记录 command identity、开始和结束时间、退出信息、有界 output reference、tested scope 与 task revision。verification profile 声明 acceptance 所需 check。只有 required check 的 `PASS` 满足 profile；`NOT_RUN` 和 `INCOMPLETE` 永不满足。

compiler result 保留 target 与 mode matrix，以及 correctness 和 performance category。webapp result 保留 typecheck、lint、unit、API、migration、integration、E2E、build 与 deployment-smoke category。profile 可在执行前把 category 标记为不适用，但模型不能重新解释缺失的 required result。

Acceptance 要求同一 task revision 同时具备：frozen plan、required check 全部通过的完整 verification artifact、`ACCEPT` review、没有 acceptance-blocking unresolved assumption、没有 active writer lease，以及 artifact/schema validation 成功。`agentctl accept` 评估这些事实并写入 decision；reviewer prose 没有直接 transition authority。

<a id="data-policy"></a>
## 数据策略

每个任务分类为 `public`、`internal` 或 `sensitive`。每条 route 声明可接收的最高数据类别以及是否为 external relay。模型 dispatch 前，orchestration 计算 task class 和 route allowance。sensitive task 只能使用 synthetic、anonymized 或 explicitly approved input；approval 是 repository artifact，包含 data source、route、approver 和 expiry。

该策略覆盖 prompt 和 attached evidence。它不声称能把 provider credential 与同一 OS user 的 tool process 隔离；DSH local credential store 明确提供的是谨慎保管而非 OS security boundary。Secret 保留在 credential reference 或 environment injection 中；deployment review 按 `data-policy.yaml` 命名的 forbidden category 扫描 committed artifact。

<a id="failure-and-recovery"></a>
## 失败与恢复

中断的模型工作不会推进 repository state。`AUTO.json` 记录 budget、pending task identity，以及经过验证的 Git HEAD 和 worktree fingerprint。除非任务已显式进入 `REPLAN`，否则恢复会拒绝变更后的需求；HEAD 或项目文件变化后绝不复用 verification。中断的 writer 必须先释放，另一个 Implementer 才能运行。

取消本地命令会终止完整 POSIX process group，并等待 close。Docker 取消或超时会使任务进入 `BLOCKED`：停止 client 不能确认已有容器内的工作已停止。Operator 确认旧 agent 和容器工作均已结束后，`engineering_recover` 在 run lock 下释放 writer、把任务移到 `REPLAN`，并清除上一轮的有界计数器和 verification checkpoint。任务保留原需求。

损坏或缺失的 authoritative artifact 会 fail closed。stale writer 无法发布，因为 revision comparison 紧邻 atomic state update 执行。失败的 deterministic check 不能被 review 或 arbitration 覆盖。Provider-route failure 保留为 model-routing evidence，不会变成 verification success。

<a id="implementation-stages"></a>
## 实现阶段

Stage A 冻结本文架构和 [acceptance plan](acceptance-plan.zh.md)。Stage B 新增 schema、state engine、CLI 和 focused test。Stage C 新增 pinned DSH overlay 与固定角色工具。Stage D 新增 route validation 和 mock/real smoke command。Stage E 在不修改 DSH core 的前提下连接 orchestration。Stage F 新增 compiler 与 webapp profile 及 fake end-to-end example。Stage G 新增 recovery 与 negative coverage。Stage H 新增 bounded AscendNPU-IR adapter design，并封装已有 command。Stage I 记录 freeze manifest、完成 operations 文档并运行最终 acceptance matrix。

## 延伸阅读

- [DSH 架构](../architecture.zh.md)
- [Subagent 子系统](../subsystems/subagent.zh.md)
- [Workflow 子系统](../subsystems/workflow.zh.md)
- [Goal 子系统](../subsystems/goal.zh.md)
- [Jobs 子系统](../subsystems/jobs.zh.md)
- [Provider 配置指南](../user/guide/providers.zh.md)

## 开发备注

无。
