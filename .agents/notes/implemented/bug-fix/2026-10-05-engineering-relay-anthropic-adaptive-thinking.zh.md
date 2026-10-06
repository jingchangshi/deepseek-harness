# Agent Note: 工程 harness 中继的 Anthropic adaptive thinking

Status: implemented

[English](2026-10-05-engineering-relay-anthropic-adaptive-thinking.md) | 中文

## Problem

被调查的 Anthropic Messages 中继拒绝 Claude Opus 的预算型 thinking，并要求 adaptive thinking。pi-ai 通过模型元数据支持 adaptive thinking，但部署方自定义的 provider profile 必须显式携带兼容开关。

## Decision

harness 把 pi-ai 的[线格式兼容开关](../../../../packages/llm/llm-pi-ai/src/catalog.ts)作为经过校验的配置携带，供部署方自定义 provider 使用。默认 Architect 和 Reviewer 使用 [GPT-6.1 Sol high](../../../../docs/software-engineering-harness/model-routing.zh.md)；Anthropic 兼容设置仅适用于显式配置 Anthropic 路由的部署。

[ProviderConfig](../../../../tools/agent/src/config.ts) 暴露名为 `compat` 的可选布尔字典。配置加载拒绝非布尔值。[providerOptions](../../../../tools/agent/runtime/bootstrap.ts) 把该字典投射到 pi-ai provider profile 上。

Anthropic 部署必须使用目录 provider ID `anthropic`，使 pi-ai 校验兼容字段名。自造 ID 会跳过该校验。被调查的中继接受 `claude-opus-5.5`，但拒绝目录拼写 `claude-opus-5-5`；部署负责人必须使用其端点的精确模型 ID。

## Alternatives considered

**自造 provider ID。** 否决：兼容字段名缺乏目录校验，拼写错误可能静默禁用所需行为。

**使用目录模型 ID 继承模型元数据。** 否决：中继以 `model_not_found` 拒绝该拼写。

**省略 thinking。** 否决：配置 high reasoning effort 的角色要求推理保持启用。

**给 pi-ai 打补丁。** 否决：上游已实现 `compat.forceAdaptiveThinking`；harness 只需要投射配置。

## Consequences

显式配置 `compat.forceAdaptiveThinking: true` 的 Anthropic provider 发送 `thinking.type=adaptive` 与 `output_config.effort`。该开关对 provider 上每个模型生效；要求其他 thinking 模式的模型需要独立 provider 配置。部署负责人必须在 Cordis overlay 中同步兼容设置。

pi-ai 在 profile 解析时校验兼容字段名，YAML 加载则校验其布尔值。

## Testing

[运行时测试](../../../../tools/agent/tests/runtime.spec.ts) 检查显式配置的 Anthropic provider 的兼容设置投射。[配置测试](../../../../tools/agent/tests/config.spec.ts) 单独检查默认 Sol 路由。
