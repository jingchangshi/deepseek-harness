# TileLang 集成

[English](tilelang-integration.md) | 中文

本文定义 `tilelang` [仓库 preset](repository-presets.zh.md)。

## 摘要

使用此 preset 检查 Python 语法、构建 native library，并验证 backend 注册、语义和 source-only IR lowering。开发检查不要求目标设备。硬件资格验证要求单独配置命令。

## 目录

- [知识来源](#knowledge-sources)
- [环境](#environment)
- [验证命令](#verification-commands)
- [验收层级](#acceptance-tiers)

<a id="knowledge-sources"></a>
## 知识来源

Preset 指向 `CONTRIBUTING.md`、`tilelang/backend/README.md`、`tilelang/ascend/README.md` 和 `.agents/skills`。角色按需读取 build、backend、semantic、IR 和其他仓库 skill。Backend 名称和编译阶段属于仓库数据，不是 runtime 枚举。

<a id="environment"></a>
## 环境

[命令配置](../../tools/agent/presets/tilelang/.agent/config/commands.yaml) 对语法检查使用 local runner，对 native 检查使用具名 Docker runner。Docker 使用 `/usr/bin/docker`、容器 `s00653124_build`、用户 `shijingchang`、home `/home/shijingchang` 和 `workingDirectory: '{{PROJECT_ROOT}}'`。容器应能通过同一绝对路径访问所选 checkout。

按部署要求编辑 runner 字段和 `env.set`。`DSH_BUILD_DIR` 和 `DSH_VENV_DIR` 接受相对项目路径或绝对路径，默认值为 `build` 和 `.venv`。`DSH_CANN_ENV`、`DSH_CONDA_SH` 和 `DSH_CONDA_ENV` 选择 CANN 与 Conda 设置。Python 需要已声明的依赖；构建需要已有 CMake 配置和已初始化的依赖。

对硬件无关检查，配置 CPU 和 Ascend stub，并关闭 CUDA、ROCm、Metal 和 LLVM native 代码生成。使用已验证的 GCC 8 标准库时，配置 `-DCMAKE_CXX_STANDARD_LIBRARIES=-lstdc++fs`。Wrapper 使用已有构建配置；它不配置新构建，也不安装依赖。

Native 命令向固定的 [shell wrapper](../../tools/agent/presets/tilelang/.agent/scripts/tilelang.sh) 传递 argv，而不是 shell `-lc` 字符串。显式 `env.set` 和 `env.inherit` 声明控制环境值。两个 wrapper 都列入 `inputs`，因此验证策略摘要包含它们的字节。

<a id="verification-commands"></a>
## 验证命令

`source-syntax` 解析 Python 文件，不导入 TileLang。`build` 编译 native library 和导入所需扩展。并行度和默认的 1,800 秒超时支持配置；wrapper 在构建前报告磁盘空间。`backend-context` 检查注册和调度选项；`semantic-regression` 检查并行竞争和缓冲区初始化。

[Python wrapper](../../tools/agent/presets/tilelang/.agent/scripts/tilelang-check.py) 在所选构建目录内创建导入链接，并检查已加载 native library 的路径。因此，它支持外部构建目录，无需修改 checkout。`ir-verify` 检查简化、Ascend 线程同步、CPU BF16 lowering 和向量化 CPU 源码生成。其 source-only testcase 进入 `tvm.target.Target('c')`，关闭 host codegen 和设备编译，并记录输入 IR 与生成的 C 源码。它不启动 kernel。

Pytest 分别报告跳过的 GPU 用例和已执行测试。语法检查成功不表示 native 或硬件行为正确。可选 Ascend 源码、编译速度和硬件命令保持未配置；它们需要任务专用工具链、缓存条件或设备。

<a id="acceptance-tiers"></a>
## 验收层级

[验证策略](../../tools/agent/presets/tilelang/.agent/config/verification-policy.yaml) 默认选择 `development`：要求语法、构建、backend、语义和 IR 检查。`presubmit` 保留这些要求。`qualification` 还要求 `hardware-runtime`；preset 保持该命令未配置。

`development` 不要求硬件。`qualification` 下，缺失的命令保留 `NOT_RUN` 并阻止验收。硬件资格验证前，所有者应提供命令和显式目标 scope。Native 证据与可移植 harness fixture 结果分别记录。

## 开发备注

2026-10-06 的独立 native 验证使用容器 `/tmp/ir-validation-20261006/tilelang-src` 下的源码副本和构建，以及单独的临时 venv。AST 解析覆盖 403 个 Python 文件。CPU/Ascend-stub native 构建和 source-only CPU codegen 完成；聚焦 pytest 报告 132 个通过，5 个 GPU-runtime 用例跳过。GCC 8 链接要求 `-lstdc++fs`。这些结果是独立 native 证据，不是默认 preset 的执行结果。验证未运行设备或真实模型 smoke，临时路径也不是 preset 默认值。
