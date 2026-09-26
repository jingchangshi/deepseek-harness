---
description: "Compare live provider namespace ownership without treating a durable workspace ID as execution authority."
kind: "package-library"
---

# @deepseek-ai/dsh-execution-world-affinity

English | [中文](README.zh.md)

## Summary

Compare filesystem, subprocess, and sandbox providers before combining their capabilities. Providers sharing an execution namespace receive the same immutable token from their runtime owner. Reference equality detects accidental mixing of local and remote providers. Tokens are ephemeral, not workspace identities or access grants.

## Table of Contents

- [Use this package](#use-this-package)
- [Implementation](#implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## Use this package

A connection owner calls `createExecutionWorldAffinity()` once and shares the result with every provider operating through that connection. Ordinary Host providers use `HOST_EXECUTION_WORLD_AFFINITY`. Compare tokens with `===`; do not persist, serialize, expose, or reconstruct them from an ID. This library is an imported dependency, not a profile plugin.

<a id="implementation"></a>

## Implementation

Each connection allocation returns a fresh symbol with no description. The Host token uses a versioned `Symbol.for` key so separately evaluated package copies share it within one JavaScript agent. No invariant companion is published because the library has no independent state or registrations to reconcile.

<a id="further-exploration"></a>

## Further Exploration

- [Execution world](../../../docs/subsystems/execution-world.md) — durable root identity and execution namespace semantics.

<a id="model-experience"></a>

## Model Experience

None, as namespace tokens neither register tools nor enter model requests.

#### KV Cache effect

No model request content changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Tokens express trusted provider ownership; they cannot authenticate remote hosts or detect a malicious provider lying about its namespace.
- Host token identity survives repeated module evaluation in one JavaScript agent; tokens do not cross workers, processes, or serialized transports.

### Dev Note

No durable records are owned here.
