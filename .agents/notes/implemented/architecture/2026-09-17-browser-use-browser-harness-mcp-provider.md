# Agent Note: Browser Harness MCP provider and its single local browser lane

Status: implemented

English | [中文](2026-09-17-browser-use-browser-harness-mcp-provider.zh.md)

## Problem

DSH's browser-use subsystem mounts exactly one provider per composition, and its
existing providers launch a DSH-owned browser per live Session. A model that
must work with the user's **already-running** Chrome — its tabs, cookies, and
logged-in sessions — has no first-class option: reimplementing CDP inside DSH
would create a parallel browser subsystem, and driving Browser Harness through
Playwright would add a layer Browser Harness does not use.

[`browser-use/browser-harness`](https://github.com/browser-use/browser-harness)
already solves the attachment problem. Its `browser-harness-mcp` stdio server
calls `ensure_daemon()` and drives a local browser over CDP. The open question
was not whether DSH can call it, but how its **ownership model** reconciles with
the per-Session ownership DSH's runtime enforces.

## Decision

Add `@deepseek-ai/dsh-experimental-browser-use-browser-harness-mcp` as an
experimental provider that mounts Browser Harness through the existing shared
runtime:

```
DSH Agent / Session → dsh-browser-use → this provider → mountSessionMcp()
  → dsh-mcp-client (stdio) → browser-harness-mcp → Browser Harness daemon → Chrome CDP
```

It reuses `mountSessionMcp()` and `SessionResources` from
`@deepseek-ai/dsh-experimental-browser-use-runtime`; it implements no CDP client
of its own, and Browser Harness is never forked.

### One local daemon, one Session: `exclusive: true`

DSH serializes calls *within* a Session, but a Browser Harness daemon is keyed
by `BU_NAME`, attaches to one local browser, and holds **mutable current-tab
state** — `new_tab`, `switch_tab`, and `close_tab` all change which tab later
calls act on. Two Sessions sharing one daemon therefore interleave destructively:

```
Session A: browser_switch_tab(A)
Session B: browser_switch_tab(B)
Session A: browser_click(...)     # acts on B's tab
```

A per-call mutex does not repair this, because a multi-tool workflow
(`switch_tab` → `wait_for_load` → `click` → `screenshot`) is only correct when
the whole window is atomic. Session isolation is the real invariant, so the
provider passes `exclusive: true`, whose runtime meaning is exactly *"Reserve
one existing browser for at most one live Session."*

`SessionResources.available()` then reports `false` for other Agents, and
`mountSessionMcp`'s `agent/created` listener marks that activation `blocked`
rather than failing it: the Session keeps every other DSH tool, its browser tool
schemas are denied through a mask scope, and its `mcp:browser-harness` prompt
section is filtered out. Once the owner releases, a newly created or resumed
activation acquires the lane. No change to `browser-use-runtime` was needed;
Playwright and Chrome DevTools keep their existing `exclusive` semantics.

### Configuration

The provider exposes only controlled fields — never an arbitrary
`env: Record<string, string>` — and maps them to the upstream variables:
`BH_HOME`, `BU_NAME`, `BH_REQUIRE_EXISTING_DAEMON`, `BH_RECORD`,
`BH_TAB_MARKER`, `BU_CDP_URL`, `BU_CDP_WS`. An **unset** option writes no
variable, so Browser Harness retains its own persisted recording and tab-marker
preferences; `record: undefined` deliberately does not emit `BH_RECORD`.
`cdpUrl` and `cdpWs` are mutually exclusive and each must parse as a URL. The
command is spawned directly without a shell, defaulting to the installed
`browser-harness-mcp` executable; DSH vendors no Python package and requires no
Browser Use Cloud account for local Chrome.

## Upstream contract

Verified by reading the installed `browser_harness` sources (0.1.13) and by
issuing a real `tools/list` JSON-RPC call to `browser-harness-mcp`, not from
documentation alone:

- The server is named `browser-harness` and exposes **23** tools, each raw name
  beginning `browser_`. DSH composes them as `mcp__browser-harness__<rawName>`
  and never renames an upstream tool.
- `browser_click` takes viewport `x`/`y` coordinates, not a selector;
  `browser_fill` and `browser_upload_file` take CSS selectors.
- Upstream converts *any* helper exception into an ordinary text result
  `{"error": "..."}` with `isError` false. Because DSH's MCP bridge throws only
  on `isError === true`, a failed Browser Harness call reaches the model as JSON
  text rather than as a failed tool result.

## Alternatives considered

**`exclusive: false` plus a global per-call mutex.** Rejected: serializing
individual calls still lets two Sessions interleave the *steps* of one workflow,
so a `switch_tab` from Session B can land between Session A's `switch_tab` and
`click`. It converts an obvious race into a rare wrong-tab action.

**One Browser Harness daemon per Session (deriving `BU_NAME` per Session).**
Rejected for V1: separate daemons still converge on the same physical browser
and the same mutable tab cursor, so it splits the IPC channel without isolating
the browser. Real isolation needs a separate browser per Session, which is the
deferred cloud mode.

**Reimplementing CDP in DSH, or routing through Playwright.** Rejected: the
first creates the parallel browser subsystem the architecture forbids; the
second inserts a control layer Browser Harness does not use and would bypass its
helpers and daemon entirely.

**Forking Browser Harness to return MCP `ImageContent` from
`browser_screenshot`.** Rejected: it makes DSH responsible for tracking upstream
releases to fix one return type. The limitation is documented instead.

## Consequences

Attaching to the user's real browser means DSH acts on live state it does not
own: `BU_NAME` selects a daemon whose browser may already be logged in
everywhere, and `browser_cdp` can issue arbitrary CDP methods. Teardown only
disposes the DSH-side MCP client and scope; the daemon and the user's Chrome
keep running, matching the runtime's rule that attached browsers stay externally
owned. The cost is that one local daemon serves one DSH Session at a time —
concurrent Sessions must wait for release, and true browser parallelism requires
the deferred cloud mode where each Session gets its own browser.

`browser_screenshot` returns a local path, not an image, and DSH's MCP bridge
saves an image into the AttachmentStore **only** for a content block with
`type: "image"` (`containsImage()` gates `prepareImageProjection()`). So the
model receives text containing a path and **no image content block**, even when
it is multimodal. DSH has no generic "local image path → AttachmentStore"
capability, `mountSessionMcp` deliberately adds no model-visible content, and
adding a projection hook to the shared MCP client would change every provider —
so this is recorded as a P1 follow-up rather than changed here.

## Testing

Unit coverage asserts the provider defaults (`name: browser-harness`,
`exclusive: true`, `command: browser-harness-mcp`, empty args), the timeout
passthrough, every environment mapping including the `record: undefined` case
that must not emit `BH_RECORD`, `cdpUrl`/`cdpWs` mutual exclusion, and rejection
of an empty command or an invalid timeout. `exclusive: true` is proven against
the value handed to `mountSessionMcp`, not asserted in prose. Regression runs
cover `browser-use-runtime` and both existing providers. A real-Chrome E2E is
opt-in behind `DSH_BROWSER_HARNESS_E2E=1` so CI needs neither Chrome nor a
Browser Harness installation.
