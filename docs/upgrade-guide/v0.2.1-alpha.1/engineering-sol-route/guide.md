---
kind: upgrade-guide
description: Engineering Architect and Reviewer routes require SUB2API credentials instead of Anthropic relay credentials.
---
# Engineering Sol Route

English | [中文](guide.zh.md)

## Change

The engineering harness routes Architect and Reviewer through the OpenAI Responses provider instead of Claude on the Anthropic relay. SUB2API credentials are required for these enabled roles, not only for the optional Arbiter.

## Migration

1. Set `DSH_OPENAI_HIGH_EFFORT=high` and export `DSH_ARCHITECT_MODEL_ID` with the deployed Architect/Reviewer model ID. Follow the canonical [engineering model routes guide](../engineering-model-routes/guide.md) for the deployment model and bounded-fallback migration.
2. Set `DSH_SUB2API_URL` and `DSH_SUB2API_KEY` for the deployment endpoint. The engineering profile no longer reads `DSH_ANTHROPIC_RELAY_URL`, `DSH_ANTHROPIC_RELAY_API_KEY`, or `DSH_ANTHROPIC_HIGH_EFFORT`.
3. Update the installed Cordis overlay from the repository template while preserving existing project-owned `.agent/config` values; initialization must not overwrite user deployment configuration.
4. Run `node tools/agent/agentctl.mjs smoke-models --real true`. Architect and Reviewer must report `openai`, the value resolved from `DSH_ARCHITECT_MODEL_ID`, `high`, and `PASS`; `NOT_RUN` does not qualify the deployment.
