---
description: "本地 spill 后端：保存会话私有文本，并通过 spill_read 分页取回。"
kind: "package-reference"
---

# @deepseek-ai/dsh-spill-local

[English](README.md) | 中文

## 概述

`dsh-spill-local` 将超大文本保存到本地会话私有文件，并返回不透明定位信息。配合 `dsh-spill-policy` 提供的 `spill_read`，持有定位信息的会话可以按字节上限分页取回全文，包括超长单行和继承的定位信息。文件名不可预测，文件权限为 0600，会话目录权限为 0700。配置控制根目录、读取上限与启动清理期限。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在需要把文本 spill 到本地文件系统的组合中挂载此后端。它注册为 `dsh-spill-policy` 插件与其他调用方使用的 `ctx.spillStore` 服务。

### 最小配置

不带配置加载插件是安全的：文件会落在操作系统临时目录下延迟创建的私有（0700）每进程目录中。当文件必须位于已知位置时，设置 `root`。

```yaml
- name: '@deepseek-ai/dsh-spill-local'
  config:
    root: /absolute/path/to/spill
    cleanupPeriodDays: 30
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | 私有 0700 临时目录 | spill 文件的根目录；设置后可将文件保存在已知位置 |
| `cleanupPeriodDays` | `30` | 启动清理的文件年龄阈值；`0` 禁用清理 |
| `readMaxLines` | `2000` | 每页返回行数上限 |
| `readMaxBytes` | `65536` | 每页返回文本的 UTF-8 字节上限；至少为 4 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-spill-local)是每个受支持字段的穷尽式真源。

### 你会得到什么

`saveText` 返回 `locator`、精确 UTF-8 字节数 `bytes` 和指向 `spill_read` 的取回指引。模型原样传递定位信息，工具要求调用会话存在。定位信息是取回凭据，不按请求会话与生产会话是否相同授权。`offset` 从 1 开始，`limit` 限制行数；`byteOffset` 覆盖行偏移，并使用前一页的 `nextByteOffset` 继续读取。后端将请求的字节上限限制在 `readMaxBytes` 内，因此工具允许更大页面时仍可取回内容。单行超过字节上限时也能分段读取，UTF-8 字符不会被切断。

### 文件存放位置

文件存放在 `<root>/session-<hash>/<random>-<safeName>`：`session-<hash>` 是所属会话 id 的短哈希（让同一会话的文件归在一起），`<random>-<safeName>` 把不可预测的十六进制前缀与清理为单个安全路径段的调用方建议名配对。相对 `root` 从进程工作目录解析。

<a id="startup-cleanup"></a>
### 启动清理

一次尽力而为的扫描会在激活后启动，不延迟服务可用性。它扫描配置的根目录和操作系统临时目录下先前的默认 `dsh-spill-*` 根目录，删除修改时间严格早于配置截止时间的常规文件，修剪空会话目录，并只删除已经变空的先前默认根目录。长期运行的进程要到重启时才会再次扫描。dispose（资源释放）会等待扫描结束；如果清理移除了会话目录，并发写入会重新创建它。

扫描会解析文件系统身份，绝不跟随或删除符号链接，并跳过无关条目。在 POSIX 上，它只接受当前用户拥有、组用户和其他用户不可写、且祖先路径能防止替换的根目录与会话目录；`/tmp` 等带 sticky 位的可写临时目录仍然允许使用。不安全路径会产生警告并保持不变。文件系统和警告接收方故障都会被兜底，因此清理无法使激活或并发 spill 写入失败。

### 故障与恢复

真实存储故障——权限不足、磁盘已满、根目录不可写——会让 `saveText` 调用以拒绝结束；由调用方决定如何降级。随附策略把拒绝当作尽力而为处理并保留原始内联结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释此后端背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

后端只负责存储细节，建立在一个原则之上：**spill 产物必须私有且不可重定向**。根目录私有（0700）、会话目录是稳定哈希、文件名不可预测、写入采用排他且仅所有者模式。存储机制放在与 Cordis 无关的模块中，以便无需上下文即可单元测试。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、`LocalSpillStore` 服务、清理生命周期、定位信息与取回提示的组装 |
| [`src/cleanup.ts`](src/cleanup.ts) | 一次性按年龄扫描、文件系统身份检查、符号链接和所有权保护 |
| [`src/store.ts`](src/store.ts) | 与 Cordis 无关的存储机制：私有根目录、会话目录、安全名称编码、排他写入 |

### 文件命名与写入

`suggestedName` 是不可信输入，因此 `encodeSegment` 会把 `[A-Za-z0-9._-]` 之外的每个字符以及 `~` 本身转义成 `~XXXX` 形式，使映射对所有 JS 字符串都是单射：分隔符、`../`、NUL 与绝对路径永远无法逃出单个路径段，整段 token `.`/`..` 也会被转义。写入采用 `open(path, 'wx', 0o600)`——任何已存在路径（无论是否符号链接）都会失败，因此预置目标无法重定向写入。对同一建议名的两次保存会得到不同的随机前缀。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。

- [spill 存储服务](../spill/README.zh.md)——此后端实现的 `saveText` 约定与词汇。
- [spill 包映射](../README.zh.md)——三包家族与各自职责。
- [dsh-spill-policy](../spill-policy/README.zh.md)——结果过大时调用此后端的策略。
- [spill 子系统](../../../docs/subsystems/spill.zh.md)——穷尽式词汇与归属。
- [工具输出 spill 决策](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.zh.md)——能力边界与设计依据。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过把已保存文件路径与 read/grep 取回指引渲染给模型的 spill 消费方。

#### KV Cache 影响

无直接失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本地后端何时不合适或需要特别的运维注意。它们是当前的包约束。

- **长期运行的部署要等到重启才会被扫描**——一次性扫描只在激活后运行，因此运行期间超过年龄截止值的文件会在下次启动时回收。
- **定位信息需要与其位于同一文件系统的消费方**——远程或虚拟部署需要另一个 `SpillStore` 后端，其定位信息与取回提示在该环境中有明确含义。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放方向。它明确不具权威性。

#### 未来：工作区隔离的交互

`spill_read` 不要求文件系统 `read`、`grep` 工具或会话工作区访问权限。后端拒绝任意路径、符号链接、硬链接文件和不安全的存储权限，但允许继承的有效定位信息。后端扫描完整文件以取得精确总数，只保留一个按字节限制的页面。

</details>
