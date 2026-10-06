---
kind: upgrade-guide
description: Engineering model routes use responsibility names and environment-selected providers, models and reasoning levels.
---

# Engineering Model Routes

English | [中文](guide.zh.md)

## Change

Engineering templates use Magpie with GPT-6.1-Sol architecture, DeepSeek primary workers, and MiMo secondary workers. Primary workers have one Qwen fallback; secondary workers try GLM, then Qwen. Writer fallback is permitted only before a potentially mutating tool starts. Provider selection and model IDs accept environment variables with defaults. Both Magpie aliases require `DSH_MAGPIE_GATEWAY_URL`. `magpie` defaults to Chat Completions and accepts `DSH_MAGPIE_API` through its deployment placeholder. An optional `company` provider supports company gateway routes. Architecture, review and the disabled Arbiter default to medium reasoning.

Installation preserves existing user-owned deployment files; it does not rename their route declarations automatically.

## Migration

1. Set `DSH_MAGPIE_GATEWAY_URL` to your gateway URL, including `/v1`. Supply `MAGPIE_API_KEY` when required, or set `DSH_MAGPIE_API_KEY_ENV` to the name of another credential variable.
2. In `<DSH_HOME>/engineering/.agent/config/models.yaml` and `roles.yaml`, rename route declarations and every role/fallback reference: `company-fast` → `worker`, `company-challenger` → `worker-secondary`, `company-fallback` → `worker-fallback`, `worker-fallback-glm` → `worker-secondary-fallback`, `architecture-premium` → `architecture`, and `arbiter-premium` → `arbiter`. Preserve unrelated deployment settings and prior task attempt logs.
3. Apply the environment placeholders from the [model template](../../../../.agent/config/models.yaml). Use the independent `DSH_ARCHITECT_MODEL_ID` and `DSH_ARBITER_MODEL_ID` variables. See [model routing](../../../software-engineering-harness/model-routing.md) for all provider/model prefixes and reasoning variables. To select the company Qwen fallback, add `providers.company` from the template and set `DSH_COMPANY_GATEWAY_URL`, `DSH_COMPANY_GATEWAY_API_KEY`, `DSH_WORKER_FALLBACK_PROVIDER=company`, and `DSH_WORKER_FALLBACK_MODEL_ID=Qwen3.8-Flash`. A selected provider must have a declaration; retain the model's supported reasoning mappings and token limits when switching it.
4. Set `providers.magpie.api: ${DSH_MAGPIE_API:-openai-completions}` in deployment `models.yaml`. Keep Chat Completions for MiMo; use `DSH_MAGPIE_API` only when every route on that provider supports the selected protocol. Add `worker-fallback` after `worker-secondary-fallback` in the `scout-secondary` and `challenger` fallback lists. Apply the role placeholders from the [role template](../../../../.agent/config/roles.yaml). Set `DSH_ARCHITECT_REASONING_EFFORT`, `DSH_REVIEWER_REASONING_EFFORT` or `DSH_ARBITER_REASONING_EFFORT` to `high` if needed; otherwise each defaults to `medium`.
5. Restart the engineering profile. From the pinned checkout, run `node tools/agent/agentctl.mjs smoke-models --real true --timeout-ms 240000 --deployment-root <DSH_HOME>/engineering`. Inspect each result's status; process exit zero alone does not qualify a route.
