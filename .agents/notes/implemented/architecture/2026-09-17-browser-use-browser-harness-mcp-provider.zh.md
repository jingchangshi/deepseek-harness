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

### 通过共享客户端接缝实现截图投影

`browser_screenshot` 以**文本**返回 `{"path", "width", "height", "size_bytes"}`，因为上游把 PNG 写到磁盘，而不是返回 MCP `ImageContent`。DSH 桥接仅在结果已经包含 `type: "image"` 内容块时才保存图像（`containsImage()` 决定是否进入 `prepareImageProjection()`），因此模型只拿到路径，拿不到图片。

修复应落在接缝处，而不是某一个提供方内部。`dsh-mcp-client` 现在在工具定义选项中接受可选的 `projectResult` 钩子，它在标准投影**之后**应用，且只作用于成功的结果：

```ts
projectResult?: (context: {
  rawName: string
  result: McpResult
  execution: ToolExecution
}) => Promise<ContentBlock[]>
```

该钩子仅供程序化使用——函数无法通过 schema 校验，因此 `cordis.yml` 永远无法提供它，只有组合插件可以。钩子的输出走既有的 `finalizeContent` 路径，因而与任何其他内容遵循相同的模型可见性规则。钩子抛出异常时会降级为诊断文本块，而不会让上游已经成功的工具调用失败，因为增强绝不能把已完成的动作变成错误。

本提供方提供该钩子：它识别截图载荷，解析调用 Agent 的路由并证明该模型声明了 `image` 输入（与共享准入规则一致），读取 PNG，并将其存为持久附件。所有失败路径——没有存储、没有路由、文件不可读、文件超大、准入被拒——都返回仍带路径的文本，因此模型绝不会完全丢失该结果。截图于是对支持图像输入的模型成为真正的图像内容，对其他路由则保持为路径。

### 通过现有注册表集成技能

`browser-harness skill` 已经会打印完整的 `SKILL.md`。本提供方不另行分发副本，而是运行该命令并通过现有技能注册表发布该文档——与所有文件系统和内置技能使用的是同一个注册表、排名与加载器。不存在第二个技能加载器。

这个可选注册表通过 `ctx.get('skills')` 解析后交给注册函数，因此激活过程绝不执行裸的 `ctx.skills` 读取：在提供方的 fiber 内，对未声明服务的该读取会抛出异常，这正是[激活与解析笔记](../bug-fix/2026-09-20-browser-harness-provider-activation-and-resolution.zh.md)存在的原因。

正文是上游原文；DSH 只解析 frontmatter。该技能排名低于内置提供方，因此用户同名的自建技能仍然优先；且只有在存在 `skills` 服务时才注册，因此没有该服务的组合仍可使用浏览器工具。技能 CLI 由已配置的命令派生（`browser-harness-mcp` → `browser-harness`），而不是在配置面上再加一个需要同步的路径。

## Upstream contract

通过阅读已安装的 `browser_harness` 源码（0.1.13），并向 `browser-harness-mcp` 发出真实的 `tools/list` JSON-RPC 调用加以验证，而不仅仅依据文档：

- 服务器名为 `browser-harness`，暴露 **23** 个工具，每个原始名称都以 `browser_` 开头。DSH 将其组合为 `mcp__browser-harness__<rawName>`，绝不重命名任何上游工具。
- `browser_click` 接收视口 `x`/`y` 坐标而非选择器；`browser_fill` 与 `browser_upload_file` 接收 CSS 选择器。
- 上游会把*任何* helper 异常转换为普通文本结果 `{"error": "..."}`，且 `isError` 为 false。由于 DSH 的 MCP 桥接仅在 `isError === true` 时抛出，失败的 Browser Harness 调用会作为 JSON 文本到达模型，而不是失败的工具结果。

## Alternatives considered

**`exclusive: false` 加全局单次调用互斥锁。** 否决：仅串行化单个调用仍然会让两个 Session 交错执行同一工作流的*各个步骤*，因此 Session B 的 `switch_tab` 可能落在 Session A 的 `switch_tab` 与 `click` 之间。这只是把明显的竞态变成了偶发的错误标签页操作。

**为每个 Session 分配一个 Browser Harness daemon（按 Session 派生 `BU_NAME`）。** V1 否决：多个 daemon 仍会汇聚到同一个物理浏览器和同一个可变标签页游标，因此只是拆分了 IPC 通道而没有隔离浏览器。真正的隔离需要为每个 Session 分配独立浏览器，这正是被推迟的云端模式。

**在 DSH 中重新实现 CDP，或经由 Playwright 中转。** 否决：前者会制造架构明令禁止的平行浏览器子系统；后者插入 Browser Harness 并不使用的控制层，并会完全绕过其 helper 与 daemon。

**Fork Browser Harness 让 `browser_screenshot` 返回 MCP `ImageContent`。** 否决：这会让 DSH 为了修正一个返回类型而承担跟踪上游发布的责任，而该引用本身是 DSH 侧信息，既有接缝已经能够承载。

**让 `dsh-mcp-client` 认识 Browser Harness 的截图结构。** 否决：共享客户端会因此写死某一个服务器的文件约定，此后每个“返回引用”的服务器都会再增加一个分支。接缝接收回调，从而对任何特定上游保持无知。

**把 `SKILL.md` 复制到技能目录来注册技能。** 否决：副本会与已安装版本产生偏差，并且会绕过提供方排名与失效机制。运行已安装的命令可以保持单一事实来源。

## Consequences

附加到用户真实浏览器意味着 DSH 会操作它并不拥有的实时状态：`BU_NAME` 选择的 daemon 所对应的浏览器可能已在各处登录，且 `browser_cdp` 可以发出任意 CDP 方法。清理只会释放 DSH 侧的 MCP 客户端与 scope；daemon 和用户的 Chrome 继续运行，符合运行时“附加浏览器仍归外部所有”的规则。代价是一个本地 daemon 同一时间只服务一个 DSH Session——并发 Session 必须等待释放，而真正的浏览器并行需要被推迟的云端模式，让每个 Session 拥有独立浏览器。

`browser_screenshot` 返回本地路径而不是图像；提供方的 `projectResult` 钩子现在会为声明图像输入的路由把它转换为持久图像内容，对其他路由则转换为带路径的文本诊断。代价是每次截图多一次文件读取，且该投影依赖上游载荷保留其 `path` 字段。

## Testing

单元测试断言提供方默认值（`name: browser-harness`、`exclusive: true`、`command: browser-harness-mcp`、空参数）、超时透传、每一项环境变量映射（包括**不得**产生 `BH_RECORD` 的 `record: undefined` 情形）、`cdpUrl`/`cdpWs` 互斥，以及拒绝空命令或非法超时。`exclusive: true` 是针对交给 `mountSessionMcp` 的实际取值加以证明，而不是在文档中断言。

截图投影使用真实 PNG 与真实 `LocalAttachmentStore` 覆盖：支持图像的路由会存入完全一致的字节并返回 `image` 块，纯文本路由保留路径诊断，而缺少存储、文件缺失、上游错误文本、非截图工具以及非 JSON 载荷都会降级为文本，而不是失败。技能桥接使用真实子进程与真实技能注册表覆盖，包括发布、加载正文、注销，以及命令缺失/失败/无输出/文档不可用等情形。另有一个无密钥的真实 Loader 组合测试，在挂载与不挂载注册表两种情况下引导提供方，并钉住已发布的目录条目——正是它证明了激活能在真实插件 fiber 中存活。共享接缝有自己的测试套件，证明投影器会追加内容、抛出异常的投影器不会让调用失败，以及省略投影器时行为不变。

回归运行覆盖 `browser-use-runtime`、`mcp-client` 与两个现有提供方。真实 Chrome 的端到端测试通过 `DSH_BROWSER_HARNESS_E2E=1` 显式启用，因此 CI 既不需要 Chrome 也不需要 Browser Harness 安装。

该端到端测试已在真实环境中运行并通过：Windows 11 上的 Browser Harness 0.1.13 与 Chrome 153，驱动本地夹具页面完成新建标签页、导航、页面状态读取与 JavaScript 求值，随后截图并断言所存储的附件正是浏览器产出的那串 PNG 字节。这次运行有两点发现值得记录。其一，在测试的 Agent 拿到可解析的模型路由之前，截图投影一直是静默失效的，因为投影拒绝在无法验证的路由上存储图像——该失败表现为路径诊断，而从不表现为损坏的工具调用。其二，`browser_screenshot` 经 MCP 调用时间歇性地始终不返回，而同一次截图经 harness 命令行约 0.1 秒即返回。在单条连接上反复调用（`110 ms、85 ms、超时、88 ms、超时`）、在新建连接上、以及在多个 Chrome 配置文件上都能复现，因此这是上游 MCP 路径中的竞态，而不是配置或投影故障。该套件会重试它，并把持续挂起明确报告出来，而不是归因于别处。

要触达真实浏览器，必须启动一个同时带有 `--remote-debugging-port` 与 `--user-data-dir` 的专用 Chrome 实例。缺少后一个参数时，Chrome 会解析到默认配置文件，在命令依旧接受该参数的情况下却不打开任何 CDP 端口，这读起来像是安装损坏，而不是启动方式错误。该专用实例同时把 agent 的配置文件与用户日常浏览隔开；由于其 `DevToolsActivePort` 只为默认配置文件写入，它需要显式设置 `BU_CDP_URL`。
