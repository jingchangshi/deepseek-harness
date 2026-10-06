# 冻结版工程 Harness 状态

[English](status.md) | 中文

本页记录[冻结版多模型软件工程 Harness](architecture.zh.md) 的实现状态。它报告已完成证据和已知不可用的 external check，不把计划当成已交付行为。

## 摘要

Stage A 至 I 已完成无凭据实现。Repository state engine、已安装 DSH profile、automatic role runtime、verification profile、recovery behavior、real-composition mock-provider example、Ascend integration 和 freeze manifest 均有 focused coverage。外部 provider 验收尚未通过；设备验收保持 `NOT_RUN`。

## 阶段状态

| Stage | Status | Evidence |
|---|---|---|
| A：evidence 与 architecture | Complete | Architecture、pinned-source finding 与 acceptance matrix |
| B：minimal state machine | Complete | 九种 artifact schema、state engine、atomic store、CLI 与 automatic driver |
| C：pinned DSH profile | Complete | 已安装 Web 和 headless profile，并在启动时验证 freeze |
| D：provider 与 mock routing | Complete | Exact-route validator、mock matrix 与条件式 real-route runner；最近的 real-route 尝试在 Coordinator 阶段因 `RATE_LIMIT` 而 `FAIL` |
| E：orchestration | Complete | Coordinator tool、真实 spawned role、仅 Scout 并行以及 82 个 focused test |
| F：compiler 与 webapp profile | Complete | Argv runner、structured scope 与两个 synthetic E2E example |
| G：failure 与 recovery | Complete | Stale state、corrupt artifact、interrupted write、timeout 与 retry coverage |
| H：AscendNPU-IR integration | Complete | 容器化构建与 1,135 项参考测试集已通过；device check 为 `NOT_RUN` |
| I：freeze | Complete | 带 hash check 的 runtime、toolchain、lockfile 与 configuration manifest |

## Stage A 证据

- Runtime tag：`dsh-v0.2.1-alpha.1`。
- Runtime commit：从固定 tag 在本地解析；Stage I manifest 负责保存精确值。
- 调查 toolchain：Node `v22.22.2`、pnpm `11.7.0`。
- Lockfile SHA-256：`640f05f383247ae579ec4e52e7e498dbd5cd49ac45bd0e306a85db1c67d95476`。
- Design owner：[architecture.zh.md](architecture.zh.md)。
- Acceptance owner：[acceptance-plan.zh.md](acceptance-plan.zh.md)。

## 外部证据

Magpie 部署使用 API 确认的模型 ID。GPT-6.1-Sol、DeepSeek、MiMo、GLM 和 Qwen 的简单在线请求均返回 HTTP 200 及要求的响应。MiMo 必须使用 Chat Completions，尽管目录中的端点元数据不同。固定 DSH smoke 也已通过 GPT-6.1-Sol 和 DeepSeek 角色，以及修正后的 MiMo、Qwen 和 GLM 路由，包含子 agent 派发及 read 工具证据。Ascend 设备检查仍为 `NOT_RUN`；容器化构建和 MLIR 回归套件已独立通过。

## 部署验收

提供 [provider-smoke-tests.zh.md](provider-smoke-tests.zh.md) 中列出的 deployment-specific model ID、endpoint、effort spelling 与 credential，并在重新运行真实 route 验收前解决 gateway failure。提供 target-device access 和任务专用 runtime input，以验收 hardware check。在此之前，实现可复现并已通过 MLIR 验收，但尚未通过 production route 或 hardware qualification。

## 开发备注

无。
