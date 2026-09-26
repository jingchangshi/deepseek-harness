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

在显式注入 `executionWorldIdentity`、`fs`、`subprocess` 和 `sandbox` 的插件中，从 `@deepseek-ai/dsh-execution-world/read-lease` 导入 `bindExecutionReadLease`。返回值仅包含 `workspaceId`、`fs`（`stat`、有界 `readText`、`listDir`）和幂等的 `dispose()`。路径由斜杠分隔的根目录相对组件组成，空字符串表示根目录。每次打开后代对象时均拒绝符号链接和重解析点；提供方必须确认 `deny` 别名策略后才能授予访问。缺少安全根读取支持时拒绝请求，不回退到宿主。释放会等待所属读取和根资源清理；该租约不授予子进程访问或 Git 授权。

只有在调用方明确授权对可信仓库执行固定 Git 只读操作时，才从 `@deepseek-ai/dsh-execution-world/git-lease` 导入 `bindExecutionGitLease`。它不公开通用 subprocess：租约校验 consumer 的 Git argv，对所有获授权的 diff 禁用外部差异驱动和文本转换，并在捕获的 subprocess 提供方代际中以只读约束运行，限制收集输出，支持取消，等待进程范围清理完成。该能力不宣称敏感文件过滤或等同于 root-read；Git 配置和仓库元数据属于独立的显式 Git 授权范围。

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
- 内部只读执行绑定要求捕获的提供方代际匹配，并具备由提供方持有的根目录读取能力。文件元数据、有界文本读取和目录列表均不回退到普通路径读取；释放时等待根目录清理完成。其子进程隔离限制文件副作用，不限制读取可见性或网络，也不构成 Git 读取隔离。
- 持久目标身份依赖文件系统提供方在重建后返回相同的规范目标键。
- 共享身份存储的所有进程必须位于同一宿主并使用相同协调路径；不支持跨机器共享存储。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

原生 Windows 和 Linux 测试使用各自的原生内核锁，覆盖真实 JSON 存储、重建的 Cordis 上下文、独立进程重启、并发生产者及持锁进程被终止后的恢复。根目录读取验收已从 WSL/Linux x64 经真实 OpenSSH 连接到独立 Linux arm64 主机并通过，覆盖显式绑定释放、获确认的连接释放，以及强制断线后的清理结果未知。原生 Windows SSH 和完整 C2C 产品闭环尚未验证。

可选的 `tests/read-only-ssh.e2e.ts` 测试通过 `DSH_SSH_TEST_CONFIG` 指定可丢弃的 Linux 工作区和已安装 helper 的摘要。它从 POSIX 客户端经真实 OpenSSH 验证根目录读取；跳过运行既不能证明 SSH 行为，也不能证明原生 Windows 客户端支持。释放时新建的连接仅删除测试数据，不用于确认原始 helper 的清理结果。

</details>
