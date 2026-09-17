---
description: "Operate the user's running Chrome through Browser Harness MCP, one live Session at a time."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-browser-use-browser-harness-mcp

English | [中文](README.zh.md)

## Summary

Use [Browser Harness](https://github.com/browser-use/browser-harness) to operate a Chrome or Chromium browser that is already running on the machine, with its existing tabs, cookies, and login state. The provider initializes a Session's MCP connection before creation or resume completes and retains it across turns.

One Browser Harness local daemon drives one shared browser and keeps a mutable current tab, so this provider reserves that browser for **one live Session at a time** and works with an externally installed Browser Harness runtime. This published experimental package activates only when explicitly mounted.

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

Browser Harness attaches to the browser over CDP, which Chrome disables by default. In the browser that should be controlled, open:

```text
chrome://inspect/#remote-debugging
```

Enable **Allow remote debugging for this browser instance**, then restart that browser if it asks. This is a per-instance consent that may require a manual click the first time; `browser-harness --doctor` reports `DevToolsActivePort not found` until it is granted. Chrome may also show a debugging notification, and the browser refuses remote debugging on profiles that a policy locks down.

This works without a Browser Use Cloud account: `auth login` is only for cloud browsers.

### Register the operating skill

The MCP tool descriptions do not carry Browser Harness' full workflow guidance. Export its skill text into a [user skill directory](../../../docs/subsystems/skills.md) so the model can load it:

```powershell
browser-harness skill > "$env:USERPROFILE\.dsh\skills\browser-harness\SKILL.md"
```

This keeps the guidance in step with the installed version instead of copying a bundled copy that drifts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider maps its configuration onto Browser Harness environment variables and starts `browser-harness-mcp` as a stdio MCP server through the [shared runtime](../browser-use-runtime/README.md), which owns awaited Agent initialization, per-Session serialization, and cleanup. The server calls `ensure_daemon()` before each helper, so the daemon starts on first use and connects to the local browser over CDP; the [MCP client](../../mcp/mcp-client/README.md) owns transport, discovery, and result projection.

The provider passes `exclusive: true`, so the shared runtime admits one live Session at a time. Because a daemon keeps mutable current-tab state, two Sessions sharing it would interleave `switch_tab` and act on each other's tab; serializing individual calls cannot fix that, since a multi-step workflow must be atomic as a whole.

Cleanup disposes only the DSH-side connection. The Browser Harness daemon and the browser it drives stay running, and a later activation can attach again.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser use](../../../docs/subsystems/browser-use.md) — provider selection and Session ownership.
- [Browser-use service](../../browser-use/browser-use/README.md) — exclusive provider registration.
- [Browser Harness](https://github.com/browser-use/browser-harness) — upstream installation, helpers, and daemon behavior.
- [Screenshot projection decision](../../../.agents/notes/implemented/architecture/2026-09-17-browser-use-browser-harness-mcp-provider.md) — why screenshots stay paths in V1.

-----

<a id="model-experience"></a>
## Model Experience

### Browser tools and screenshots

#### What the model sees

Tools retain upstream descriptions and JSON schemas under `mcp__browser-harness__<tool>` names, including `browser_new_tab`, `browser_goto`, `browser_page_info`, `browser_click`, `browser_type`, `browser_fill`, `browser_screenshot`, `browser_list_tabs`, `browser_switch_tab`, `browser_js`, and `browser_cdp`. `browser_click` takes viewport `x`/`y` coordinates, while `browser_fill` and `browser_upload_file` take CSS selectors.

`browser_screenshot` returns `{"path", "width", "height", "size_bytes"}` as text. It does not return an MCP image block, so **the model receives a local file path and no image**, even on an image-capable route. Reading the image requires a separate step, such as `browser_js` or an external viewer.

Upstream reports every helper failure as ordinary text `{"error": "..."}` rather than an MCP error, so a failed call reaches the model as a JSON result instead of a failed tool result.

#### Token effect

The catalog adds tool definitions; calls add arguments and text results to Session history. Returning a screenshot path rather than inline image bytes keeps image data out of history.

#### KV Cache effect

An unchanged catalog preserves its tool-definition prefix. Results append to history; provider or catalog changes can reduce prefix reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One Session per local browser.** A second live Session receives no Browser Harness tools while the first holds the browser. Its other DSH tools keep working, it fails no Session creation, and a later created or resumed activation can acquire the browser after release. Concurrent browser use needs the deferred cloud mode where each Session owns a separate browser.
- **Screenshots are paths, not images.** DSH's MCP client stores an image only when a result contains an MCP image block. Projecting a local path into the attachment store is deferred; it would require a shared MCP-client capability that does not exist today. Modifying upstream's return type is not an option, because DSH does not fork Browser Harness.
- **Upstream errors look like successes.** A failed helper returns text `{"error": "..."}` with no MCP error flag, so failures are not surfaced as failed tool calls.
- **External executable required.** The provider starts an installed `browser-harness-mcp` and DSH vendors no Python package; a missing executable rejects Session creation. A missing `uv` or Python runtime is a Browser Harness installation problem reported by `browser-harness --doctor`.
- **Remote debugging permission is manual.** Chrome must have remote debugging allowed for that instance, and it typically cannot be granted from DSH. Attaching to a browser without it reports `DevToolsActivePort not found`.
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
