---
description: "Persist opaque workspace identities across execution-provider and process recreation."
kind: "package-reference"
---

# @deepseek-ai/dsh-execution-world

English | [中文](README.zh.md)

## Summary

Resolve an existing execution-world directory to an opaque, durable workspace ID. Filesystem providers canonicalize paths, so remote paths never pass through host filesystem APIs. Identity records remain in host storage and contain no raw workspace paths. An identity is not an execution capability.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>

## Use this package

Mount this service with `storageDomain` and the execution filesystem. `ctx.executionWorldIdentity.resolve(root, signal)` returns a persisted ID after verifying that the provider-resolved root is a directory. Missing roots and regular files reject. Concurrent aliases share one allocation.

| Field | Default | Meaning |
|---|---|---|
| `mode` | required | `persisted-local` allocates a local world UUID once; `deployment` requires an operator-owned UUID |
| `deploymentId` | omitted | Required UUID in deployment mode; forbidden in local mode |
| `allocationLockPath` | required | Absolute Host coordination path shared by processes using the same identity store |
| `lockWaitMs` | `30000` | Maximum wait for allocation ownership; timeout fails without displacing the holder |

Remote deployments must choose deployment mode. Aliases of one remote world require the same deployment UUID; distinct worlds require different UUIDs. Storage loss loses the identity mapping. Provider disposal cancels resolution and closes the domain after queued writes settle.

<a id="understand-the-implementation"></a>

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The `execution_world_identity` domain stores a local world UUID and a table of random workspace UUIDs. Table keys digest a versioned tuple of world identity and the opaque filesystem target key. Raw paths and target keys are not persisted. The service serializes allocation and publishes an ID only after storage acknowledges it; cancellation after that acknowledgement does not undo the record.

Each allocation acquires a same-host kernel lock before opening a fresh domain and closes the domain before releasing ownership. POSIX uses a persistent lock-file inode; Windows uses an exclusive byte-range file lock that prevents deletion while held. Process death releases ownership. The lock coordinates identity transactions, not whole DSH processes. No invariant companion is published because root identities have no independent cache: every lookup reads its authoritative domain table.

</details>

<a id="further-exploration"></a>

## Further Exploration

- [Filesystem](../../fs/fs/README.md) — provider-owned target resolution.
- [Storage domain](../../storage/storage-domain/README.md) — validated durable records.
- [SSH](../../ssh/ssh/README.md) — remote filesystem and process ownership.

<a id="model-experience"></a>

## Model Experience

None, as this service allocates identities without registering model tools or prompt content.

#### KV Cache effect

No direct model request changes; consumers own any identity fields they expose.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The operator must keep deployment UUIDs unique and stable; this service does not authenticate a host from a UUID.
- Read-only filesystem/subprocess bindings are not implemented by this identity service.
- Persistent target identity depends on the filesystem provider returning the same canonical key across recreation.
- All processes sharing identity storage must use the same coordination path on one host; cross-machine shared storage is unsupported.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Native Windows and Linux tests exercise real JSON storage, fresh Cordis contexts, separate-process restart, overlapping producers and killed-holder recovery with their native kernel locks. Remote SSH and full C2C acceptance remain unverified.

</details>
