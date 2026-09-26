---
description: "比较活跃提供方的命名空间归属，不将持久工作区 ID 当作执行权限。"
kind: "package-library"
---

# @deepseek-ai/dsh-execution-world-affinity

[English](README.md) | 中文

## 概述

在组合能力之前，比较文件系统、子进程和沙箱提供方的归属。共享执行命名空间的提供方从运行时所有者获得同一不可变令牌。引用相等比较可检测本地与远程提供方的意外混用。令牌是临时对象，不是工作区身份或访问授权。

## 目录

- [使用本包](#use-this-package)
- [实现](#implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## 使用本包

连接所有者调用一次 `createExecutionWorldAffinity()`，并将结果共享给通过该连接操作的所有提供方。普通宿主提供方使用 `HOST_EXECUTION_WORLD_AFFINITY`。以 `===` 比较令牌；不得持久化、序列化、公开令牌，也不得根据 ID 重建它。此库作为依赖导入，不是配置档插件。

<a id="implementation"></a>

## 实现

每次连接分配返回一个无描述的新符号。宿主令牌使用带版本的 `Symbol.for` 键，使独立求值的包副本在同一 JavaScript agent 内共享它。不发布不变量伴随包，因为此库没有需要核对的独立状态或注册。

<a id="further-exploration"></a>

## 延伸阅读

- [执行世界](../../../docs/subsystems/execution-world.zh.md) — 持久根目录身份与执行命名空间语义。

<a id="model-experience"></a>

## 模型体验

无，因为命名空间令牌既不注册工具，也不进入模型请求。

#### KV 缓存影响

不改变模型请求内容。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 令牌表达可信提供方的归属；它们不能认证远程宿主，也不能检测恶意提供方对命名空间作出的虚假声明。
- 宿主令牌身份在同一 JavaScript agent 内重复求值模块后保持不变；令牌不跨工作线程、进程或序列化传输。

### 开发备注

此库不拥有持久记录。
