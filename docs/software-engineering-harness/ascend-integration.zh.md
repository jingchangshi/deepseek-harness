# AscendNPU-IR 集成

[English](ascend-integration.md) | 中文

本文定义 `ascendnpu-ir` [仓库 preset](repository-presets.zh.md)。

## 摘要

使用此 preset 构建两个编译器工具，并在没有目标设备时检查聚焦的 IR 变换。参考回归或硬件资格验证要求更高的验收层级。

## 目录

- [环境](#environment)
- [验证命令](#verification-commands)
- [验收层级](#acceptance-tiers)

<a id="environment"></a>
## 环境

[命令配置](../../tools/agent/presets/ascendnpu-ir/.agent/config/commands.yaml) 声明具名 Docker runner。它使用 `/usr/bin/docker`、容器 `s00653124_build`、用户 `shijingchang` 和 home `/home/shijingchang`。其 `workingDirectory: '{{PROJECT_ROOT}}'` 使用所选 checkout。容器应能通过同一绝对路径访问该 checkout。

按部署要求编辑 runner 字段和 `env.set`。`DSH_BUILD_DIR` 接受相对项目路径或绝对构建路径。`DSH_CANN_ENV`、`DSH_CONDA_SH` 和 `DSH_CONDA_ENV` 选择 CANN 与 Conda 设置。Preset 要求已有 CMake 构建；它不安装依赖，也不应用源码补丁。

命令向固定的 [shell wrapper](../../tools/agent/presets/ascendnpu-ir/.agent/scripts/ascend.sh) 传递 argv，而不是 shell `-lc` 字符串。显式 `env.set` 和 `env.inherit` 声明控制环境值。两个 wrapper 都列入 `inputs`，因此验证策略摘要包含它们的字节。

<a id="verification-commands"></a>
## 验证命令

`build` 增量编译 `bishengir-opt` 和 `bishengir-compile`。并行度和默认的 1,800 秒超时支持配置。Wrapper 在构建前报告磁盘空间。`unit` 检查三个大小写不同的 HIVM RegBase 目录；`ir-verify` 检查 HIVM 单点、pipeline 和 bufferization 行为，以及编译器命令行。

[Lit wrapper](../../tools/agent/presets/ascendnpu-ir/.agent/scripts/ascend-lit.py) 将源码测试配置映射到临时 site 配置。它使用 `DSH_BUILD_DIR` 中的工具和输出，也支持迁移后的构建目录。它不假设 checkout 的 `build/bin` 路径。

`reference` 运行 `check-bishengir`。Lit 分别报告已执行和不支持的测试；成功退出不表示已覆盖不支持的测试。未配置的 IR diff、benchmark、profiling 和硬件命令保留 `NOT_RUN`。

<a id="acceptance-tiers"></a>
## 验收层级

[验证策略](../../tools/agent/presets/ascendnpu-ir/.agent/config/verification-policy.yaml) 默认选择 `development`：要求构建、聚焦单元检查和 IR 验证。`presubmit` 增加参考回归。`qualification` 还要求 `hardware-runtime`。

`development` 不要求硬件。Preset 保持硬件命令未配置：`qualification` 下，它保留 `NOT_RUN` 并阻止验收。所有者应提供命令，并声明已测试的目标和模式。A5、A3、PureAIV 和 MixCV 保持为独立的仓库 scope 值。

## 开发备注

2026-10-06 的独立 native 验证使用容器 `/tmp/ir-validation-20261006/ascend-build`，该目录复制自已有构建。两个修改过的 C++ 文件和两个工具完成编译。聚焦 lit 发现 47 个测试：36 个通过，11 个要求未注册的 `regbase` feature。新增单点清理测试执行了两个 pipeline、diff 和 FileCheck；baseline 与 candidate IR 相同。这些结果是独立 native 证据，不是默认 preset 的执行结果。验证未运行设备资格测试，临时路径也不是 preset 默认值。
