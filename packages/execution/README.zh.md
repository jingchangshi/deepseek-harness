---
description: "execution 包组：持久目录身份与活跃提供方的命名空间归属。"
kind: "package-group"
---

# execution/ — 执行世界身份

[English](README.md) | 中文

## 概述

使用本系列可在进程或提供方重启后识别同一执行目录，并检查活跃提供方是否共享执行命名空间。已挂载的文件系统在自己的命名空间中解析别名，包括远程路径。持久身份与临时归属令牌不包含宿主、用户或目录名称。它们不替代 GUI 工作区记录，也不授予执行访问权限。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>

## 包

| 包 | 职责 |
|---|---|
| [`execution-world`](execution-world/README.zh.md) | 持久保存不透明的执行世界与规范根目录身份 |
| [`execution-world-affinity`](execution-world-affinity/README.zh.md) | 以共享运行时令牌标识活跃提供方的执行命名空间 |

<a id="related-documentation"></a>

## 相关文档

- [执行世界子系统](../../docs/subsystems/execution-world.zh.md) — 身份与生命周期语义。
- [文件系统子系统](../../docs/subsystems/filesystem.zh.md) — 提供方负责的路径解析。
- [子进程子系统](../../docs/subsystems/subprocess.zh.md) — 在已挂载命名空间中执行进程。
- [SSH 子系统](../../docs/subsystems/ssh.zh.md) — 远程执行提供方。
- [工作区子系统](../../docs/subsystems/workspace.zh.md) — 独立的 GUI 实体与会话成员关系。

<a id="dev-note"></a>

## 开发备注

无。
