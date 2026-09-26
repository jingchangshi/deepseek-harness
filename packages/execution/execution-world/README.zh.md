---
description: "在执行提供方和进程重建后保留不透明的工作区身份。"
kind: "package-reference"
---

# @deepseek-ai/dsh-execution-world

[English](README.md) | 中文

## 概述

将执行世界中已存在的目录解析为持久、不透明的工作区 ID。文件系统提供方负责规范化路径，远程路径不经过宿主文件系统 API。身份记录保留在宿主存储中，不含原始工作区路径。身份本身不授予执行能力。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>

## 使用本包

与 `storageDomain` 和执行文件系统一起挂载此服务。`ctx.executionWorldIdentity.resolve(root, signal)` 验证提供方解析的根目录确为目录后，返回已持久化的 ID。路径不存在或指向普通文件时拒绝请求。并发解析别名共享一次身份分配。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | 必填 | `persisted-local` 仅分配一次本地世界 UUID；`deployment` 要求运维方提供 UUID |
| `deploymentId` | 省略 | 部署模式必填的 UUID；本地模式禁止指定 |
| `allocationLockPath` | 必填 | 使用同一身份存储的进程共享的宿主绝对协调路径 |
| `lockWaitMs` | `30000` | 等待分配所有权的最长时间；超时失败，不抢占持有者 |

远程部署必须选择部署模式。同一远程世界的别名使用相同部署 UUID，不同世界使用不同 UUID。存储丢失会丢失身份映射。提供方卸载时取消解析，并在排队写入完成后关闭域。

<a id="understand-the-implementation"></a>

## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

`execution_world_identity` 域保存本地世界 UUID 和随机工作区 UUID 表。表键由世界身份、不透明文件系统目标键组成的版本化元组计算摘要。原始路径和目标键不持久化。服务串行分配身份，仅在存储确认后发布 ID；确认后的取消不会撤销记录。

每次分配先获取同一宿主上的内核锁，再重新打开域，并在释放所有权前关闭域。POSIX 使用保留的锁文件 inode；Windows 使用独占字节范围文件锁，持锁期间禁止删除文件。进程死亡会释放所有权。锁仅协调身份事务，不限制整个 DSH 进程。本包不发布不变量伴随模块，因为根身份没有独立缓存：每次查找直接读取权威域表。

</details>

<a id="further-exploration"></a>

## 延伸阅读

- [文件系统](../../fs/fs/README.zh.md) — 提供方拥有的目标解析。
- [存储域](../../storage/storage-domain/README.zh.md) — 经过校验的持久记录。
- [SSH](../../ssh/ssh/README.zh.md) — 远程文件系统与进程归属。

<a id="model-experience"></a>

## 模型体验

无，因为此服务仅分配身份，不注册模型工具或提示词内容。

#### KV 缓存影响

不直接改变模型请求；消费方负责其公开的身份字段。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 运维方必须确保部署 UUID 唯一且稳定；此服务不通过 UUID 认证主机。
- 此身份服务尚未实现只读文件系统与子进程绑定。
- 持久目标身份依赖文件系统提供方在重建后返回相同的规范目标键。
- 共享身份存储的所有进程必须位于同一宿主并使用相同协调路径；不支持跨机器共享存储。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

原生 Windows 和 Linux 测试使用各自的原生内核锁，覆盖真实 JSON 存储、重建的 Cordis 上下文、独立进程重启、并发生产者及持锁进程被终止后的恢复。远程 SSH 和完整 C2C 验收尚未验证。

</details>
