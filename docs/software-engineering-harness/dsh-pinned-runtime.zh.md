# 固定的 DSH 运行时

[English](dsh-pinned-runtime.md) | 中文

本 Harness 从基于 [`.agent/FREEZE.json`](../../.agent/FREEZE.json) 指定版本的 DSH 分支运行。Core 清单记录版本 tag、commit reference、工具链，以及 package manifest、编排源码、profile composition、deployment seed 模板和 artifact schema 的哈希。仓库项目声明、command adapter、verification profile 和 preset 内容不属于 core freeze；[仓库 preset](repository-presets.zh.md) 拥有独立脚手架身份。

## 验证冻结状态

运行 `pnpm exec vitest run --config tools/agent/vitest.config.ts tools/agent/tests/freeze.spec.ts`。检查要求 tag 和 `commitRef` 解析到同一 commit，并要求该 commit 是分支 `HEAD` 的祖先；不要求 `HEAD` 等于版本 tag。同时，Node、pnpm 版本和清单中每个文件的哈希都必须匹配。

安装器在复制模板和 profile 前运行该检查。通过检查表示记录的基线和文件匹配，不表示分支全部修改都已提交。要获得可复现 checkout，应同时保存经过审阅的分支 commit 和该清单。

Core 源码变更经过审阅后，在本 checkout 中运行 `node tools/agent/agentctl.mjs freeze --root . --update true` 重新生成文件哈希，再运行 `node tools/agent/agentctl.mjs freeze --root .` 验证。生成器保留版本和工具链，包含新增的工程源码与 runtime 模块，并拒绝不兼容的基线。不得手工编辑生成的哈希。

## 升级流程

创建升级分支，选择明确的 DSH tag，并检查 [architecture.md](architecture.zh.md) 中列出的同一组固定源码区域。仅在确认配置假设后更新配置。运行聚焦的状态、路由、profile、恢复、E2E、Cordis dump、文档和真实 provider 检查。仅在这些检查通过后替换清单值。不得让清单指向 `latest` 或移动分支。

## 当前验收状态

无凭据检查在 `dsh-v0.2.1-alpha.1` 上通过。公司网关路由、中继路由、OpenAI 仲裁和 Ascend 设备执行保持 `NOT_RUN`，直到提供部署专用 ID、凭据、端点和硬件。

## Dev Note

无。
