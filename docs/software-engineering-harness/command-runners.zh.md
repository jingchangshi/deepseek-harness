---
kind: reference
description: 命名命令运行器、显式环境、类型化参数和停机证据。
---
# 命令运行器

[English](command-runners.md) | 中文

## 概述

仓库命令配置选择本地或 Docker 执行。运行器分别报告命令状态和停机确定性。自动工作流在审查或验收前阻断停机不确定的任务。SSH 和远程运行器暂不支持。

## 目录

- [配置](#configuration)
- [环境与参数](#environment-and-arguments)
- [停机与恢复](#termination-and-recovery)

<a id="configuration"></a>
## 配置

仓库项目通过 `adapter` 指定命令配置文件。该文件声明 `commands` 或旧 `adapters` 映射，两者不能同时出现。命令的 `runner` 从 `runners` 中选择命名声明。缺少名称或未知配置字段会使加载失败。命名运行器拥有工作目录；其命令不能再声明 `cwd`。

验证消费仓库拥有的执行快照，包含已验证的命令、有效检查、冻结参数和绑定身份。每条命令启动前，driver 检查当前 adapter、policy、profile 和 plan 绑定；漂移会阻止后续命令启动，并要求显式重新规划。发布命令证据前再次检查同一绑定。执行期间的变更可以留下诊断，但不能发布权威的通过证据。

```yaml
schemaVersion: 1
runners:
  source:
    kind: local
    workingDirectory: .
commands:
  source-check:
    runner: source
    executable: node
    args: [-e, "process.exit(0)"]
    env:
      set: {}
      inherit: [PATH]
    terminationTimeoutMs: 30000
    outputLimitBytes: 16384
inputs: []
selectedTests: []
```

Docker 声明要求可执行文件绝对路径、容器、用户、主目录和容器工作目录。工作目录可以使用完整的 `{{PROJECT_ROOT}}` 标记。宿主工作目录是所选仓库。Docker 目标环境赋值转换为独立的 `--env` 参数；命令不会解析为 Shell 字符串。仓库拥有的包装脚本可以初始化 CANN 或 Conda。在 `inputs` 中声明这些脚本，使其字节和解析位置变化能使旧策略证据失效。

没有 `runner` 的旧命令显式解析为本地执行。它们继承可用的路径、主目录和临时目录变量，不继承凭据。输出限制保持为 16384 字节；未单独配置时，停机确认使用检查超时。远程包装命令必须迁移到显式运行器声明。引擎不会从可执行文件名推断运行器。

<a id="environment-and-arguments"></a>
## 环境与参数

显式环境包含 `set` 和 `inherit`。缺少继承变量、未知字段、重复名称和含秘密的变量名会被拒绝。Docker HOME 来自运行器声明。解析后的环境、运行器、可执行文件、参数和工作目录都参与命令证据身份。

`{{PROJECT_ROOT}}` 和 `{{BASE_REVISION}}` 展开为一个参数。`{{CHANGED_FILES}}` 和 `{{SELECTED_TESTS}}` 展开为独立参数，空列表产生零个参数。标记必须占据完整参数。未知或嵌入标记会失败。没有 Git 修订时，基线标记会失败。变更文件来自封存源码对比；所选测试来自仓库命令配置。

<a id="termination-and-recovery"></a>
## 停机与恢复

在 Linux 上，执行使用已维护的子进程提供者所拥有的系统级 Systemd 范围。直接进程退出后，运行器终止同一管理范围并确认它已为空，包括脱离进程组或重新归属的后代。没有原生管理能力时不启动命令，结果为 `NOT_RUN`；进程组观察不是回退方案。Docker 取消或超时会返回 `UNCERTAIN`，即使宿主驱动已退出。停机不确定时进入 `BLOCKED`；操作员必须确认写入停止后才能显式恢复。Reviewer 批准和退出码零都不能替代确认。

## 开发说明

无。
