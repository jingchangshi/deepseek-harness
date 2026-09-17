# Agent Note: Browser Harness MCP provider and its single local browser lane

Status: implemented

[English](2026-09-17-browser-use-browser-harness-mcp-provider.md) | 中文

## Problem

DSH 的浏览器操作子系统在每个组合中只挂载一个提供方，而现有提供方会为每个活动 Session 启动一个 DSH 自有的浏览器。对于必须使用用户**已经在运行**的 Chrome（包括其标签页、Cookie 和登录状态）的模型来说，没有一等选项：在 DSH 内部重新实现 CDP 会制造一个平行的浏览器子系统，而通过 Playwright 驱动 Browser Harness 则会引入 Browser Harness 本身并不使用的中间层。

[`browser-use/browser-harness`](https://github.com/browser-use/browser-harness) 已经解决了附加问题。它的 `browser-harness-mcp` stdio 服务器会调用 `ensure_daemon()`，并通过 CDP 驱动本地浏览器。真正的问题不是 DSH 能否调用它，而是它的**所有权模型**如何与 DSH 运行时强制执行的按 Session 所有权相协调。

## Decision

新增实验性提供方 `@deepseek-ai/dsh-experimental-browser-use-browser-harness-mcp`，通过现有共享运行时挂载 Browser Harness：

```
DSH Agent / Session → dsh-browser-use → this provider → mountSessionMcp()
  → dsh-mcp-client (stdio) → browser-harness-mcp → Browser Harness daemon → Chrome CDP
```

它复用 `@deepseek-ai/dsh-experimental-browser-use-runtime` 的 `mountSessionMcp()` 与 `SessionResources`；自身不实现任何 CDP 客户端，也绝不 fork Browser Harness。

### 一个本地 daemon 对应一个 Session：`exclusive: true`

DSH 会在一个 Session *内部*串行化调用，但 Browser Harness daemon 以 `BU_NAME` 为键，附加到同一个本地浏览器，并维护**可变的当前标签页状态**——`new_tab`、`switch_tab` 与 `close_tab` 都会改变后续调用所作用的标签页。因此两个 Session 共享同一个 daemon 时会以破坏性方式交错：

```
Session A: browser_switch_tab(A)
Session B: browser_switch_tab(B)
Session A: browser_click(...)     # acts on B's tab
```

单次调用级别的互斥锁无法修复该问题，因为多工具工作流（`switch_tab` → `wait_for_load` → `click` → `screenshot`）只有整体原子时才正确。Session 隔离才是真正的不变量，因此提供方传入 `exclusive: true`，其运行时语义正是*“将一个已有浏览器保留给至多一个活动 Session”*。

于是 `SessionResources.available()` 对其他 Agent 返回 `false`，而 `mountSessionMcp` 的 `agent/created` 监听器将该次激活标记为 `blocked`，而不是让其失败：该 Session 保留所有其他 DSH 工具，其浏览器工具 schema 通过 mask scope 被拒绝，且其 `mcp:browser-harness` 提示词段落被过滤掉。一旦持有者释放，新创建或恢复的激活即可获取该通道。`browser-use-runtime` 无需任何改动；Playwright 与 Chrome DevTools 保持其现有的 `exclusive` 语义。

### 配置

提供方只暴露受控字段——绝不接受任意的 `env: Record<string, string>`——并将其映射到上游变量：`BH_HOME`、`BU_NAME`、`BH_REQUIRE_EXISTING_DAEMON`、`BH_RECORD`、`BH_TAB_MARKER`、`BU_CDP_URL`、`BU_CDP_WS`。**未设置**的选项不会写入任何变量，因此 Browser Harness 会保留自己已保存的录制与标签页标记偏好；`record: undefined` 特意不产生 `BH_RECORD`。`cdpUrl` 与 `cdpWs` 互斥，且都必须能解析为 URL。命令直接启动而不经过 shell，默认使用已安装的 `browser-harness-mcp` 可执行文件；DSH 不分发任何 Python 包，本地 Chrome 也不需要 Browser Use Cloud 账号。

## Upstream contract

通过阅读已安装的 `browser_harness` 源码（0.1.13），并向 `browser-harness-mcp` 发出真实的 `tools/list` JSON-RPC 调用加以验证，而不仅仅依据文档：

- 服务器名为 `browser-harness`，暴露 **23** 个工具，每个原始名称都以 `browser_` 开头。DSH 将其组合为 `mcp__browser-harness__<rawName>`，绝不重命名任何上游工具。
- `browser_click` 接收视口 `x`/`y` 坐标而非选择器；`browser_fill` 与 `browser_upload_file` 接收 CSS 选择器。
- 上游会把*任何* helper 异常转换为普通文本结果 `{"error": "..."}`，且 `isError` 为 false。由于 DSH 的 MCP 桥接仅在 `isError === true` 时抛出，失败的 Browser Harness 调用会作为 JSON 文本到达模型，而不是失败的工具结果。

## Alternatives considered

**`exclusive: false` 加全局单次调用互斥锁。** 否决：仅串行化单个调用仍然会让两个 Session 交错执行同一工作流的*各个步骤*，因此 Session B 的 `switch_tab` 可能落在 Session A 的 `switch_tab` 与 `click` 之间。这只是把明显的竞态变成了偶发的错误标签页操作。

**为每个 Session 分配一个 Browser Harness daemon（按 Session 派生 `BU_NAME`）。** V1 否决：多个 daemon 仍会汇聚到同一个物理浏览器和同一个可变标签页游标，因此只是拆分了 IPC 通道而没有隔离浏览器。真正的隔离需要为每个 Session 分配独立浏览器，这正是被推迟的云端模式。

**在 DSH 中重新实现 CDP，或经由 Playwright 中转。** 否决：前者会制造架构明令禁止的平行浏览器子系统；后者插入 Browser Harness 并不使用的控制层，并会完全绕过其 helper 与 daemon。

**Fork Browser Harness 让 `browser_screenshot` 返回 MCP `ImageContent`。** 否决：这会让 DSH 为了修正一个返回类型而承担跟踪上游发布的责任。此处改为记录该限制。

## Consequences

附加到用户真实浏览器意味着 DSH 会操作它并不拥有的实时状态：`BU_NAME` 选择的 daemon 所对应的浏览器可能已在各处登录，且 `browser_cdp` 可以发出任意 CDP 方法。清理只会释放 DSH 侧的 MCP 客户端与 scope；daemon 和用户的 Chrome 继续运行，符合运行时“附加浏览器仍归外部所有”的规则。代价是一个本地 daemon 同一时间只服务一个 DSH Session——并发 Session 必须等待释放，而真正的浏览器并行需要被推迟的云端模式，让每个 Session 拥有独立浏览器。

`browser_screenshot` 返回本地路径而不是图像，而 DSH 的 MCP 桥接**仅**在结果包含 `type: "image"` 的内容块时才将图像保存到 AttachmentStore（`containsImage()` 决定是否进入 `prepareImageProjection()`）。因此即使模型支持图像输入，它收到的也只是包含路径的文本，**不会产生图像内容块**。DSH 目前没有通用的“本地图像路径 → AttachmentStore”能力，`mountSessionMcp` 刻意不添加任何模型可见内容，而在共享 MCP 客户端中加入投影钩子会改变所有提供方的行为——因此这里将其记为 P1 后续工作，而不在本次改动。

## Testing

单元测试断言提供方默认值（`name: browser-harness`、`exclusive: true`、`command: browser-harness-mcp`、空参数）、超时透传、每一项环境变量映射（包括**不得**产生 `BH_RECORD` 的 `record: undefined` 情形）、`cdpUrl`/`cdpWs` 互斥，以及拒绝空命令或非法超时。`exclusive: true` 是针对交给 `mountSessionMcp` 的实际取值加以证明，而不是在文档中断言。回归运行覆盖 `browser-use-runtime` 与两个现有提供方。真实 Chrome 的端到端测试通过 `DSH_BROWSER_HARNESS_E2E=1` 显式启用，因此 CI 既不需要 Chrome 也不需要 Browser Harness 安装。
