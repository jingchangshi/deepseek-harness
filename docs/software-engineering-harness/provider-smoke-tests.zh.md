# Provider Smoke 测试

[English](provider-smoke-tests.md) | 中文

`node tools/agent/agentctl.mjs smoke-models` 在无凭据条件下验证每个启用的逻辑角色。它检查配置解析，并为 provider、model、reasoning effort 路由和已配置角色所需的 smoke 类别输出路由诊断。结果区分 `qualification: role` 和 `qualification: route`，并标明精确的 `routeId`。

## Mock 模式

Mock 模式是确定性的 CI 证据。它在无网络访问时覆盖 provider 与 model 查找、reasoning 路由、completion、工具使用、subagent 调度、后台能力、有界取消和路由诊断。由于没有已配置角色要求 structured output，该项为 `NOT_RUN`。Mock 模式不验收真实端点。

## Real 模式

运行 `node tools/agent/agentctl.mjs smoke-models --real true`，以执行具备 deployment model ID、endpoint、effort mapping 和 credential 的每条 route。每个进程都使用固定的 headless profile 和有界 deadline；`--timeout-ms` 可修改该 deadline。缺少输入时，route 保持 `NOT_RUN` 且不会启动 DSH；已尝试 route 若超时或缺少必需证据，则结果为 `FAIL`。

失败路由摘要会将持久化的 `llm/retry` 和错误 `turn/end` 记录归到所属 Session。摘要仅保留可识别的失败代码和有效 HTTP 状态码，将其他代码映射为 `UNKNOWN`，省略消息和 request ID，并最多包含提取记录中的最后 16 条。

Real 模式从拥有该 role 的持久化 Session 验证每条 route。delegated role 运行于 child Session，因此 child 的 `request/header` 提供 `provider-resolves`、`model-resolves` 与 `reasoning-routed`，而 root Session 提供调度它的固定 role tool；若某 Session header 的 `parentSession` 指向同一次运行中的另一 Session，则该 Session 为 child。tool result 仅与同一 Session 且同一 call id 的 call 配对，因此 parent 的 `read` 或无关 Session 的成功 `read` 都不能验收该 role。由于固定 role tool 禁用 background execution，且没有已配置角色要求 structured output，这两项保持 `NOT_RUN`。缺少部署输入绝不表示生产路由通过资格验证。

角色资格验证使用主路由。路由资格验证覆盖每个不同的配置路由与 effort，包括主路由成功时仍单独验证的 `company-fallback`。Fallback 资格验证只替换候选的模型选项，保留固定角色工具、persona、结果要求和工具策略。在生产中启用路由前，必须取得 provider、model、effort、completion、tool-use 和 child-dispatch 的通过证据。这属于部署负责人的要求；runtime 准入验证配置和策略，不读取已保存的 smoke 回执。

### Check 语义

| Check | Real 模式含义 |
| --- | --- |
| `provider-resolves` | 该 role 自身 Session 请求了已配置 provider。 |
| `model-resolves` | 该 role 自身 Session 请求了已配置 model。 |
| `reasoning-routed` | 该 role 自身 Session 请求了已配置 reasoning effort。这是 routing 已选择该 effort 的 request 侧证据，不是 endpoint 已接受该 effort 的 provider 侧确认。 |
| `completion` | 进程以 0 退出，终端 `final` record 包含精确 marker，且该 role 自身 Session 提交了包含该 marker 的 assistant answer。 |
| `tool-use` | 该 role 自身 Session 记录了成功的 `read` tool result。 |
| `child answer` | 对 delegated role 归入 `completion`：child Session 本身必须已用该 marker 作答，因此 parent 回显 child 从未转化为答案的 read 不能通过。 |
| `subagent` | root Session 记录了对已配置固定 role tool 的成功调用。coordinator 无 role tool，故为 `NOT_RUN`。 |
| `bounded-cancellation` | 该次尝试未超时。 |
| `route-diagnostic` | 该 role 自身 Session 的 route 与已配置 route 完全一致。 |

失败的 route 会报告 `failureClass`，指明首个失败阶段：`PROCESS_EXIT_FAILURE`、`TIMEOUT`、`ROUTE_MISMATCH`、`REASONING_ROUTE_MISMATCH`、`SUBAGENT_NOT_CALLED`、`SUBAGENT_FAILED`、`CHILD_READ_NOT_CALLED`、`CHILD_READ_FAILED` 或 `FINAL_MARKER_MISMATCH`。结果同时携带一份有界且不含敏感信息的摘要，包含 expected marker、final text、已调用与成功的 tool 名称、exit code 和 timeout 状态。

## 所需输入

部署负责人必须提供公司网关 URL 与凭据、精确公司模型 ID 与 effort 拼写，以及 SUB2API URL 与凭据。Architect 和 Reviewer 使用 `DSH_ARCHITECT_MODEL_ID`；持久化 request header 必须记录 `openai`、该变量解析后的 ID 和 `DSH_OPENAI_HIGH_EFFORT`。GLM 主模型解析 `DSH_COMPANY_CHALLENGER_MODEL_ID`；独立验证的 Qwen fallback 解析 `DSH_COMPANY_FALLBACK_MODEL_ID`。Arbiter 被禁用时，其模型 ID 仍为可选。

## Dev Note

无。
