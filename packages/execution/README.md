---
description: "The execution package group: durable directory identities and live provider namespace affinity."
kind: "package-group"
---

# execution/ — execution-world identity

English | [中文](README.zh.md)

## Summary

Use this family to recognize the same execution directory after a process or provider restarts and check whether live providers share one execution namespace. The mounted filesystem resolves aliases in its own namespace, including remote paths. Durable identities and ephemeral affinity tokens contain no host, user, or directory names. They do not replace GUI workspace records or grant execution access.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>

## Packages

| Package | Role |
|---|---|
| [`execution-world`](execution-world/README.md) | Persist opaque execution-world and canonical-root identities |
| [`execution-world-affinity`](execution-world-affinity/README.md) | Identifies live providers sharing one execution namespace through their runtime owner |

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
