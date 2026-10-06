---
kind: upgrade-guide
description: 工程 Architect 和 Reviewer 路由要求 SUB2API 凭据，而非 Anthropic 中继凭据。
---
# 工程 Sol 路由

[English](guide.md) | 中文

## 变更

工程 Harness 的 Architect 和 Reviewer 通过 OpenAI Responses provider 运行，而非通过 Anthropic 中继使用 Claude。这些已启用角色要求 SUB2API 凭据，不再仅由可选 Arbiter 使用这些凭据。

## 迁移

1. 设置 `DSH_OPENAI_HIGH_EFFORT=high`，并导出 `DSH_ARCHITECT_MODEL_ID`，其值为部署的 Architect/Reviewer 模型 ID。部署模型和有界 fallback 的迁移步骤见规范的[工程模型路由指南](../engineering-model-routes/guide.zh.md)。
2. 为部署端点设置 `DSH_SUB2API_URL` 和 `DSH_SUB2API_KEY`。工程 profile 不再读取 `DSH_ANTHROPIC_RELAY_URL`、`DSH_ANTHROPIC_RELAY_API_KEY` 或 `DSH_ANTHROPIC_HIGH_EFFORT`。
3. 根据仓库模板更新已安装的 Cordis overlay，同时保留项目已有的 `.agent/config` 值；初始化不得覆盖用户部署配置。
4. 运行 `node tools/agent/agentctl.mjs smoke-models --real true`。Architect 和 Reviewer 必须报告 `openai`、从 `DSH_ARCHITECT_MODEL_ID` 解析的值、`high` 和 `PASS`；`NOT_RUN` 不能证明部署可用。
