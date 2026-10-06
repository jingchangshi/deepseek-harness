# Provider Smoke Tests

English | [中文](provider-smoke-tests.zh.md)

`node tools/agent/agentctl.mjs smoke-models` validates every enabled logical role without credentials. It checks configuration resolution and emits route diagnostics for provider, model, reasoning effort routing, and the smoke categories required by the configured roles. Results distinguish `qualification: role` from `qualification: route` and identify the exact `routeId`.

## Mock Mode

Mock mode is deterministic CI evidence. It covers provider and model lookup, reasoning routing, completion, tool use, subagent dispatch, background capability, bounded cancellation, and route diagnosis without network access. Structured output is `NOT_RUN` because no configured role requires it. Mock mode does not qualify a real endpoint.

## Real Mode

Run `node tools/agent/agentctl.mjs smoke-models --real true` to execute every route whose deployment model ID, endpoint, effort mapping, and credential are available. Each process uses the pinned headless profile and a bounded deadline; `--timeout-ms` changes that deadline. A missing input leaves the route `NOT_RUN` without starting DSH, while an attempted route that times out or lacks required evidence is `FAIL`.

A failed-route summary projects durable `llm/retry` and error `turn/end` records to their owning Session. It retains recognized failure codes and valid HTTP statuses, maps other codes to `UNKNOWN`, omits messages and request IDs, and includes at most the last 16 extracted records.

Real mode verifies each route from the durable Session that owns it. A delegated role runs in a child Session, so the child's `request/header` supplies `provider-resolves`, `model-resolves`, and `reasoning-routed`, while the root Session supplies the fixed role tool that dispatched it; a child Session is one whose header names another Session of the same run in `parentSession`. Tool results pair only with a call of the same Session and call id, so a parent `read` or an unrelated Session's successful `read` cannot qualify a role. Background execution and structured output remain `NOT_RUN` because fixed role tools disable background execution and no configured role requires structured output. Missing deployment inputs never qualify a production route.

Role qualification uses the primary route. Route qualification covers each distinct configured route and effort, including `worker-fallback` even when the primary succeeds. Fallback qualification changes only the candidate's model options and preserves the fixed role tool, persona, result requirements, and tool policy. Require passing provider, model, effort, completion, tool-use, and child-dispatch evidence before enabling the route in production. This is an operator deployment requirement; runtime admission checks configuration and policy, not a saved smoke receipt.

### Check Semantics

| Check | Real-mode meaning |
| --- | --- |
| `provider-resolves` | The role's own Session requested the configured provider. |
| `model-resolves` | The role's own Session requested the configured model. |
| `reasoning-routed` | The role's own Session requested the configured reasoning effort. This is request-side evidence that routing selected the effort; it is not provider-side acknowledgement that the endpoint honoured it. |
| `completion` | The process exited zero, the terminal `final` record contains the exact marker, and the role's own Session committed an assistant answer containing the marker. |
| `tool-use` | The role's own Session recorded a successful `read` tool result. |
| `child answer` | Folded into `completion` for a delegated role: the child Session itself must have answered with the marker, so a parent that echoes a read the child never turned into an answer does not qualify. |
| `subagent` | The root Session recorded a successful call to the configured fixed role tool. `NOT_RUN` for the coordinator, which has no role tool. |
| `bounded-cancellation` | The attempt did not exceed its deadline. |
| `route-diagnostic` | The role's own Session route matches the configured route exactly. |

A failed route reports a `failureClass` naming the first failing stage: `PROCESS_EXIT_FAILURE`, `TIMEOUT`, `ROUTE_MISMATCH`, `REASONING_ROUTE_MISMATCH`, `SUBAGENT_NOT_CALLED`, `SUBAGENT_FAILED`, `CHILD_READ_NOT_CALLED`, `CHILD_READ_FAILED`, or `FINAL_MARKER_MISMATCH`. The result also carries a bounded, non-sensitive summary of the expected marker, the final text, the called and successful tool names, the exit code, and the timeout state.

## Required Inputs

The deployment owner sets `DSH_MAGPIE_GATEWAY_URL` and the selected credential environment variable when authentication is required. Smoke registration uses the validated deployment provider definitions, including overridden API, URL and credential variable name. The Magpie model template declares API-confirmed IDs and endpoint-specific adapters. Architect and Reviewer use `codex/gpt-6.1-sol`; primary workers use DeepSeek, secondary workers use MiMo, and Qwen and GLM are separately qualified fallback routes. Arbiter remains disabled.

## Dev Note

None.
