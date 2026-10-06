# Web 应用验证 Profile

[English](webapp-profile.md) | 中文

[webapp profile](../../.agent/profiles/webapp.yaml) 定义 typecheck、lint、unit、API contract、数据库迁移、integration、E2E、build 和 deployment smoke 检查。small-feature profile 仅保留 typecheck、unit 和 build。

## 配置项目

把 profile 名称映射到目标仓库拥有的 argv 命令。同一格式支持 Playwright、小程序自动化、后端测试 runner 和数据库工具，无需向 `agentctl` 添加框架逻辑。需要 Linux 的命令可以声明 `platforms: [linux]`。

## 验收

提交的 webapp profile 要求 typecheck、lint、unit、E2E 和 build。可选的 API、迁移、integration 和 deployment 检查保持可见并保留精确状态。必需检查出现 `NOT_RUN`、`INCOMPLETE` 或 `FAIL` 会阻止验收。

## 示例

[`webapp.project.yaml`](../../tools/agent/examples/webapp.project.yaml) 是完整 E2E 测试使用的无凭据合成 adapter。请在目标仓库中替换其命令；不得把该 fixture 当作生产证据。

## Dev Note

无。
