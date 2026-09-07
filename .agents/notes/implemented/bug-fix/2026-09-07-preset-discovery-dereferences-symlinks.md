# Agent Note: Preset discovery dereferences symlinked directories

Status: implemented

English | [中文](2026-09-07-preset-discovery-dereferences-symlinks.zh.md)

## Problem

Moving a preset out of `<dshHome>/.agent-presets` into a version-controlled checkout and linking it back with `ln -s` made the preset vanish from the roster. `scanRoot` classified each child by its dirent kind, and dirent kinds carry lstat semantics, so the link reported `isSymbolicLink`, failed the `isDirectory()` test, and was skipped silently. The name still occupied its id on disk — `copy` refused it — while no surface showed anything to select or delete, and the preset came back only when the real directory was moved back in.

## Decision

`scanRoot` classifies an entry whose name passes `PRESET_ID` in two steps: a directory dirent is a row as before; a symlink is dereferenced once with `stat` and becomes a row exactly when its target is a directory, with its `path` joined through the root. A link to a file, or a dangling one, is skipped like the plain file of that name it effectively is. Trust still comes from the root the row was found under.

Everything downstream reads paths through the roster row. Health parses `agent.cordis.yml` through the link, so a linked directory without a composition is a broken row like a rooted directory without one; `preset.yml` metadata, the mount, and the composition stamp also read through it. `copy`'s occupancy check stats the target and refuses a link-occupied id. `remove` uses `lstat` to distinguish a link or Windows junction from a real directory, then unlinks the link instead of applying recursive removal; deleting the roster row cannot touch the checkout it points at.

## Alternatives considered

Realpathing every entry, the way the LSP workspace seam resolves aliases to one identity: the roster is addressed by id under a configured root, not by filesystem identity, and rewriting each row's path would move `remove`'s containment check (`preset.path` must sit under the writable root) off the root the deployment configured. Statting every child instead of reading dirent kinds: one syscall per non-directory child on a scan that `list()` reruns unmemoized on every call, to learn what the dirent already says for the common real-directory case. Reporting dangling links as broken rows, the ghost-directory treatment: that contract covers directories, and a plain file named like a preset id is already skipped — a dangling link is the same non-preset residue rather than damage to report; revisit if a real case appears.

## Consequences

- A preset can live anywhere on disk and be developed in a real checkout; the roster row, both pickers, the mount, and copy/delete all address it through the link.
- Deleting a linked preset removes the link and leaves the target's files — pinned by a test, because the target is usually the user's own version-controlled tree.
- Each symlinked entry costs one `stat` per scan, on a path already accepted to be unmemoized; entries that are neither directories nor symlinks cost nothing extra.
- Pinned by unit tests over a real temp tree (a linked preset discovered with its path through the root, health read through the link, non-directory links skipped, delete removing only the link) and by the web authoring lane, which links a preset from a real checkout into its user root and asserts the assembled section renders it like a rooted custom row.
