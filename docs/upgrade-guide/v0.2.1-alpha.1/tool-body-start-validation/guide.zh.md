---
kind: upgrade-guide
description: 参数不符合 JSON Schema 的原始工具调用现在会在工具主体运行前失败。
---

# 工具主体参数验证

[English](guide.md) | 中文

## 变更

注册表现在会在运行 `execute` 前校验参数。`defineTool` 使用其捕获的参数验证器；未提供 `validateArguments` 的原始定义则由 Ajv Draft 7 根据 `parameters` 校验。此前，未提供自有验证器的原始定义可能会收到不符合 schema 的参数。schema 不匹配现在会返回常规的 `INVALID_ARGS` 工具结果，且不会调用主体。严格 schema 校验会拒绝不支持的关键字、format 和 dialect；无法解析的引用会直接失败，不会远程获取。

## 迁移

1. 检查通过 `ctx.tools.register()` 注册的每个原始 `ToolDefinition`，并确保其 `parameters` schema 使用受支持的 Ajv Draft 7 dialect，且描述了 `execute` 主体实际接受的输入。如二者不一致，请更新 schema 或参数生成方；不会远程获取 `$ref`。
2. 如果定义提供了 `validateArguments`，若希望无效参数返回 `INVALID_ARGS`，请让它抛出 `ToolArgsError`。`defineTool` 会自动捕获并应用其参数验证器。
3. 确认有效调用会进入 `execute`，而带有无效参数的调用会返回 `INVALID_ARGS`，且不会进入主体。
