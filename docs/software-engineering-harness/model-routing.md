# Model Routing

English | [中文](model-routing.zh.md)

Logical roles resolve through user-owned `models.yaml` and `roles.yaml` under `<DSH_HOME>/engineering/.agent/config`; the [model template](../../.agent/config/models.yaml) and [role template](../../.agent/config/roles.yaml) seed missing files. Marketing names are labels only. Provider IDs, exact model IDs, effort wire values, token limits, and credentials remain deployment configuration. Provider bootstrap, role dispatch, and data-policy authorization share one validated configuration snapshot; restart the engineering profile after editing deployment routes.

## Fixed Tools

The [Cordis overlay](../../tools/agent/profiles/frozen-engineering.patch.yml) exposes `ask_architect`, two scout tools, `run_implementer`, `ask_challenger`, and `ask_reviewer`. `ask_arbiter` is present but disabled. Each active tool uses the `spawn` backend, a fresh child, `maxDepth: 1`, and a role-specific tool filter. The generic dynamic subagent and fork tools are disabled.

The installed profiles also install a generated copy of the Web bundle's standard preset with its `delegation` group removed, so neither the Coordinator nor a dispatched role is offered the generic `subagent` tool. The Coordinator's workflow tools are `engineering_run`, `engineering_status`, `engineering_recover`, `get_goal`, and `update_goal`; a runtime restriction and a workflow guard hold it to them. [Agent Note](../../.agents/notes/implemented/architecture/2026-10-06-engineering-coordinator-tool-surface.md) records why composition, not a runtime filter, is the layer that removes the delegation row.

## Validation

Each role can declare `routeReasoningEfforts` keyed by exact route ID when another route supports different effort levels. The selected mapping overrides that role's `reasoningEffort`; every declared route and effort is validated at load. For example, the Implementer template selects `high` on `architecture` while retaining `max` on its worker route. Writer capability diagnosis uses the Architect execution role and preserves the writer's explicit route effort. An unsupported effort prevents dispatch.

`loadHarnessConfig` rejects unknown providers, unknown routes, unsupported reasoning levels, duplicate tool names, unauthorized premium routes, a second writable role, changed depth or concurrency limits, and a default-enabled arbiter. It also rejects more than two fallbacks, a fallback equal to the primary route, and candidates that repeat a provider/model pair. Each candidate must support the role's effort and premium authorization. Routes sharing one provider and model must declare identical reasoning mappings; conflicting mappings fail configuration validation. `resolveRoleRoute` returns the exact route recorded by smoke diagnostics.

## Adaptive scheduling and capability routes

The target repository owns its optional task policy in `.agent/config/project.yaml` under `scheduling`. The user deployment owns the top-level `simpleMaxFiles`, `standardMaxFiles`, `maxCapabilityEscalations`, and `repairEscalationThreshold` fields in `<DSH_HOME>/engineering/.agent/config/workflow.yaml`; defaults are 3, 12, 2, and 2. Task policy can set `class`, explicit `scopePaths` and `acceptanceCriteria`, recognized `risks`, `needsInvestigation`, and `needsChallenge`. Simple work requires explicit canonical file paths and acceptance criteria; directory and glob scopes cannot authorize it.

In the user deployment, `roles.yaml` declares stronger read-only `escalationRoutes` and may declare up to two `escalationFallbackRoutes` per role. `models.yaml` may assign each route a non-negative `capabilityLevel`; omission means 0. Every escalation route must exceed the primary and normal-fallback capability levels, use a distinct provider/model, support the role's reasoning effort, and pass its data-class and premium policy. Escalation fallbacks must also exceed the normal route capability floor and pass route policy. The runtime filters candidates against the failed attempt's exact level. `FALLBACK` still handles classified provider/output failures; `ESCALATE` handles a typed capability request or persisted writer diagnosis. See the [adaptive scheduling design](adaptive-scheduling-v2.md) for task artifacts, role responses, and recovery behavior.

## Deployment Values

Both Magpie provider aliases read their endpoint from `DSH_MAGPIE_GATEWAY_URL`; an unresolved endpoint prevents activation. `magpie` defaults to Chat Completions through `${DSH_MAGPIE_API:-openai-completions}`; `DSH_MAGPIE_API` selects another adapter protocol when the deployment declaration contains that placeholder. `magpie-responses` defaults to Responses and accepts `DSH_MAGPIE_RESPONSES_API` to change its adapter protocol. `DSH_MAGPIE_API_KEY_ENV` selects the credential variable name and defaults to `MAGPIE_API_KEY`; its value is a name, never the credential itself. MiMo uses Chat Completions because a live Responses request rejects that protocol despite its catalog metadata.

The optional `company` provider defaults to Chat Completions through `DSH_COMPANY_API`, reads `DSH_COMPANY_GATEWAY_URL`, and references the key value in `DSH_COMPANY_GATEWAY_API_KEY`. Its endpoint is required only when a route selects `company`. To use a company Qwen worker fallback, add the `company` declaration from the [model template](../../.agent/config/models.yaml) to an existing deployment, then set:

```sh
export DSH_COMPANY_GATEWAY_URL=https://company.example/v1
export DSH_COMPANY_GATEWAY_API_KEY='<gateway-key>'
export DSH_WORKER_FALLBACK_MODEL_ID=Qwen3.8-Flash
export DSH_WORKER_FALLBACK_PROVIDER=company
```

Routes describe responsibilities independently of provider names. Each prefix below supplies `_PROVIDER` and `_MODEL_ID` variables. A provider selection must name a declaration in `models.yaml`; add a declaration before selecting a new provider. Endpoint, credential and protocol settings belong to that declaration. Changing a route does not alter relay, data-class or premium authorization.

| Route | Environment prefix |
|---|---|
| `worker` | `DSH_WORKER` |
| `worker-secondary` | `DSH_SECONDARY_WORKER` |
| `worker-fallback` | `DSH_WORKER_FALLBACK` |
| `worker-secondary-fallback` | `DSH_SECONDARY_WORKER_FALLBACK` |
| `architecture` | `DSH_ARCHITECT` |
| `arbiter` | `DSH_ARBITER` |

`${VAR}` requires an environment value for activation. `${VAR:-default}` uses the literal default when the variable is unset or empty; it executes no shell expressions and does not expand nested variables. The templates retain API-confirmed Magpie models as defaults. Architect and Reviewer share `DSH_ARCHITECT_MODEL_ID`; Arbiter has its independent `DSH_ARBITER_MODEL_ID`. Restart the profile after changing the environment or deployment YAML. Installation preserves existing user-owned configuration.

Coordinator and Architect default to medium reasoning through `DSH_ARCHITECT_REASONING_EFFORT`. Reviewer and the disabled Arbiter independently use `DSH_REVIEWER_REASONING_EFFORT` and `DSH_ARBITER_REASONING_EFFORT`, also defaulting to medium. Use high for complex cross-module design or unresolved review disputes when the extra reasoning is useful. These are operating defaults, not a measured claim that medium and high have equal quality; compare representative tasks before making that claim.

```sh
export DSH_MAGPIE_GATEWAY_URL=http://129.153.118.58:8080/v1
export DSH_ARCHITECT_MODEL_ID=codex/gpt-6.1-sol
export DSH_ARCHITECT_REASONING_EFFORT=medium
```

DeepSeek maps the logical medium effort to the supported low wire effort. MiMo, GLM, and Qwen publish no selectable effort levels; their logical effort aliases map to null, and dispatch uses off to omit the wire parameter.

## Bounded Worker Fallback

Scout Primary and Implementer use DeepSeek with one Qwen fallback (`trae-cn/qwen3.8-flash`). Scout Secondary and Challenger use MiMo, then GLM (`trae-cn/glm-5.3-flash`), then the shared Qwen fallback. Coordinator, Architect, and Reviewer have no fallback. Implementer may switch only before dispatching any potentially mutating tool, including shell commands; once such a tool starts, every failure prevents fallback. Each failed child must finish cleanup before the alternate starts.

Fallback belongs to the engineering role invocation, not the provider adapter or bounded-fix loop. Eligible typed classes are `PROVIDER_REQUEST_FAILURE`, `ROUTE_EXECUTION_FAILURE`, `MISSING_STRUCTURED_OUTPUT`, `SCHEMA_INVALID`, `MODEL_MALFORMED_OUTPUT`, `ROLE_TIMEOUT_QUIESCENT`, and `POLICY_REFUSED`. `ROLE_TIMEOUT_QUIESCENT` is eligible only when the owned deadline aborts the child and cleanup succeeds; a deadline during cleanup cannot reclassify an earlier error or completed result; the fallback then receives a fresh bounded attempt deadline. Every other failure defaults to fail-closed `NON_FALLBACKABLE`, including cancellation, profile/session shutdown, writer errors, repository invariants, verification failures, adapter/profile/policy drift, data-policy denial, workflow budgets, global abort, and non-quiescent cleanup. Each candidate independently passes data-class, relay, and route authorization. An endpoint `POLICY_REFUSAL` can select the qualified alternate route because retrying the same route cannot help; a route or data-policy denial cannot authorize fallback.

Runtime code mapping is exact. `PROVIDER_REQUEST_FAILURE` accepts `AUTH`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `RATE_LIMIT`, `QUOTA`, `ACCOUNT_QUOTA`, `INVALID_REQUEST`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `STREAM_CLOSED`, `CONTEXT_WINDOW_EXCEEDED`, `EMPTY_RESPONSE`, and `PI_AI_ERROR`. `ROUTE_EXECUTION_FAILURE` accepts `NO_ADAPTER`, `UNKNOWN_MODEL`, `UNSUPPORTED_REASONING_EFFORT`, `INVALID_MODEL_INFO`, `INVALID_MODEL_CONTEXT`, `INVALID_MODEL_MAX_TOKENS`, `INVALID_MODEL_REASONING`, `INVALID_CATALOG`, and `NO_DISCOVERY`. `MALFORMED_RESPONSE` maps to `MODEL_MALFORMED_OUTPUT`, and `POLICY_REFUSAL` maps to `POLICY_REFUSED`. Lifecycle, registration, programming, abort, obsolete, and unknown codes remain `NON_FALLBACKABLE`.

Every attempt retains the logical role, ordinal, route, provider, resolved model, effort, start and end times, outcome, failure classification, and fallback reason in `.agent/tasks/<taskId>/ROUTE_ATTEMPTS.<role>.jsonl`. This durable JSONL log sits outside the command evidence chain because route attempts are separate from deterministic command evidence. Only one valid role result advances the repository state. A fallback does not consume a bounded implementation-fix round. [Provider smoke tests](provider-smoke-tests.md) qualify the fallback route separately; successful primary execution is not fallback qualification.

## Dev Note

None.
