---
description: "The execution package group: durable identities for directories resolved by the mounted execution filesystem."
kind: "package-group"
---

# execution/ — execution-world identity

English | [中文](README.zh.md)

## Summary

Use this family to recognize the same execution directory after a process or provider restarts. The mounted filesystem resolves aliases in its own namespace, including remote paths. Its opaque identities contain no host, user, or directory names. They do not replace GUI workspace records or grant execution access.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>

## Packages

| Package | Role |
|---|---|
| [`execution-world`](execution-world/README.md) | Persist opaque execution-world and canonical-root identities |

<a id="related-documentation"></a>

## Related documentation

- [Execution-world subsystem](../../docs/subsystems/execution-world.md) — identity and lifecycle semantics.
- [Filesystem subsystem](../../docs/subsystems/filesystem.md) — provider-owned path resolution.
- [Subprocess subsystem](../../docs/subsystems/subprocess.md) — process execution in the mounted namespace.
- [SSH subsystem](../../docs/subsystems/ssh.md) — remote execution providers.
- [Workspace subsystem](../../docs/subsystems/workspace.md) — separate GUI entities and session membership.

<a id="dev-note"></a>

## Dev Note

None.
