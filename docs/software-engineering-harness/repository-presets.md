# Repository Presets

English | [中文](repository-presets.zh.md)

This reference defines repository initialization, preset identity, and installation ownership for the [engineering architecture](architecture.md).

## Summary

A preset is a versioned repository scaffold, not runtime configuration or permanent installer ownership. Generic initialization contains no compiler-specific commands. Select a preset explicitly; changing repositories or adding a backend never requires a generic runtime branch.

## Table of Contents

- [Preset files](#preset-files)
- [Initialization](#initialization)
- [Ownership and identity](#ownership-and-identity)
- [Ascend preset](#ascend-preset)
- [Repository knowledge](#repository-knowledge)

## Preset files

`tools/agent/presets/<id>/preset.yaml` declares `schemaVersion: 1`, a lowercase profile-style `id`, a nonempty `version`, and a nonempty `files` list. A selector must match the declared ID. Paths are relative to the preset directory, below `.agent/config/`, `.agent/adapters/`, `.agent/profiles/`, or `.agent/scripts/`. Absolute paths, traversal, case-equivalent duplicate paths, symlinks, artifact schemas, deployment routing in any letter case, and role personas are rejected. Every listed file must exist before initialization writes any file.

The preset digest is SHA-256 over JSON containing its ID, version, and sorted pairs of relative path and file-content SHA-256. `.agent/preset.json` records the initial scaffold identity. Repository edits do not change that historical scaffold identity; task policy identity must hash the effective repository configuration separately.

## Initialization

`node tools/agent/agentctl.mjs init --root <repository>` installs missing generic templates. Add `--preset <id>` to select `tools/agent/presets/<id>/`. The installer accepts the same selector when `--root` is present. Preset files override generic templates before missing-file selection, so a fresh repository receives the selected project declaration directly.

Generic commands are intentionally unconfigured: required verification reports `NOT_RUN` until the repository supplies commands. Initialization never guesses a compiler, backend, container, user, build tree, or hardware target. Existing destination directories and files must resolve inside the selected repository before schema, marker, or policy writes. A different preset cannot replace an existing recorded preset implicitly; reconcile the repository configuration and initial identity explicitly.

## Ownership and identity

Artifact schemas are runtime-managed and retain strict installation-hash checks. Project configuration, profiles, adapters, and preset metadata are repository-owned: initialization and reinstallation preserve existing bytes, including changes made after an earlier installer recorded their hashes. Old policy entries in the installation marker do not grant overwrite authority.

The core freeze hashes runtime code and artifact schemas, not repository policies or preset files. Preset IDs, versions, and digests identify scaffold content independently. User provider routes and role instructions remain deployment-owned and are never copied into a repository preset.

## Ascend preset

The `ascendnpu-ir` preset contains the project declaration, compiler profile, verification policy, named container runner and repository-owned checks. Its container, user, build environment, `bishengir` commands, A5/A3 targets and PureAIV/MixCV statuses are repository data. Reconcile deployment values before execution; unexecuted hardware remains `NOT_RUN`. [Ascend integration](ascend-integration.md) owns build and IR validation details.

## Repository knowledge

Project configuration may declare a relative `knowledge` YAML file with `schemaVersion: 1`, `instructionFiles`, and `skillRoots`. All instruction files and skill roots must exist and resolve inside the repository. Each skill root discovers immediate child directories with `SKILL.md`; each discovered file must have YAML frontmatter containing a nonempty `name` and `description`. Duplicate skill names are rejected. Supporting directories without `SKILL.md` are not skills.

Every isolated role receives repository-relative instruction paths and a sorted skill catalog containing names, descriptions, and `SKILL.md` paths in `context.repositoryKnowledge`. It does not receive instruction bodies or skill bodies automatically. Roles read the task-relevant files using their ordinary read tools. The actual DSH child request logs this context with the other role input; domain expertise does not change fixed role identity or deployment personas.

## Dev Note

None.
