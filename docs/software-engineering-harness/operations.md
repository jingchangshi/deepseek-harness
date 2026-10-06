# Harness Operations

English | [中文](operations.zh.md)

Install the frozen engineering profiles once, then start DSH from a configured repository. The interactive profile accepts one natural-language development request and runs investigation, planning, implementation, verification, independent review, and deterministic acceptance without manual task commands.

## Install

Run the installer from the DSH harness branch; it checks the freeze before installing:

```sh
cd /home/shijingchang/workspace/deepseek-harness
node tools/agent/install.mjs --root /home/shijingchang/workspace/AscendNPU-IR-1 --preset ascendnpu-ir
```

The DSH branch's `.agent/` is the template source. The optional `--root` initializes the target repository; omitting it installs only the runtime and user deployment. The installer creates `engineering` and `engineering-run` below the current DSH home and installs `~/.local/bin/dsh`. Missing deployment configuration and personas are seeded under `<DSH_HOME>/engineering/.agent`; existing user edits are preserved. Installed profiles never contain the target repository path. The installer preserves `.agent/tasks/` and stores credential environment-variable names, not credential values.

Re-run the same command to update managed artifact schemas and user profiles. `.agent/dsh-template-installation.json` in the target repository and `engineering-installation.json` in DSH home record managed-file hashes. Repository policy edits are preserved, including files listed in a legacy marker. Profile upgrades preserve Cordis entries outside the fixed engineering composition. Conflicting edits to managed content are rejected. See [repository presets](repository-presets.md) for missing-only scaffolds, generic initialization, and preset identity.

Ensure `~/.local/bin` precedes other DSH installations in `PATH`. The launcher uses this frozen source checkout and preserves the caller's working directory.

## Daily Use

Start the Web UI in the target repository and enter the requirement as an ordinary message:

```sh
cd /home/shijingchang/workspace/AscendNPU-IR-1
dsh
```

Bare `dsh` selects the `engineering` profile. `dsh engineering` is equivalent. For a one-shot terminal run, use:

```sh
dsh engineering-run "<requirement>"
```

The Coordinator submits the request once to the engineering runtime. Two Scouts run concurrently, then an Architect and Challenger freeze the plan. One Implementer receives write tools, required adapter commands run outside model control, and a fresh Reviewer evaluates the result. Only the repository state engine can write `ACCEPTED`.

## Project Configuration

Session cwd selects the target repository's `.agent/config/project.yaml`, schemas, verification profiles, adapters, and task state. Model and role mappings, global data policy, workflow admission limits, and personas come only from the user deployment. Generic initialization supplies no commands: missing required adapters report `NOT_RUN`. The explicit [Ascend preset](ascend-integration.md) supplies the compiler commands; a missing, failed, or incomplete required check prevents acceptance.

Magpie providers require `DSH_MAGPIE_GATEWAY_URL` and reference the credential variable selected by `DSH_MAGPIE_API_KEY_ENV` (default `MAGPIE_API_KEY`) in `<DSH_HOME>/engineering/.agent/config/models.yaml`. Repository model declarations do not override this deployment. `agentctl run` and `smoke-models` read the same user deployment by default; `--deployment-root <directory>` explicitly selects another deployment directory. Set `DSH_MAGPIE_API_KEY_ENV=MAGPIE_API_KEY` or leave it unset; store the actual key in `MAGPIE_API_KEY`. The selector must contain an environment-variable name, never the key itself.

Configure the Magpie providers, optional company gateway, and exact role IDs from [model routing](model-routing.md). Installation seeds missing files but preserves user-owned deployment edits. Existing installations must update their route declarations using the [upgrade guide](../upgrade-guide/v0.2.1-alpha.1/engineering-model-routes/guide.md), restart the profile, and qualify primary and fallback routes with [real smoke tests](provider-smoke-tests.md).

## Recovery

Optional `taskId` fields in `engineering_run` and `engineering_status` treat an empty string as omitted; nonempty invalid identifiers are rejected before a run is claimed. `engineering_recover` requires a nonempty task identifier.

Start `dsh` again in the same repository and ask it to continue the returned task ID. The Coordinator reads status, then calls `engineering_run` with only that task ID. The runtime reads `.agent/tasks/<task-id>/STATE.json` and `AUTO.json` and resumes only from a committed state. A different requirement is a new task; it is not appended to a frozen plan.

Follow `nextAction` instead of retrying `engineering_run` unchanged. `WAIT_FOR_CURRENT_RUN` means wait and inspect status; `RECOVER` means explicit recovery and requires stop confirmation only when `requiresStopConfirmation` is `true`; `REPLAN_WITH_SCOPE` requires missing product information. A replayed tool invocation returns its saved result or a fail-closed interrupted claim, not a new workflow. New user requests receive distinct tool-call identities even when their text is identical.

Cancellation terminates local command process groups and waits for exit. A cancelled or timed-out Docker verification becomes `BLOCKED` because stopping the host `docker` client does not prove that the command inside an existing container stopped. An interrupted writer, an exhausted bounded run, and a worktree changed after verification also fail closed. Confirm that the previous agent and container command have ended; the Coordinator then calls `engineering_recover`, which releases any writer, enters `REPLAN`, and clears that run's step, role-call, and verification checkpoints under the run lock. The same task keeps its requirements and receives one new bounded run; recovery is never automatic.

## Diagnostics

`agentctl` remains available from the pinned checkout for inspecting artifacts and performing protocol-level maintenance. It is not part of the daily development path. Use `engineering_status` through the Coordinator or inspect `.agent/tasks/` before using low-level commands.

Provider smoke tests and Ascend device checks remain deployment qualification. The keyless real-composition test uses a private mock endpoint and proves profile loading, real subagent sessions, tool restrictions, command evidence, review, and acceptance without sending repository content externally.

Search spill notices advertise `spill_read`. Pass the locator unchanged to that tool; do not assume a `/tmp` path is readable through the repository filesystem. The [spill backend](../../packages/spill/spill-local/README.md) owns storage, bounded paging, and locator validation. Mixed permission failures are folded separately from other bounded search diagnostics.

## Dev Note

None.
