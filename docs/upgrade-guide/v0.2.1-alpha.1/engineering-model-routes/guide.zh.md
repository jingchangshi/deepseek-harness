---
kind: upgrade-guide
description: 工程模型路由按职责命名，并通过环境变量选择 provider、模型及 reasoning 等级。
---

# 工程模型路由

[English](guide.md) | 中文

## 变更

工程模板通过 Magpie 使用 GPT-6.1-Sol 架构师、DeepSeek 主要 worker 和 MiMo 次要 worker。主要 worker 有一个 Qwen 备用；次要 worker 依次尝试 GLM、Qwen 备用。Writer 仅能在可能修改仓库的工具启动前使用 fallback。Provider 选择和模型 ID 接受带默认值的环境变量。两个 Magpie 别名都要求 `DSH_MAGPIE_GATEWAY_URL`。`magpie` 默认使用 Chat Completions，并通过部署占位符接受 `DSH_MAGPIE_API`。可选的 `company` provider 支持公司网关路由。架构、评审和默认禁用的 Arbiter 默认使用 medium reasoning。

安装保留用户拥有的现有部署文件，不会自动重命名其中的路由声明。

## 迁移

1. 将 `DSH_MAGPIE_GATEWAY_URL` 设置为网关 URL，包含 `/v1`。需要时提供 `MAGPIE_API_KEY`，或将 `DSH_MAGPIE_API_KEY_ENV` 设置为其他凭据变量的名称。
2. 在 `<DSH_HOME>/engineering/.agent/config/models.yaml` 和 `roles.yaml` 中，重命名路由声明及全部角色/fallback 引用：`company-fast` → `worker`、`company-challenger` → `worker-secondary`、`company-fallback` → `worker-fallback`、`worker-fallback-glm` → `worker-secondary-fallback`、`architecture-premium` → `architecture`、`arbiter-premium` → `arbiter`。保留无关部署设置和已有任务尝试日志。
3. 应用[模型模板](../../../../.agent/config/models.yaml)中的环境变量占位符。使用独立的 `DSH_ARCHITECT_MODEL_ID` 和 `DSH_ARBITER_MODEL_ID`。全部 provider/model 前缀及 reasoning 变量见[模型路由](../../../software-engineering-harness/model-routing.zh.md)。要选择公司 Qwen 备用，请添加模板中的 `providers.company` 并设置 `DSH_COMPANY_GATEWAY_URL`、`DSH_COMPANY_GATEWAY_API_KEY`、`DSH_WORKER_FALLBACK_PROVIDER=company` 和 `DSH_WORKER_FALLBACK_MODEL_ID=Qwen3.8-Flash`。所选 provider 必须已有声明；切换模型时应保留其支持的 reasoning 映射和 token 限制。
4. 在部署 `models.yaml` 中设置 `providers.magpie.api: ${DSH_MAGPIE_API:-openai-completions}`。MiMo 应保持 Chat Completions；只有该 provider 上的全部路由均支持所选协议时才使用 `DSH_MAGPIE_API`。在 `scout-secondary` 和 `challenger` 的 fallback 列表中，将 `worker-fallback` 添加到 `worker-secondary-fallback` 之后。应用[角色模板](../../../../.agent/config/roles.yaml)中的角色占位符。需要时将 `DSH_ARCHITECT_REASONING_EFFORT`、`DSH_REVIEWER_REASONING_EFFORT` 或 `DSH_ARBITER_REASONING_EFFORT` 设置为 `high`；否则三者均默认为 `medium`。
5. 重启工程 profile。从固定 checkout 运行 `node tools/agent/agentctl.mjs smoke-models --real true --timeout-ms 240000 --deployment-root <DSH_HOME>/engineering`。检查每条结果的 status；仅进程退出码为零不代表路由通过资格验证。
