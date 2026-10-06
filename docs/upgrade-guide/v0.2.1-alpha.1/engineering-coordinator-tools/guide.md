---
kind: upgrade-guide
description: The engineering profiles stop composing the generic subagent tool, and the Coordinator gains the goal tools.
---
# Engineering Coordinator Tools

English | [中文](guide.zh.md)

## Change

Before this release the installed `engineering` and `engineering-run` profiles composed the Web bundle's standard preset unchanged, so the Coordinator and every dispatched role were offered the generic `subagent` tool even though the workflow guard rejected its use. Profiles now install a generated preset that omits the delegation group.

The Coordinator tool list also gains `get_goal` and `update_goal`, which the workflow already listed. A coordinator that previously could not read or update its Session goal can now do both.

## Migration

1. Reinstall the user profiles so the generated preset replaces the profile patch: `node tools/agent/install.mjs`.
2. Confirm `$DSH_HOME/profiles/engineering/cordis.patch.yml` has a top-level `preset-standard` row whose `config.plugins` list contains no `delegation` entry.
3. Confirm a coordinator Session lists `engineering_run`, `engineering_status`, `engineering_recover`, `get_goal`, and `update_goal`, and no `subagent`.
4. A deployment that must let its coordinator delegate outside the workflow cannot use these profiles; they are coordinator-only by design.
