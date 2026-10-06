---
kind: upgrade-guide
description: 工程 profile 不再组合通用 subagent 工具，Coordinator 获得 goal 工具。
---
# 工程 Coordinator 工具

[English](guide.md) | 中文

## 变更

在此版本之前，已安装的 `engineering` 和 `engineering-run` profile 原样组合 Web bundle 的 standard preset，因此 Coordinator 和每个被派发的角色都会被提供通用 `subagent` 工具，尽管工作流守卫会拒绝其使用。现在 profile 安装一个省略 delegation 组的生成 preset。

Coordinator 工具列表还新增 `get_goal` 和 `update_goal`，而工作流早已列出它们。此前无法读取或更新其 Session goal 的 coordinator 现在两者都能做。

## 迁移

1. 重装用户 profile，让生成的 preset 替换 profile patch：`node tools/agent/install.mjs`。
2. 确认 `$DSH_HOME/profiles/engineering/cordis.patch.yml` 中有一条顶层 `preset-standard` 行，其 `config.plugins` 列表不含 `delegation` 条目。
3. 确认 coordinator Session 列出 `engineering_run`、`engineering_status`、`engineering_recover`、`get_goal` 和 `update_goal`，且没有 `subagent`。
4. 必须让 coordinator 在工作流之外委派的部署无法使用这些 profile；按设计它们仅面向 coordinator。
