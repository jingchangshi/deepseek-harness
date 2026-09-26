---
description: "持久执行目录身份、提供方负责的规范化与分配生命周期。"
---

# 执行世界

[English](execution-world.md) | 中文

## 概述

执行世界是已挂载提供方使用的文件系统与进程命名空间。[执行世界身份](../../packages/execution/execution-world/README.zh.md)为该文件系统解析的已有目录分配持久、不透明的 ID。当前仅负责身份，不提供文件系统或子进程访问。消费方不得将 ID 当作权限，也不得据此认定独立挂载的提供方共享同一命名空间。

## 目录

- [身份](#identity)
- [提供方归属](#provider-affinity)
- [规范根目录](#canonical-roots)
- [持久化与生命周期](#durability-and-lifecycle)
- [部署选择](#deployment-selection)
- [Cordis API](#cordis-surface)

<a id="identity"></a>

## 身份

```ts type-equiv
/** Persisted opaque identity; it grants no access to a filesystem or process. */
type ExecutionWorkspaceId = Branded<'ExecutionWorkspaceId'>
```

服务持久保存随机工作区 UUID，以所选世界 UUID 和文件系统规范目标键的摘要建立索引。当存储、世界选择和目标身份保持稳定时，已有映射在进程和提供方重建后保持不变。不同世界即使目录文本相同也使用独立映射。ID 不编码宿主名、用户名或路径。

`ExecutionWorkspaceId` 与 GUI 的 [`WorkspaceId`](workspace.zh.md) 不同。GUI 工作区拥有标题与会话成员关系；执行身份不拥有这些信息。两种 ID 类型之间不存在转换。

<a id="provider-affinity"></a>

## 提供方归属

文件系统、子进程和沙箱提供方公开 `executionWorldAffinity`，这是按引用比较的不透明令牌。普通宿主提供方共享进程本地令牌；SSH 提供方转发其确切连接代际拥有的令牌。不同连接所有者分配不同令牌，即使部署 UUID 或路径文本相同。[执行世界归属](../../packages/execution/execution-world-affinity/README.zh.md)拥有令牌 API。

归属表达可信提供方的所有权，不表示远程认证或授权。它不被持久化，也不从 `ExecutionWorkspaceId` 派生。相同令牌标识同一执行命名空间；Cordis 依赖代际另行确定消费者捕获了哪些活跃实例。令牌本身既不强制根目录包含关系，也不绑定消费者能力。

<a id="canonical-roots"></a>

## 规范根目录

`ctx.fs.resolve` 和 `ctx.fs.stat` 确定目标，并要求它是已有目录。提供方将别名解析为相同目标键时，它们共享同一 ID。缺失路径与普通文件会被拒绝。消费方不得解析不透明目标键，也不得将宿主路径规范化应用于执行根目录。

<a id="durability-and-lifecycle"></a>

## 持久化与生命周期

`execution_world_identity` 存储域仅保留世界 UUID、工作区 UUID 和哈希查找键。分配操作先持有同宿主内核锁，再重新打开域，关闭域后释放所有权。Windows 使用独占字节范围文件锁；POSIX 对持久 inode 使用 `flock`。进程终止会释放内核所有权。共享存储的所有进程必须使用相同的宿主协调路径；不支持跨机器共享存储。

卸载会取消未完成的解析并等待它们结束。启动期间失去必需提供方会取消该次激活；替换提供方后可以重新激活。真实初始化错误会向外传播。调用方在持久化确认后取消，不会删除已提交映射。配置的锁截止时间限制竞争等待，而不会替换活跃持锁者。

<a id="deployment-selection"></a>

## 部署选择

`persisted-local` 在存储中分配一个本地世界 UUID。`deployment` 要求显式、稳定的 UUID：同一远程世界的别名必须使用相同值，不同世界则不得共用。服务不会根据此 UUID 认证宿主。丢失存储会丢失工作区映射。

[base 组合包](../../packages/bundle/base/README.zh.md)选择本地模式，协调路径位于 `DSH_HOME/locks` 下。远程组合以部署模式、部署 UUID 和宿主协调路径替换整个身份配置。此配置不会建立 SSH 连接，也不会将文件系统与子进程提供方绑定在一起。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxexecutionworldidentity--executionworldidentity"></a>

### `ctx.executionWorldIdentity` — `ExecutionWorldIdentity`

Owns durable identity allocation, not execution handles or remote transport.

```ts cordis-catalog
/**
 * Resolve an existing directory through the current filesystem and durably allocate its identity.
 * Concurrent aliases share one allocation. Disposal rejects outstanding resolutions; an allocation
 * already committed before cancellation remains available on the next call or restart.
 * @param root - directory in the mounted filesystem's execution world.
 * @param signal - caller cancellation, combined with this provider's lifetime.
 * @returns the same opaque ID after recreation with the same storage and world configuration.
 */
resolve(root: string, signal?: AbortSignal): Promise<ExecutionWorkspaceId>
```

Source: [`packages/execution/execution-world/src/index.ts`](../../packages/execution/execution-world/src/index.ts)
<!-- END GENERATED cordis-surface -->
