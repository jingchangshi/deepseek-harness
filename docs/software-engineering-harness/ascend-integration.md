# AscendNPU-IR Integration

English | [中文](ascend-integration.zh.md)

This reference defines the `ascendnpu-ir` [repository preset](repository-presets.md).

## Summary

Use this preset to build two compiler tools and check focused IR transformations without a target device. Select a higher acceptance tier for reference regression or hardware qualification.

## Table of Contents

- [Environment](#environment)
- [Verification commands](#verification-commands)
- [Acceptance tiers](#acceptance-tiers)

<a id="environment"></a>
## Environment

The [command configuration](../../tools/agent/presets/ascendnpu-ir/.agent/config/commands.yaml) declares a named Docker runner. It uses `/usr/bin/docker`, container `s00653124_build`, user `shijingchang`, and home `/home/shijingchang`. Its `workingDirectory: '{{PROJECT_ROOT}}'` uses the selected checkout. The container must see that checkout at the same absolute path.

Edit the runner fields and `env.set` for the deployment. `DSH_BUILD_DIR` accepts a project-relative or absolute build path. `DSH_CANN_ENV`, `DSH_CONDA_SH`, and `DSH_CONDA_ENV` select CANN and Conda setup. The preset requires an existing CMake build; it does not install dependencies or apply source patches.

Commands pass argv to a fixed [shell wrapper](../../tools/agent/presets/ascendnpu-ir/.agent/scripts/ascend.sh), not a shell `-lc` string. Explicit `env.set` and `env.inherit` declarations control environment values. Both wrappers appear in `inputs`, so the verification-policy digest includes their bytes.

<a id="verification-commands"></a>
## Verification commands

`build` incrementally compiles `bishengir-opt` and `bishengir-compile`. Parallelism and the 1,800-second default timeout are configurable. The wrapper reports disk space before building. `unit` checks the three case-distinct HIVM RegBase directories; `ir-verify` checks HIVM single-point, pipeline, and bufferization behavior plus the compiler command line.

The [lit wrapper](../../tools/agent/presets/ascendnpu-ir/.agent/scripts/ascend-lit.py) maps the source test configuration to a temporary site configuration. It uses tools and outputs from `DSH_BUILD_DIR`, including a relocated build. It does not assume the checkout's `build/bin` path.

`reference` runs `check-bishengir`. Lit reports executed and unsupported tests separately; exit success does not establish coverage for unsupported tests. Unconfigured IR-diff, benchmark, profiling, and hardware commands retain `NOT_RUN`.

<a id="acceptance-tiers"></a>
## Acceptance tiers

The [verification policy](../../tools/agent/presets/ascendnpu-ir/.agent/config/verification-policy.yaml) defaults to `development`, which requires build, focused unit checks, and IR verification. `presubmit` adds reference regression. `qualification` also requires `hardware-runtime`.

Hardware is not required at `development`. The preset leaves the hardware command unconfigured: at `qualification`, it remains `NOT_RUN` and prevents acceptance. Owners must supply a command and declare tested targets and modes. A5, A3, PureAIV, and MixCV remain separate repository scope values.

## Dev Note

Independent native validation on 2026-10-06 used container `/tmp/ir-validation-20261006/ascend-build`, copied from the existing build. Both modified C++ files and the two tools compiled. Focused lit discovered 47 tests: 36 passed and 11 required an unregistered `regbase` feature. The added single-point cleanup test executed both pipelines, diff, and FileCheck; baseline and candidate IR were identical. These results are independent native evidence, not executions of the default preset. No device qualification ran, and the temporary path is not a preset default.
