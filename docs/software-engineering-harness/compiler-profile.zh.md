# 编译器验证 Profile

[English](compiler-profile.md) | 中文

[compiler profile](../../.agent/profiles/compiler.yaml) 为构建、lit 或 FileCheck 测试、IR 验证、合法性、SSA 与 dominance、shape、alias 或 bufferization、参考正确性、benchmark 和 profiling 定义逻辑检查。该 profile 不包含项目命令。

## 项目 Adapter

目标仓库为每个支持的检查提供 argv adapter 文档，其中包含 `executable`、`args`、可选 `cwd` 和可选 `platforms`。`agentctl verify-profile` 不经 shell 启动命令。缺少必需 adapter 会产生 `NOT_RUN` 并阻止验收。

## 范围

Adapter 文档在 `scope` 中携带目标和模式矩阵。Runner 在验证和 review 中保留 `A5: PASS`、`A3: NOT_RUN`、`PureAIV: PASS` 和 `MixCV: NOT_RUN` 等值。可选检查可以保持 `NOT_RUN`；每个必需检查都必须为 `PASS`。

## 证据

每个命令在 `EVIDENCE.jsonl` 中记录 argv、工作目录、退出码、超时状态和有界输出。非零退出和超时为 `FAIL`。平台排除和缺少 adapter 为 `NOT_RUN`。

## Dev Note

无。
