# 模型路由

[English](model-routing.md) | 中文

逻辑角色通过 `<DSH_HOME>/engineering/.agent/config` 下用户拥有的 `models.yaml` 和 `roles.yaml` 解析；[模型模板](../../.agent/config/models.yaml)和[角色模板](../../.agent/config/roles.yaml)初始化缺失文件。营销名称仅作为标签。Provider ID、精确模型 ID、effort 线值、token 限制和凭据均属于部署配置。Provider bootstrap、角色派发和数据策略授权共享同一个经过验证的配置快照；编辑部署 route 后应重启工程 profile。

## 固定工具

[Cordis overlay](../../tools/agent/profiles/frozen-engineering.patch.yml) 暴露 `ask_architect`、两个 scout 工具、`run_implementer`、`ask_challenger` 和 `ask_reviewer`。`ask_arbiter` 存在但被禁用。每个活动工具使用 `spawn` 后端、全新子 Agent、`maxDepth: 1` 和角色专用工具过滤器。通用动态 subagent 和 fork 工具被禁用。

已安装的 profile 还会安装一份 Web bundle standard preset 的生成副本，其中 `delegation` 组被移除，因此 Coordinator 和被派发的角色都不会被提供通用 `subagent` 工具。Coordinator 的工作流工具为 `engineering_run`、`engineering_status`、`engineering_recover`、`get_goal` 和 `update_goal`；运行时限制与工作流守卫使其遵守这一集合。[Agent Note](../../.agents/notes/implemented/architecture/2026-10-06-engineering-coordinator-tool-surface.zh.md)记录了为何移除 delegation 行的是组合层、而不是运行时过滤器。

## 验证

`loadHarnessConfig` 拒绝未知 provider、未知路由、不支持的 reasoning 等级、重复工具名、未授权的高成本路由、第二个可写角色、被改变的深度或并发限制，以及默认启用的 arbiter。它还拒绝多于两个 fallback、与主路由相同的 fallback，以及重复 provider/model 组合的候选。每个候选都必须支持角色的 effort 并具备高成本路由授权。共用同一个 provider 和模型的路由必须声明相同的 reasoning 映射；有冲突的映射会在配置验证时失败。`resolveRoleRoute` 返回 smoke 诊断记录的精确路由。

## 自适应调度和能力路由

目标仓库在 `.agent/config/project.yaml` 的 `scheduling` 下配置可选 task 策略。用户 deployment 在 `<DSH_HOME>/engineering/.agent/config/workflow.yaml` 中用顶层字段 `simpleMaxFiles`、`standardMaxFiles`、`maxCapabilityEscalations` 和 `repairEscalationThreshold` 配置限制；默认值分别为 3、12、2 和 2。Task 策略可设置 `class`、显式的 `scopePaths` 与 `acceptanceCriteria`、已知 `risks`、`needsInvestigation` 和 `needsChallenge`。Simple 工作要求规范化的显式文件路径和验收条件；目录与 glob 范围不能授权 simple。

用户 deployment 的 `roles.yaml` 使用 `escalationRoutes` 声明更强的只读路由，并可为每个角色配置最多两个 `escalationFallbackRoutes`。`models.yaml` 中每条 route 可设置非负整数 `capabilityLevel`；省略时为 0。每条升级 route 的能力必须高于主路由和普通 fallback，provider/model 不同，支持角色的 reasoning effort，并通过数据分类及 premium 策略。Escalation fallback 也必须高于普通路由的能力下限并通过路由策略。Runtime 会按失败 attempt 的准确 level 过滤候选路由。`FALLBACK` 仍处理已分类的 provider/输出失败；`ESCALATE` 处理类型化的能力请求或已持久化的 writer 诊断。Task artifact、角色响应和恢复行为见[自适应调度设计](adaptive-scheduling-v2.zh.md)。

## 部署值

两个 Magpie provider 别名都从 `DSH_MAGPIE_GATEWAY_URL` 读取端点；未解析的端点会阻止激活。`magpie` 通过 `${DSH_MAGPIE_API:-openai-completions}` 默认使用 Chat Completions；部署声明含有该占位符时，`DSH_MAGPIE_API` 可选择其他 adapter 协议。`magpie-responses` 默认使用 Responses，可通过 `DSH_MAGPIE_RESPONSES_API` 切换 adapter 协议。`DSH_MAGPIE_API_KEY_ENV` 选择凭据变量名，默认为 `MAGPIE_API_KEY`；其值是变量名，绝非凭据本身。MiMo 使用 Chat Completions，因为实际 Responses 请求拒绝该协议，尽管目录元数据列出了它。

可选的 `company` provider 通过 `DSH_COMPANY_API` 默认使用 Chat Completions，读取 `DSH_COMPANY_GATEWAY_URL`，并引用 `DSH_COMPANY_GATEWAY_API_KEY` 中的密钥值。只有路由选择 `company` 时才要求其端点有值。要使用公司 Qwen worker 备用，请先将[模型模板](../../.agent/config/models.yaml)中的 `company` 声明添加到现有部署，再设置：

```sh
export DSH_COMPANY_GATEWAY_URL=https://company.example/v1
export DSH_COMPANY_GATEWAY_API_KEY='<gateway-key>'
export DSH_WORKER_FALLBACK_MODEL_ID=Qwen3.8-Flash
export DSH_WORKER_FALLBACK_PROVIDER=company
```

路由按职责命名，不依赖 provider 名称。下表中的每个前缀都提供 `_PROVIDER` 和 `_MODEL_ID` 变量。Provider 选择必须指向 `models.yaml` 中的声明；选择新 provider 前应先添加声明。端点、凭据和协议设置属于该声明。切换路由不会改变中继、数据分类或高成本路由授权。

| 路由 | 环境变量前缀 |
|---|---|
| `worker` | `DSH_WORKER` |
| `worker-secondary` | `DSH_SECONDARY_WORKER` |
| `worker-fallback` | `DSH_WORKER_FALLBACK` |
| `worker-secondary-fallback` | `DSH_SECONDARY_WORKER_FALLBACK` |
| `architecture` | `DSH_ARCHITECT` |
| `arbiter` | `DSH_ARBITER` |

`${VAR}` 在激活时要求环境变量有值。`${VAR:-default}` 在变量未设置或为空时使用字面默认值；它不执行 shell 表达式，也不展开嵌套变量。模板保留通过 API 确认的 Magpie 模型作为默认值。Architect 和 Reviewer 共用 `DSH_ARCHITECT_MODEL_ID`；Arbiter 使用独立的 `DSH_ARBITER_MODEL_ID`。修改环境或部署 YAML 后应重启 profile。安装保留用户拥有的现有配置。

Coordinator 和 Architect 通过 `DSH_ARCHITECT_REASONING_EFFORT` 默认使用 medium reasoning。Reviewer 和默认禁用的 Arbiter 分别使用 `DSH_REVIEWER_REASONING_EFFORT` 和 `DSH_ARBITER_REASONING_EFFORT`，默认同样为 medium。复杂的跨模块设计或尚未解决的评审争议可使用 high。这些是运行默认值，不代表已经测得 medium 与 high 质量相同；得出此结论前应比较有代表性的任务。

```sh
export DSH_MAGPIE_GATEWAY_URL=http://129.153.118.58:8080/v1
export DSH_ARCHITECT_MODEL_ID=codex/gpt-6.1-sol
export DSH_ARCHITECT_REASONING_EFFORT=medium
```

DeepSeek 将逻辑 medium effort 映射为支持的 low 线值。MiMo、GLM 和 Qwen 未公布可选 effort 等级；其逻辑 effort 别名映射为 null，派发使用 off 来省略线参数。

## 有界 Worker Fallback

Scout Primary 和 Implementer 使用 DeepSeek，唯一备用为 Qwen（`trae-cn/qwen3.8-flash`）。Scout Secondary 和 Challenger 依次使用 MiMo、GLM（`trae-cn/glm-5.3-flash`），再使用共用的 Qwen 备用。Coordinator、Architect 和 Reviewer 不配置备用。Implementer 仅能在派发任何可能修改仓库的工具之前切换，包括 shell 命令；此类工具一旦启动，任何失败都禁止 fallback。失败子 agent 必须完成清理后才可启动备用模型。

Fallback 属于工程角色调用，不属于 provider adapter 或有界修复循环。合格的类型化失败类为 `PROVIDER_REQUEST_FAILURE`、`ROUTE_EXECUTION_FAILURE`、`MISSING_STRUCTURED_OUTPUT`、`SCHEMA_INVALID`、`MODEL_MALFORMED_OUTPUT`、`ROLE_TIMEOUT_QUIESCENT` 和 `POLICY_REFUSED`。只有受管期限中止子 agent 且清理成功时，`ROLE_TIMEOUT_QUIESCENT` 才合格；清理期间触发期限不能重新分类之前的错误或已完成结果；随后 fallback 获得一个新的有界尝试期限。其他所有失败均默认失败关闭并归为 `NON_FALLBACKABLE`，包括取消、profile/session 关闭、writer 错误、仓库不变量、验证失败、adapter/profile/policy 漂移、数据策略拒绝、工作流预算、全局中止及未达到 quiescence 的清理。每个候选独立通过数据分类、中继和路由授权。端点 `POLICY_REFUSAL` 可以选择合格的备用路由，因为重试同一路由不会成功；路由或数据策略拒绝不能授权 fallback。

Runtime code 映射是精确的。`PROVIDER_REQUEST_FAILURE` 接受 `AUTH`、`MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`RATE_LIMIT`、`QUOTA`、`ACCOUNT_QUOTA`、`INVALID_REQUEST`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`STREAM_CLOSED`、`CONTEXT_WINDOW_EXCEEDED`、`EMPTY_RESPONSE` 和 `PI_AI_ERROR`。`ROUTE_EXECUTION_FAILURE` 接受 `NO_ADAPTER`、`UNKNOWN_MODEL`、`UNSUPPORTED_REASONING_EFFORT`、`INVALID_MODEL_INFO`、`INVALID_MODEL_CONTEXT`、`INVALID_MODEL_MAX_TOKENS`、`INVALID_MODEL_REASONING`、`INVALID_CATALOG` 和 `NO_DISCOVERY`。`MALFORMED_RESPONSE` 映射到 `MODEL_MALFORMED_OUTPUT`，`POLICY_REFUSAL` 映射到 `POLICY_REFUSED`。生命周期、注册、编程、中止、废弃及未知 code 保持 `NON_FALLBACKABLE`。

每次尝试均在 `.agent/tasks/<taskId>/ROUTE_ATTEMPTS.<role>.jsonl` 中保留逻辑角色、序号、路由、provider、解析后的模型、effort、开始和结束时间、结果、失败分类及 fallback 原因。该持久 JSONL 日志位于命令证据链之外，因为路由尝试与确定性的命令证据分开记录。只有一个有效角色结果推进仓库状态。Fallback 不消耗有界实现修复轮次。[Provider smoke 测试](provider-smoke-tests.zh.md)单独验证 fallback 路由；主路由成功不代表 fallback 通过资格验证。

## Dev Note

无。
