# Agent Note: Anthropic adaptive thinking for the engineering relay

Status: implemented

English | [中文](2026-10-05-engineering-relay-anthropic-adaptive-thinking.zh.md)

## Problem

The investigated Anthropic Messages relay rejected budget-based thinking for Claude Opus with an error requiring adaptive thinking. pi-ai supports adaptive thinking through model metadata, but deployment-defined provider profiles must carry the compatibility switch explicitly.

## Decision

The harness carries pi-ai [wire-compatibility switches](../../../../packages/llm/llm-pi-ai/src/catalog.ts) as validated configuration for deployment-defined providers. The default Architect and Reviewer use [GPT-6.1 Sol high](../../../../docs/software-engineering-harness/model-routing.md); Anthropic compatibility applies only to deployments that explicitly configure an Anthropic route.

[ProviderConfig](../../../../tools/agent/src/config.ts) exposes an optional boolean dictionary named `compat`. Configuration loading rejects non-boolean values. [providerOptions](../../../../tools/agent/runtime/bootstrap.ts) projects the dictionary onto the pi-ai provider profile.

An Anthropic deployment must use the catalog provider ID `anthropic` so pi-ai validates compatibility field names. A deployment-invented ID skips that validation. The investigated relay accepts `claude-opus-5.5` but rejects the catalog spelling `claude-opus-5-5`; deployment owners must use their endpoint's exact model ID.

## Alternatives considered

**Invent a provider ID.** Rejected: compatibility field names lack catalog validation, so a typo can silently disable the requested behavior.

**Inherit model metadata by using the catalog model ID.** Rejected: the relay rejects that spelling with `model_not_found`.

**Omit thinking.** Rejected: roles configured for high reasoning effort require reasoning to remain enabled.

**Patch pi-ai.** Rejected: upstream already implements `compat.forceAdaptiveThinking`; the harness needs only configuration projection.

## Consequences

Explicitly configured Anthropic providers with `compat.forceAdaptiveThinking: true` send `thinking.type=adaptive` with `output_config.effort`. The switch applies to every model on the provider; a model requiring another thinking mode needs a separate provider configuration. Deployment owners must mirror compatibility settings in their Cordis overlay.

Compatibility field names are validated by pi-ai at profile resolution, while YAML loading validates their boolean values.

## Testing

[The runtime test](../../../../tools/agent/tests/runtime.spec.ts) checks compatibility projection for an explicitly configured Anthropic provider. [Configuration tests](../../../../tools/agent/tests/config.spec.ts) check the default Sol routes separately.
