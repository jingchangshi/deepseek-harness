---
kind: reference
description: Named command providers, explicit environments, typed argv and termination evidence.
---
# Command Runners

English | [中文](command-runners.zh.md)

## Summary

Repository command configuration selects local or Docker execution. The runner reports command status and termination certainty separately. The automatic workflow blocks uncertain termination before review or acceptance. SSH and remote providers are unsupported.

## Table of Contents

- [Configuration](#configuration)
- [Environment and arguments](#environment-and-arguments)
- [Termination and recovery](#termination-and-recovery)

## Configuration

The repository project names its command configuration through `adapter`. That file declares either `commands` or the legacy `adapters` map, never both. A command's `runner` selects a named declaration from `runners`. Missing names and unknown configuration fields fail loading. A named runner owns the working directory; its commands cannot also declare `cwd`.

Verification consumes a repository-owned execution snapshot containing validated commands, effective gates, frozen arguments, and bound identity. Before each command starts, the driver checks current adapter, policy, profile, and plan bindings; drift starts no subsequent command and requires explicit replanning. It checks the same binding again before publishing command evidence. A change during execution can leave diagnostics but cannot publish authoritative passing evidence.

```yaml
schemaVersion: 1
runners:
  source:
    kind: local
    workingDirectory: .
commands:
  source-check:
    runner: source
    executable: node
    args: [-e, "process.exit(0)"]
    env:
      set: {}
      inherit: [PATH]
    terminationTimeoutMs: 30000
    outputLimitBytes: 16384
inputs: []
selectedTests: []
```

Docker declarations require an absolute executable path, container, user, home and container working directory. The working directory can be the exact `{{PROJECT_ROOT}}` token. The host working directory is the selected repository. Docker target environment assignments become individual `--env` arguments; commands are not parsed as shell strings. Repository-owned wrapper scripts can initialize CANN or Conda. Declare such scripts in `inputs` so their bytes and resolved locations invalidate stale policy evidence.

Legacy commands without `runner` resolve explicitly to local execution. They inherit available path, home and temporary-directory variables, not credentials. They retain the 16384-byte output limit; termination confirmation uses the gate timeout unless configured separately. Remote wrappers must migrate to an explicit provider declaration. The engine does not infer providers from executable names.

## Environment and arguments

An explicit environment has `set` and `inherit`. Missing inherited variables, unknown fields, duplicate names and secret-bearing names are rejected. Docker HOME comes from its runner declaration. The resolved environment, provider, executable, argv and cwd participate in command evidence identity.

`{{PROJECT_ROOT}}` and `{{BASE_REVISION}}` expand to one argument. `{{CHANGED_FILES}}` and `{{SELECTED_TESTS}}` expand to separate arguments, including zero arguments for an empty list. Tokens must occupy whole arguments. Unknown or embedded tokens fail. A baseline token without a Git revision fails. Changed files come from the sealed source comparison; selected tests come from repository command configuration.

## Termination and recovery

On Linux, execution uses the maintained subprocess provider's OS-owned systemd scope. After the direct process exits, the runner terminates the same managed range and confirms it is empty, including detached or reparented descendants. Without native containment, no command starts and the result is `NOT_RUN`; process-group observation is not a fallback. Docker cancellation or timeout returns `UNCERTAIN` even when its host driver has exited. Uncertain termination enters `BLOCKED`; an operator must confirm stopped writes before explicit recovery. Neither reviewer approval nor exit code zero substitutes for confirmation.

## Dev Note

None.
