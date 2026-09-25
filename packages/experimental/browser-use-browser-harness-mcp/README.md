---
description: "Operate the user's running Chrome through Browser Harness MCP, one live Session at a time."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-browser-use-browser-harness-mcp

English | [中文](README.zh.md)

## Summary

Use [Browser Harness](https://github.com/browser-use/browser-harness) to operate a Chrome or Chromium browser already running on the machine, with its existing tabs, cookies, and login state. The provider initializes a Session's MCP connection before creation or resume completes and retains it across turns.

One local daemon drives one shared browser with a mutable current tab, so the browser is reserved for **one live Session at a time**. Screenshots return as real image content on image-capable routes, and the DSH skill registry publishes Browser Harness' workflow guidance. This published experimental package activates only when explicitly mounted.

## Table of Contents

- [Use this package](#use-this-package)
- [Install Browser Harness](#install-browser-harness)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount both entries before creating or resuming a Session, in a profile composition that supplies Agents, tools, and system prompts. Loading or reloading this provider does not adopt Sessions that are already active.

```yaml
- name: '@deepseek-ai/dsh-browser-use'

- name: '@deepseek-ai/dsh-experimental-browser-use-browser-harness-mcp'
  config:
    command: browser-harness-mcp
    toolCallTimeoutMs: 30000
```

Mount only one browser provider. The [browser-use service](../../browser-use/browser-use/README.md) registers a single provider and rejects a second one, so this provider cannot be combined with `browser-use-playwright-mcp` or `browser-use-chrome-devtools-mcp`.

| Field | Default | Meaning |
|---|---|---|
| `command` | `browser-harness-mcp` | MCP server executable, spawned directly without a shell |
| `args` | `[]` | Arguments passed to that executable verbatim |
| `toolCallTimeoutMs` | MCP client default | Per-call timeout in milliseconds |
| `home` | Browser Harness default | Sets `BH_HOME` for its config, runtime, and temporary files |
| `daemonName` | `default` | Sets `BU_NAME`, selecting one daemon and its browser |
| `requireExistingDaemon` | upstream default | Sets `BH_REQUIRE_EXISTING_DAEMON`; refuses to start a daemon |
| `record` | stored preference | Sets `BH_RECORD` to persist action recordings |
| `tabMarker` | daemon default | Sets `BH_TAB_MARKER` to mark the controlled tab |
| `cdpUrl` | local discovery | Sets `BU_CDP_URL` to an HTTP(S) debugging URL |
| `cdpWs` | local discovery | Sets `BU_CDP_WS` to a WS(S) browser endpoint |

`cdpUrl` and `cdpWs` name the same browser and are mutually exclusive. Leaving a field unset writes no environment variable, so Browser Harness keeps its own stored recording and tab-marker preferences.

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-browser-use-browser-harness-mcp) lists accepted fields.

To run through `uvx` instead of an installed executable:

```yaml
  config:
    command: uvx
    args:
      - --from
      - browser-harness[mcp]
      - browser-harness-mcp
```

Prefer the installed executable: `uvx` resolves the package on every Session activation, which adds network latency and a failure mode.

When configuring the system prompt's `toolOrder` for the whole process, leave browser tools under `<unlisted-tools>`. Explicitly listing browser tool names can make prompt assembly fail for Sessions without a browser connection.

-----

<a id="install-browser-harness"></a>
## Install Browser Harness

Browser Harness is an external Python runtime that DSH does not vendor. Install it once, then verify it before mounting this provider.

### Windows 11

```powershell
uv tool install --python 3.12 --upgrade --force 'browser-harness[mcp]'
```

Ensure the install directory is on `PATH`, then check the installation:

```powershell
browser-harness --doctor
```

### Authorize remote debugging

<a id="authorize-remote-debugging"></a>

Browser Harness attaches to the browser over CDP, which Chrome does not expose by default. The reliable setup is a **dedicated browser instance with its own profile**, so the browser you use every day is never altered and the two never fight over the same profile lock.

**The failure to recognize.** Running this against an already-running Chrome, or against the default profile, silently does nothing:

```powershell
# Does NOT enable CDP on the default profile.
chrome.exe --remote-debugging-port=9222
```

Chrome accepts the flag on its command line, but the CDP port never opens, because a profile that is already in use hands the request to the existing process and the default profile does not expose remote debugging to this flag. `Get-NetTCPConnection -LocalPort 9222` then shows nothing listening, which is the signature of this mistake rather than of a broken install.

**The working setup.** Close every Chrome process first, so the new instance is the one that actually starts:

```powershell
taskkill /F /IM chrome.exe
$profile = "$env:LOCALAPPDATA\ChromeAgentProfile"
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
    --remote-debugging-port=9222 `
    --user-data-dir="$profile" `
    --no-first-run `
    --no-default-browser-check
```

Then verify the port, which is the only check that matters:

```powershell
Invoke-RestMethod http://127.0.0.1:9222/json/version
```

A working instance returns `Browser`, `Protocol-Version`, and a `webSocketDebuggerUrl`. Confirm the daemon shares that view:

```powershell
browser-harness --doctor
```

`chrome running`, `daemon alive`, and `active browser connections` should all report `ok`. The remaining `Browser Use cloud auth` line is optional and unrelated; `auth login` is only for cloud browsers.

**Why `--user-data-dir` is required.** Without it Chrome resolves to the default profile, which is where this fails. A dedicated directory also keeps the agent's cookies and logins separate from your daily browsing, and lets you delete the whole agent profile to reset it.

**Signs it is working.** The daemon log at `%USERPROFILE%\.config\browser-harness\tmp\bu-default.log` records `attached <target> (about:blank)`. If it instead shows `handshake-wait: if Chrome shows an 'Allow remote debugging?' popup, click Allow`, the browser is waiting for interactive consent; a dedicated instance started as above does not prompt.

Two related caveats. `DevToolsActivePort` is written only for the default profile, so a dedicated instance needs `BU_CDP_URL=http://127.0.0.1:9222` set explicitly, which is also how the E2E suite is pointed at it. And on a Chrome that an organization manages, remote debugging can be blocked outright by policy; check `chrome://management` and `chrome://policy` in that case.

### The operating skill is registered automatically

Browser Harness ships its own workflow guidance. The provider runs `browser-harness skill` and publishes the returned document through the DSH [skill registry](../../../docs/subsystems/skills.md), so the model discovers `browser-harness` alongside every other skill and loads the body on demand.

Nothing to export by hand: the text comes from the installed version, and it disappears from the catalog when the package is uninstalled. To inspect it yourself, run the same command:

```powershell
browser-harness skill
```

If your composition mounts no skill registry, the browser tools still work — only the skill is absent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider maps its configuration onto Browser Harness environment variables and starts `browser-harness-mcp` as a stdio MCP server through the [shared runtime](../browser-use-runtime/README.md), which owns awaited Agent initialization, per-Session serialization, and cleanup. The server calls `ensure_daemon()` before each helper, so the daemon starts on first use and connects to the local browser over CDP; the [MCP client](../../mcp/mcp-client/README.md) owns transport, discovery, and result projection.

The provider passes `exclusive: true`, so the shared runtime admits one live Session at a time. Because a daemon keeps mutable current-tab state, two Sessions sharing it would interleave `switch_tab` and act on each other's tab; serializing individual calls cannot fix that, since a multi-step workflow must be atomic as a whole.

Because upstream writes screenshots to disk and returns their path as text, the provider supplies a result projection to the MCP client. On a route that declares image input, the PNG is read and stored as a durable attachment, so the model receives real image content; on any other route, or if the file cannot be read, the result stays a text diagnostic that still names the path. The projection runs after the standard one and never turns a completed browser action into a failed tool result.

Cleanup disposes only the DSH-side connection and skill registration. The Browser Harness daemon and the browser it drives stay running, and a later activation can attach again.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser use](../../../docs/subsystems/browser-use.md) — provider selection and Session ownership.
- [Browser-use service](../../browser-use/browser-use/README.md) — exclusive provider registration.
- [Browser Harness](https://github.com/browser-use/browser-harness) — upstream installation, helpers, and daemon behavior.
- [Result projection decision](../../../.agents/notes/implemented/architecture/2026-09-17-browser-use-browser-harness-mcp-provider.md) — why screenshots become image content on capable routes.

-----

<a id="model-experience"></a>
## Model Experience

### Browser tools and screenshots

#### What the model sees

Tools retain upstream descriptions and JSON schemas under `mcp__browser-harness__<tool>` names, including `browser_new_tab`, `browser_goto`, `browser_page_info`, `browser_click`, `browser_type`, `browser_fill`, `browser_screenshot`, `browser_list_tabs`, `browser_switch_tab`, `browser_js`, and `browser_cdp`; `browser_click` takes viewport `x`/`y` coordinates, while `browser_fill` and `browser_upload_file` take CSS selectors. `browser_screenshot` returns `{"path", "width", "height", "size_bytes"}` as text; on a route whose model declares image input, the provider reads that PNG and stores it as a durable attachment, so **the model receives the image itself**, while any other route receives a text diagnostic naming the path, as does a file that cannot be read, exceeds 32 MiB, or is refused by image admission. A `browser-harness` skill is also in the catalog; load it for the upstream workflow guidance — when a browser is warranted, how to drive the harness, and which helper to reach for. Upstream reports every helper failure as ordinary text `{"error": "..."}` rather than an MCP error, so a failed call reaches the model as a JSON result instead of a failed tool result.

#### Token effect

The catalog adds tool definitions plus one skill summary; calls add arguments and text results to Session history. A screenshot on an image-capable route adds image content, while the path text remains in history.

#### KV Cache effect

An unchanged catalog preserves its tool-definition prefix. Results append to history; provider or catalog changes can reduce prefix reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One Session per local browser.** A second live Session receives no Browser Harness tools while the first holds the browser. Its other DSH tools keep working, it fails no Session creation, and a later created or resumed activation can acquire the browser after release. Concurrent browser use needs the deferred cloud mode where each Session owns a separate browser.
- **Screenshots depend on the model route.** They become image content only when the calling Agent's model declares image input; any other route, or a file that cannot be read, keeps the path as text.
- **A missing skill registry drops only the skill.** The browser tools still activate; the upstream guidance simply is not in the catalog.
- **Upstream errors look like successes.** A failed helper returns text `{"error": "..."}` with no MCP error flag, so failures are not surfaced as failed tool calls.
- **`browser_screenshot` can stall over MCP.** Measured against Browser Harness 0.1.13: the identical capture returns in about 0.1 s through the `browser-harness` CLI, while the MCP wrapper intermittently never answers and the call reaches its tool timeout. Reproduced across repeated calls on one connection (`110 ms, 85 ms, timeout, 88 ms, timeout`) and on fresh connections, on more than one Chrome profile, so it is a race in the upstream MCP path rather than a configuration fault or a projection fault. Retrying the call is the practical workaround; when it answers, the screenshot is stored as an image exactly as described above.
- **External executable required.** The provider starts an installed `browser-harness-mcp` and DSH vendors no Python package; a missing executable rejects Session creation. A missing `uv` or Python runtime is a Browser Harness installation problem reported by `browser-harness --doctor`.
- **The browser must be started with remote debugging and a dedicated profile.** See [Authorize remote debugging](#authorize-remote-debugging); a browser started without it is reachable by the daemon only after the user approves the in-browser prompt.
- **A stale daemon persists across DSH sessions.** The daemon outlives DSH; `browser-harness --reload` stops it so the next call picks up new code.
- **No automatic retry.** Startup failure, an unavailable browser, or a tool timeout is not retried within that activation; create a new Session or unload and resume after fixing the cause.
- **Cancellation does not undo delivered actions.** A click, navigation, or `browser_cdp` call already sent to the browser still takes effect.
- **Real browser state is shared.** The browser may be logged in everywhere and hold unsaved work; `browser_cdp` can issue arbitrary CDP methods to it.
- **No stability promise.** Tool schemas follow the installed experimental upstream and carry no DSH stability promise.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The real-browser suite is opt-in behind `DSH_BROWSER_HARNESS_E2E=1`, because CI has neither Chrome nor Browser Harness. It opens its own tab against a loopback fixture and never enters credentials or MFA.

</details>

## Readiness evidence

A local browser preflight is complete only when the dedicated Chrome profile owns the configured CDP endpoint, Browser Harness can drive that endpoint, and the effective DSH profile composition contains exactly one Browser Harness provider with the matching endpoint. Those checks do not prove that an existing Session owns the provider; create a new Session after the provider is mounted and verify that it exposes and successfully executes a `mcp__browser-harness__*` tool. Provider unit tests and direct Browser Harness stack tests are lower-level evidence, not proof of web-profile Session readiness.
