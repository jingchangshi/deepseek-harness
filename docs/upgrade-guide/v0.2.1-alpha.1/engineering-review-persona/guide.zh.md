---
kind: upgrade-guide
description: "Review-only 现在要求每个只读角色配置单独的 persona 文件。"
---

# Review-only persona 配置

[English](guide.md) | 中文

## 变更

Review-only 现在为每个被调度的只读角色使用 `reviewPersonaFile`。只配置 `personaFile` 的现有 deployment 在 Review-only 任务选择该角色时，会在 provider dispatch 前收到诊断信息。Development 仍使用 `personaFile`。

## 迁移

1. 在 deployment 所有的 `.agent/config/roles.yaml` 中，为 Review-only 可选择的每个只读角色添加 `reviewPersonaFile: .agent/roles/review-only.md`：`architect`、`scout-primary`、`scout-secondary`、`challenger` 和 `reviewer`。保留各角色现有的 `personaFile`。
2. 确保 deployment 根目录下存在 `.agent/roles/review-only.md`。DSH checkout 在相同路径提供共享 persona；如果安装过程没有初始化该文件，请将其复制到 deployment 中。
3. 运行 Review-only 任务。确认任务使用 review persona 完成 dispatch；缺少配置键或文件时，系统会在 provider dispatch 前报告错误。
