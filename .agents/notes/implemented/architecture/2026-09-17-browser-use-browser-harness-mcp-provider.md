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

### Screenshot projection through a shared-client seam

`browser_screenshot` returns `{"path", "width", "height", "size_bytes"}` as
**text**, because upstream writes a PNG to disk instead of returning MCP
`ImageContent`. DSH's bridge saves an image only for a result that already
contains a `type: "image"` block (`containsImage()` gates
`prepareImageProjection()`), so the model received a path and no picture.

The fix belongs at the seam, not in one provider. `dsh-mcp-client` now accepts an
optional `projectResult` hook on its tool-definition options, applied **after**
the standard projection and only to successful results:

```ts
projectResult?: (context: {
  rawName: string
  result: McpResult
  execution: ToolExecution
}) => Promise<ContentBlock[]>
```

It is programmatic-only — a function cannot be schema-validated, so `cordis.yml`
can never supply it; only a composing plugin can. The hook's output flows through
the existing `finalizeContent` path, so it rides the same model-visibility rules
as any other content. A hook that throws degrades to a diagnostic text block
rather than failing a tool call that already succeeded upstream, because
enrichment must never turn a completed action into an error.

This provider supplies the hook: it recognizes the screenshot payload, resolves
the calling Agent's route and proves the model declares `image` input (mirroring
the shared admission rule), reads the PNG, and stores it as a durable attachment.
Every failure path — no store, no route, unreadable file, oversized file, refused
admission — returns text that still names the path, so the model never loses the
result entirely. Screenshots therefore reach an image-capable model as real image
content and remain a path for every other route.

### Skill integration through the existing registry

`browser-harness skill` already prints a complete `SKILL.md`. Rather than ship a
copy that drifts, the provider runs that command and publishes the document
through the existing skill registry — the same registry, ranking, and loader
every filesystem and bundled skill uses. There is no second skill loader.

The optional registry is resolved with `ctx.get('skills')` and handed to the registration, so activation never performs a bare `ctx.skills` read: inside the provider's fiber that read throws for an undeclared service, which is why [the activation and resolution note](../bug-fix/2026-09-20-browser-harness-provider-activation-and-resolution.md) exists.

The body is upstream text verbatim; DSH parses only the frontmatter. The skill
ranks below bundled providers so a user's own skill of the same name still wins,
and it is registered only when a `skills` service is present, so a composition
without one keeps working browser tools. The skill CLI is derived from the
configured command (`browser-harness-mcp` → `browser-harness`) instead of adding
a second path to the config surface.

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
releases to fix one return type, and the reference is DSH-side information the
existing seam can already carry.

**Teaching `dsh-mcp-client` about Browser Harness' screenshot shape.** Rejected:
the shared client would encode one server's file convention, and every future
"returns a reference" server would add another branch. The seam takes a callback
and stays ignorant of any particular upstream.

**Registering the skill by copying `SKILL.md` into a skills directory.** Rejected:
a copy drifts from the installed version, and it bypasses provider ranking and
invalidation. Running the installed command keeps one source of truth.

## Consequences

Attaching to the user's real browser means DSH acts on live state it does not
own: `BU_NAME` selects a daemon whose browser may already be logged in
everywhere, and `browser_cdp` can issue arbitrary CDP methods. Teardown only
disposes the DSH-side MCP client and scope; the daemon and the user's Chrome
keep running, matching the runtime's rule that attached browsers stay externally
owned. The cost is that one local daemon serves one DSH Session at a time —
concurrent Sessions must wait for release, and true browser parallelism requires
the deferred cloud mode where each Session gets its own browser.

`browser_screenshot` returns a local path rather than an image; the provider's
`projectResult` hook now converts it into durable image content for routes that
declare image input, and into a path-bearing text diagnostic otherwise. The cost
is one extra file read per screenshot and a projection that depends on the
upstream payload keeping its `path` field.

## Testing

Unit coverage asserts the provider defaults (`name: browser-harness`,
`exclusive: true`, `command: browser-harness-mcp`, empty args), the timeout
passthrough, every environment mapping including the `record: undefined` case
that must not emit `BH_RECORD`, `cdpUrl`/`cdpWs` mutual exclusion, and rejection
of an empty command or an invalid timeout. `exclusive: true` is proven against
the value handed to `mountSessionMcp`, not asserted in prose.

The screenshot projection is covered against a real PNG and the real `LocalAttachmentStore`: an image-capable route stores the exact bytes and returns an `image` block, a text-only route keeps a path diagnostic, and a missing store, missing file, upstream error text, non-screenshot tool, and non-JSON payload each degrade to text instead of failing. The skill bridge is covered against a real child process and the real skill registry, including publishing, loading the body, disposal, and the missing/failing/silent/unusable-command cases.

One keyless real-Loader composition boots the provider both with and without a mounted registry and pins the published catalog entry, which is what proves activation survives a real plugin fiber. The shared seam has its own suite proving a projector appends content, that a throwing projector does not fail the call, and that omitting one changes nothing.

Regression runs cover `browser-use-runtime`, `mcp-client`, and both existing
providers. A real-Chrome E2E is opt-in behind `DSH_BROWSER_HARNESS_E2E=1` so CI
needs neither Chrome nor a Browser Harness installation.

That E2E has been run against the real stack and passes: Browser Harness 0.1.13
with Chrome 153 on Windows 11, driving a local fixture page through tab
creation, navigation, page state, and JavaScript evaluation, then capturing a
screenshot and asserting the stored attachment holds the exact PNG bytes the
browser produced. Three findings from that run are worth keeping.

The screenshot projection was silently inert until the test's Agent carried a
resolvable model route, because the projection refuses to store an image on an
unverifiable route — the failure surfaced as a path diagnostic, never as a broken
tool call.

`browser_screenshot` intermittently never answers over MCP although the same
capture returns in about 0.1 s through the harness CLI. Repeated calls on one
connection (`110 ms, 85 ms, timeout, 88 ms, timeout`), fresh connections, and
more than one Chrome profile all reproduce it, so it is a race in the upstream
MCP path rather than a configuration or projection fault. The suite retries it
and reports a persistent stall explicitly instead of attributing it elsewhere.

Reaching a real browser at all required a dedicated Chrome instance started with
`--remote-debugging-port` *and* `--user-data-dir`. Without the second flag Chrome
resolves to the default profile and opens no CDP port while still accepting the
flag on its command line, which reads as a broken installation rather than as the
wrong launch. The dedicated instance is also what keeps the agent's profile
separate from the user's daily browsing, and it needs `BU_CDP_URL` set explicitly
because `DevToolsActivePort` is written only for the default profile.
