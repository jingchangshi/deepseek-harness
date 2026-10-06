---
kind: upgrade-guide
description: Engineering profiles use user deployment configuration instead of repository-bound Ascend profiles.
---
# Engineering Profiles

English | [中文](guide.zh.md)

## Change

The installer replaces `ascend` and `ascend-run` with `engineering` and `engineering-run`. Deployment configuration comes from `<DSH_HOME>/engineering/.agent`; Session cwd selects repository policy and tasks. Plugin `configRoot` becomes `deploymentRoot`.

`agentctl run` and `smoke-models` use the user deployment by default, rather than repository model declarations. Direct automatic-driver callers supply the validated `deployment` snapshot used by their role executor, rather than relying on repository routing files.

Task creation requires `.agent/profiles/<id>.yaml`. Profile IDs are repository-defined lowercase ASCII strings, not an enum. Existing IDs remain supported.

Generic initialization does not install Ascend commands. Repository scaffolds preserve edits across reinstallation; artifact schemas remain runtime-managed.

Remote wrappers must select an explicit runner. Commands require OS-owned Linux containment; unsupported hosts return `NOT_RUN` without starting them.

New `PLAN.json`, `REVIEW.json`, and `DECISION.json` writes use schema version 2; `VERIFY.json` writes use version 3. They bind verification attempts to source content, repository policy, profile inputs and cumulative required instances. Predecessor schemas remain readable but cannot authorize acceptance. Checks retain `category` and JSON `scope`; execution results are an instance array, not a name-keyed map.

Direct callers use `beginVerification`, capture `verificationIdentity` and `verificationGates`, run commands with that identity, append `verificationEvidence` with the dispatch state revision, then call `finishVerification`. Evidence is never rebound to a later attempt. `verify-profile --project-config` must match the repository adapter. Source, policy or profile changes invalidate acceptance, regardless of reviewer approval.

## Migration

1. Run `node tools/agent/install.mjs` from the harness checkout to install the new profiles. Use `--home` and `--bin-dir` for nondefault user destinations; `--root` is optional and initializes a repository.
2. Copy any customized `models.yaml`, `roles.yaml`, `workflow.yaml`, and `data-policy.yaml` from the previous deployment's `.agent/config` into `<DSH_HOME>/engineering/.agent/config`. Copy customized personas into `<DSH_HOME>/engineering/.agent/roles`. Keep project declarations, adapters, profiles, and task artifacts in their repositories. Never commit credentials.
3. Replace manually configured `engineering-bootstrap` or `engineering-harness` plugin `configRoot` with `deploymentRoot`, pointing to `<DSH_HOME>/engineering`. Restart the profile after changing deployment routes.
4. Run `dsh engineering` or `dsh engineering-run "request"` from each repository. Select another deployment with `--deployment-root <directory>` on `agentctl run` or `smoke-models`.
5. Refresh installer-owned task schemas with `node tools/agent/install.mjs --root <repository>`. Initialization only adds missing files. Back up unowned or edited schemas and explicitly reconcile them with the checkout; the installer refuses to replace them. Install `.agent/profiles/<id>.yaml` with a matching `id`, including for metadata-only callers. Restart schema readers. Do not rewrite task metadata.
6. For a fresh AscendNPU-IR repository, add `--preset ascendnpu-ir` to the installer with `--root`, or to `agentctl init`. Existing project declarations and adapters are preserved. Generic repositories must configure their required commands; otherwise verification remains `NOT_RUN`. See [repository presets](../../../software-engineering-harness/repository-presets.md) for ownership and scaffold identity.
7. Install successor `plan-v2`, `verification-v2`, `verification-v3`, `review-v2`, and `decision-v2` schemas without replacing predecessors. Explicitly replan and reverify pending tasks that lack source and policy bindings. See [scoped verification](../../../software-engineering-harness/scoped-verification.md) and [verification policy](../../../software-engineering-harness/verification-policy-design.md).
