---
description: "Durable execution directory identity, provider-owned canonicalization, and allocation lifecycle."
---

# Execution worlds

English | [中文](execution-world.zh.md)

## Summary

An execution world is the filesystem and process namespace used by mounted providers. [Execution-world identity](../../packages/execution/execution-world/README.md) assigns durable opaque IDs to existing directories resolved by that filesystem. It currently owns identity only, not filesystem or subprocess access. Consumers must not treat an ID as permission or as proof that independently mounted providers share a namespace.

## Table of Contents

- [Identity](#identity)
- [Provider affinity](#provider-affinity)
- [Canonical roots](#canonical-roots)
- [Durability and lifecycle](#durability-and-lifecycle)
- [Deployment selection](#deployment-selection)
- [Cordis API](#cordis-surface)

<a id="identity"></a>

## Identity

```ts type-equiv
/** Persisted opaque identity; it grants no access to a filesystem or process. */
type ExecutionWorkspaceId = Branded<'ExecutionWorkspaceId'>
```

The service persists a random workspace UUID indexed by a digest of the selected world UUID and the filesystem's canonical target key. An existing mapping survives process and provider recreation when storage, world selection and target identity remain stable. Distinct worlds have separate mappings even when their directory text is identical. IDs contain no encoded hostname, username or path.

`ExecutionWorkspaceId` is distinct from the GUI [`WorkspaceId`](workspace.md). GUI workspaces own titles and session membership; execution identities own neither. There is no conversion between these ID types.

<a id="provider-affinity"></a>

## Provider affinity

Filesystem, subprocess, and sandbox providers expose `executionWorldAffinity`, an opaque token compared by reference. Ordinary Host providers share the process-local token; SSH providers forward the token owned by their exact connection generation. Distinct connection owners allocate distinct tokens even if their deployment UUID or path strings match. [Execution-world affinity](../../packages/execution/execution-world-affinity/README.md) owns the token API.

Affinity expresses trusted provider ownership, not remote authentication or authorization. It is never persisted or derived from `ExecutionWorkspaceId`. Matching tokens identify one execution namespace; Cordis dependency generations separately determine which live instances a consumer captured. Tokens alone neither enforce root containment nor bind consumer capabilities.

<a id="canonical-roots"></a>

## Canonical roots

`ctx.fs.resolve` and `ctx.fs.stat` determine the target and require an existing directory. Aliases share an ID when the provider resolves them to the same target key. Missing paths and regular files reject. Consumers never parse the opaque target key or apply Host path normalization to an execution root.

<a id="durability-and-lifecycle"></a>

## Durability and lifecycle

The `execution_world_identity` storage domain retains only world UUIDs, workspace UUIDs and hashed lookup keys. Allocation opens a fresh domain under a same-host kernel lock, closes the domain, then releases ownership. Windows uses an exclusive byte-range file lock; POSIX uses `flock` on a persistent inode. Process termination releases kernel ownership. All processes sharing the store must use the same Host coordination path; cross-machine shared storage is unsupported.

Disposal cancels outstanding resolutions and joins their completion. Loss of a required provider during startup cancels that activation; replacing the provider permits a fresh activation. Genuine initialization errors propagate. A caller cancellation after durable acknowledgement does not remove the committed mapping. The configured lock deadline bounds contention without displacing an active holder.

<a id="deployment-selection"></a>

## Deployment selection

`persisted-local` allocates one local world UUID in storage. `deployment` requires an explicit, stable UUID: aliases of the same remote world must use the same value, while distinct worlds must not. The service does not authenticate a host from this UUID. Loss of storage loses the workspace mappings.

The [base bundle](../../packages/bundle/base/README.md) selects local mode with a coordination path beneath `DSH_HOME/locks`. A remote composition replaces the entire identity configuration with deployment mode, its UUID and a Host coordination path. This configuration does not establish SSH connectivity or bind filesystem and subprocess providers together.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxexecutionworldidentity--executionworldidentity"></a>

### `ctx.executionWorldIdentity` — `ExecutionWorldIdentity`

Owns durable identity allocation, not execution handles or remote transport.

```ts cordis-catalog
/**
 * Resolve an existing directory through the current filesystem and durably allocate its identity.
 * Concurrent aliases share one allocation. Disposal rejects outstanding resolutions; an allocation
 * already committed before cancellation remains available on the next call or restart.
 * @param root - directory in the mounted filesystem's execution world.
 * @param signal - caller cancellation, combined with this provider's lifetime.
 * @returns the same opaque ID after recreation with the same storage and world configuration.
 */
resolve(root: string, signal?: AbortSignal): Promise<ExecutionWorkspaceId>
```

Source: [`packages/execution/execution-world/src/index.ts`](../../packages/execution/execution-world/src/index.ts)
<!-- END GENERATED cordis-surface -->
