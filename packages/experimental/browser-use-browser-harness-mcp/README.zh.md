---
description: "通过 Browser Harness MCP 操作用户正在运行的 Chrome，同一时间仅限一个活动 Session。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-browser-use-browser-harness-mcp

[English](README.md) | 中文

## 概述

使用 [Browser Harness](https://github.com/browser-use/browser-harness) 操作本机已在运行的 Chrome 或 Chromium 浏览器，复用其现有标签页、Cookie 和登录状态。提供方在 Session 创建或恢复完成前初始化其 MCP 连接，并跨轮次保留连接。

一个本地 daemon 驱动同一个共享浏览器并维护可变的当前标签页，因此该浏览器被保留给**同一时间的一个活动 Session**。在支持图像的路由上截图会作为真实图像内容返回，DSH 技能注册表会发布 Browser Harness 的工作流指引。本包以实验状态发布，仅在显式挂载后启用。

## 目录

- [使用此包](#use-this-package)
- [安装 Browser Harness](#install-browser-harness)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在创建或恢复 Session 前，将以下条目挂载到已提供 Agent、工具和系统提示词的 profile 组合中。加载或重新加载此提供方不会接管已经活动的 Session。

```yaml
- name: '@deepseek-ai/dsh-browser-use'

- name: '@deepseek-ai/dsh-experimental-browser-use-browser-harness-mcp'
  config:
    command: browser-harness-mcp
    toolCallTimeoutMs: 30000
```

只能挂载一个浏览器提供方。[browser-use 服务](../../browser-use/browser-use/README.zh.md)只注册一个提供方并拒绝第二个，因此本提供方不能与 `browser-use-playwright-mcp` 或 `browser-use-chrome-devtools-mcp` 同时使用。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `command` | `browser-harness-mcp` | MCP 服务器可执行文件，直接启动，不经过 shell |
| `args` | `[]` | 原样传给该可执行文件的参数 |
| `toolCallTimeoutMs` | MCP 客户端默认值 | 单次调用超时，单位为毫秒 |
| `home` | Browser Harness 默认值 | 设置 `BH_HOME`，决定其配置、运行时和临时文件位置 |
| `daemonName` | `default` | 设置 `BU_NAME`，选择一个 daemon 及其浏览器 |
| `requireExistingDaemon` | 上游默认值 | 设置 `BH_REQUIRE_EXISTING_DAEMON`，拒绝启动新 daemon |
| `record` | 已保存的偏好 | 设置 `BH_RECORD`，将操作录制保存到本地 |
| `tabMarker` | daemon 默认值 | 设置 `BH_TAB_MARKER`，在被控制的标签页上显示标记 |
| `cdpUrl` | 本地发现 | 设置 `BU_CDP_URL` 指向 HTTP(S) 调试 URL |
| `cdpWs` | 本地发现 | 设置 `BU_CDP_WS` 指向 WS(S) 浏览器端点 |

`cdpUrl` 与 `cdpWs` 指向同一个浏览器，二者互斥。未配置的字段不会写入任何环境变量，因此 Browser Harness 会保留自己已保存的录制与标签页标记偏好。

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-browser-use-browser-harness-mcp)列出接受的字段。

如需改用 `uvx` 而不是已安装的可执行文件：

```yaml
  config:
    command: uvx
    args:
      - --from
      - browser-harness[mcp]
      - browser-harness-mcp
```

优先使用已安装的可执行文件：`uvx` 会在每次 Session 激活时解析软件包，增加网络延迟和新的失败点。

为整个进程配置系统提示词的 `toolOrder` 时，将浏览器工具留在 `<unlisted-tools>` 中。显式列出浏览器工具名称可能导致未获得浏览器连接的 Session 无法组装提示词。

-----

<a id="install-browser-harness"></a>
## 安装 Browser Harness

Browser Harness 是 DSH 不随包分发的 Python 外部运行时。安装一次，并在挂载本提供方前完成验证。

### Windows 11

```powershell
uv tool install --python 3.12 --upgrade --force 'browser-harness[mcp]'
```

确认安装目录已加入 `PATH`，然后检查安装状态：

```powershell
browser-harness --doctor
```

### 授权远程调试

<a id="authorize-remote-debugging"></a>

Browser Harness 通过 CDP 附加到浏览器，而 Chrome 默认不暴露该端口。可靠的做法是启动**一个专用浏览器实例并使用独立配置文件**，这样日常使用的浏览器不会被改动，两者也不会争抢同一个配置文件锁。

**要识别的失败现象。** 对一个已在运行的 Chrome，或对默认配置文件执行下面这条命令，会静默地什么都不做：

```powershell
# Does NOT enable CDP on the default profile.
chrome.exe --remote-debugging-port=9222
```

Chrome 会在命令行中接受该参数，但 CDP 端口始终不会打开，因为已被占用的配置文件会把请求转交给既有进程，而默认配置文件不会因该参数而暴露远程调试。此时 `Get-NetTCPConnection -LocalPort 9222` 显示没有任何监听——这正是该错误的特征，而不是安装损坏的特征。

**可用的配置方式。** 先关闭所有 Chrome 进程，确保真正启动的是这个新实例：

```powershell
taskkill /F /IM chrome.exe
$profile = "$env:LOCALAPPDATA\ChromeAgentProfile"
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
    --remote-debugging-port=9222 `
    --user-data-dir="$profile" `
    --no-first-run `
    --no-default-browser-check
```

随后验证端口，这是唯一真正重要的检查：

```powershell
Invoke-RestMethod http://127.0.0.1:9222/json/version
```

可用的实例会返回 `Browser`、`Protocol-Version` 与 `webSocketDebuggerUrl`。再确认 daemon 看到的状况一致：

```powershell
browser-harness --doctor
```

`chrome running`、`daemon alive` 与 `active browser connections` 都应报告 `ok`。剩下的 `Browser Use cloud auth` 一行是可选项，与之无关；`auth login` 仅用于云端浏览器。

**为什么 `--user-data-dir` 是必需的。** 不提供它时 Chrome 会解析到默认配置文件，而这正是失败所在。独立目录还能把 agent 的 Cookie 与登录态同日常浏览隔开，并允许你直接删除整个 agent 配置文件来重置它。

**工作正常的标志。** daemon 日志 `%USERPROFILE%\.config\browser-harness\tmp\bu-default.log` 会记录 `attached <target> (about:blank)`。如果它显示的是 `handshake-wait: if Chrome shows an 'Allow remote debugging?' popup, click Allow`，说明浏览器正在等待人工授权；按上述方式启动的专用实例不会弹出该提示。

两个相关注意事项。`DevToolsActivePort` 只会为默认配置文件写入，因此专用实例需要显式设置 `BU_CDP_URL=http://127.0.0.1:9222`，端到端测试套件也正是通过它指向该实例。另外，在由组织管理的 Chrome 上，远程调试可能被策略直接封禁；此时请检查 `chrome://management` 与 `chrome://policy`。

### 操作技能会自动注册

Browser Harness 自带工作流指引。提供方会运行 `browser-harness skill`，并把返回的文档发布到 DSH [技能注册表](../../../docs/subsystems/skills.zh.md)，因此模型会像发现其他技能一样发现 `browser-harness`，并按需加载正文。

无需手工导出：文本来自已安装的版本；卸载该包后它会自动从目录中消失。如需自行查看，运行同一条命令：

```powershell
browser-harness skill
```

如果你的组合没有挂载技能注册表，浏览器工具仍然可用——只是缺少该技能。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

提供方将自身配置映射为 Browser Harness 的环境变量，并通过[共享运行时](../browser-use-runtime/README.zh.md)以 stdio MCP 服务器方式启动 `browser-harness-mcp`；共享运行时负责等待式的 Agent 初始化、按 Session 串行化和清理。该服务器在每次调用 helper 前调用 `ensure_daemon()`，因此 daemon 在首次使用时启动并通过 CDP 连接本地浏览器；[MCP 客户端](../../mcp/mcp-client/README.zh.md)负责传输、发现和结果投影。

提供方传入 `exclusive: true`，因此共享运行时同一时间只接纳一个活动 Session。由于 daemon 维护可变的当前标签页状态，两个 Session 共享它会交错执行 `switch_tab` 并操作对方的标签页；仅串行化单次调用无法解决该问题，因为多步工作流必须整体保持原子性。

由于上游把截图写入磁盘并以文本返回其路径，提供方会向 MCP 客户端提供一个结果投影。在声明支持图像输入的路由上，PNG 会被读取并存为持久附件，模型因此收到真正的图像内容；在其他路由上，或文件无法读取时，结果仍是带路径的文本诊断。该投影在标准投影之后运行，绝不会把已完成的浏览器操作变成失败的工具结果。

清理只释放 DSH 侧的连接与技能注册。Browser Harness daemon 及其驱动的浏览器继续运行，之后的激活可以再次附加。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [浏览器使用](../../../docs/subsystems/browser-use.zh.md) — 提供方选择与 Session 所有权。
- [browser-use 服务](../../browser-use/browser-use/README.zh.md) — 独占的提供方注册。
- [Browser Harness](https://github.com/browser-use/browser-harness) — 上游安装、helper 与 daemon 行为。
- [结果投影决策](../../../.agents/notes/implemented/architecture/2026-09-17-browser-use-browser-harness-mcp-provider.zh.md) — 为何截图在支持的路由上会成为图像内容。

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器工具与截图

#### 模型看到的内容

工具保留上游描述与 JSON schema，名称形如 `mcp__browser-harness__<tool>`，包括 `browser_new_tab`、`browser_goto`、`browser_page_info`、`browser_click`、`browser_type`、`browser_fill`、`browser_screenshot`、`browser_list_tabs`、`browser_switch_tab`、`browser_js` 和 `browser_cdp`；`browser_click` 接收视口 `x`/`y` 坐标，而 `browser_fill` 与 `browser_upload_file` 接收 CSS 选择器。`browser_screenshot` 以文本形式返回 `{"path", "width", "height", "size_bytes"}`；在模型声明支持图像输入的路由上，提供方会读取该 PNG 并存为持久附件，因此**模型收到的是图像本身**，其他路由收到的则是带路径的文本诊断，文件无法读取、超过 32 MiB，或被图像准入拒绝时同样如此。目录中还会出现 `browser-harness` 技能；加载它即可获得上游的工作流指引——何时该用浏览器、如何驱动该 harness，以及该选择哪个 helper。上游将所有 helper 失败都报告为普通文本 `{"error": "..."}`，而不是 MCP 错误，因此失败的调用会作为 JSON 结果返回给模型，而不会表现为失败的工具结果。

#### Token 影响

工具目录会增加工具定义以及一条技能摘要；调用会把参数和文本结果追加到 Session 历史。在支持图像的路由上截图会加入图像内容，而路径文本仍保留在历史中。

#### KV Cache 影响

目录不变时其工具定义前缀保持不变。结果追加到历史；提供方或目录变化可能降低前缀复用率。

## 已知限制与待办事项

<a id="known-limitations-and-deferred-work"></a>

- **每个本地浏览器仅限一个 Session。** 当第一个 Session 持有浏览器时，第二个活动 Session 不会获得 Browser Harness 工具。它的其他 DSH 工具继续可用，不会导致 Session 创建失败，且在释放后新创建或恢复的激活可以获取该浏览器。真正的并发浏览器使用需要待实现的云端模式，让每个 Session 拥有独立浏览器。
- **截图取决于模型路由。** 只有当调用 Agent 的模型声明支持图像输入时，截图才会成为图像内容；其他路由，或文件无法读取时，都以文本保留路径。
- **缺少技能注册表只会丢失技能。** 浏览器工具仍会激活，只是上游指引不在目录中。
- **上游错误看上去像成功。** 失败的 helper 会返回文本 `{"error": "..."}`，且没有 MCP 错误标志，因此失败不会表现为失败的工具调用。
- **`browser_screenshot` 经 MCP 调用时可能挂起。** 针对 Browser Harness 0.1.13 的实测：同一次截图经 `browser-harness` 命令行约 0.1 秒返回，而 MCP 封装会间歇性地始终不返回，直到触发工具超时。该现象在单条连接上反复调用即可复现（`110 ms、85 ms、超时、88 ms、超时`），在新建连接上同样复现，且在多个 Chrome 配置文件上均出现，因此这是上游 MCP 路径中的竞态，而不是配置故障或投影故障。重试该调用是可行的规避方式；只要它返回，截图就会按上文所述存为图像。
- **依赖外部可执行文件。** 提供方启动已安装的 `browser-harness-mcp`，DSH 不分发任何 Python 包；可执行文件缺失会导致 Session 创建失败。缺少 `uv` 或 Python 运行时属于 Browser Harness 安装问题，由 `browser-harness --doctor` 报告。
- **浏览器必须带远程调试并使用独立配置文件启动。** 参见[授权远程调试](#authorize-remote-debugging)；未以此方式启动的浏览器只有在用户批准浏览器内提示后才能被 daemon 访问。
- **陈旧 daemon 会跨 DSH 会话存留。** daemon 的生命周期长于 DSH；`browser-harness --reload` 可停止它，使下次调用加载新代码。
- **不会自动重试。** 启动失败、浏览器不可用或工具超时都不会在该次激活内重试；排除原因后新建 Session，或卸载后恢复。
- **取消不会撤销已送达的操作。** 已经发送给浏览器的点击、导航或 `browser_cdp` 调用仍然生效。
- **真实浏览器状态是共享的。** 该浏览器可能已登录所有站点并持有未保存的工作；`browser_cdp` 可以向它发出任意 CDP 方法。
- **无稳定性承诺。** 工具 schema 跟随已安装的实验性上游，不提供 DSH 稳定性承诺。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

真实浏览器测试通过 `DSH_BROWSER_HARNESS_E2E=1` 显式启用，因为 CI 既没有 Chrome 也没有 Browser Harness。测试会针对回环地址 fixture 打开自己的标签页，绝不输入凭据或 MFA。

</details>
