# TileLang Integration

English | [中文](tilelang-integration.zh.md)

This reference defines the `tilelang` [repository preset](repository-presets.md).

## Summary

Use this preset to check Python syntax, build native libraries, and verify backend registration, semantics, and source-only IR lowering. Development checks do not require a target device. Hardware qualification requires a separately configured command.

## Table of Contents

- [Knowledge sources](#knowledge-sources)
- [Environment](#environment)
- [Verification commands](#verification-commands)
- [Acceptance tiers](#acceptance-tiers)

<a id="knowledge-sources"></a>
## Knowledge sources

The preset points to `CONTRIBUTING.md`, `tilelang/backend/README.md`, `tilelang/ascend/README.md`, and `.agents/skills`. Roles read build, backend, semantic, IR, and other repository skills as needed. Backend names and compiler stages are repository data, not runtime enums.

<a id="environment"></a>
## Environment

The [command configuration](../../tools/agent/presets/tilelang/.agent/config/commands.yaml) uses a local runner for syntax and a named Docker runner for native checks. Docker uses `/usr/bin/docker`, container `s00653124_build`, user `shijingchang`, home `/home/shijingchang`, and `workingDirectory: '{{PROJECT_ROOT}}'`. The container must see the selected checkout at the same absolute path.

Edit runner fields and `env.set` for the deployment. `DSH_BUILD_DIR` and `DSH_VENV_DIR` accept project-relative or absolute paths; their defaults are `build` and `.venv`. `DSH_CANN_ENV`, `DSH_CONDA_SH`, and `DSH_CONDA_ENV` select CANN and Conda setup. Python needs the declared dependencies; the build needs an existing CMake configuration and initialized dependencies.

For hardware-independent checks, configure CPU and Ascend stubs without CUDA, ROCm, Metal, or LLVM native code generation. With the validated GCC 8 standard library, configure `-DCMAKE_CXX_STANDARD_LIBRARIES=-lstdc++fs`. The wrapper uses the existing build configuration; it does not configure a new build or install dependencies.

Native commands pass argv to a fixed [shell wrapper](../../tools/agent/presets/tilelang/.agent/scripts/tilelang.sh), not a shell `-lc` string. Explicit `env.set` and `env.inherit` declarations control environment values. Both wrappers appear in `inputs`, so the verification-policy digest includes their bytes.

<a id="verification-commands"></a>
## Verification commands

`source-syntax` parses Python files without importing TileLang. `build` compiles native libraries and import-required extensions. Parallelism and the 1,800-second default timeout are configurable; the wrapper reports disk space before building. `backend-context` checks registration and scheduling options; `semantic-regression` checks parallel races and buffer initialization.

The [Python wrapper](../../tools/agent/presets/tilelang/.agent/scripts/tilelang-check.py) creates import links inside the selected build directory and verifies the loaded native-library path. This supports an external build without changing the checkout. `ir-verify` checks simplification, Ascend thread synchronization, CPU BF16 lowering, and vectorized CPU source generation. Its source-only testcase enters `tvm.target.Target('c')`, disables host codegen and device compilation, and logs input IR and generated C source. It does not launch a kernel.

Pytest reports skipped GPU cases separately from executed tests. Syntax success does not establish native or hardware correctness. Optional Ascend source, compile-speed, and hardware commands remain unconfigured; they require task-specific toolchains, cache conditions, or devices.

<a id="acceptance-tiers"></a>
## Acceptance tiers

The [verification policy](../../tools/agent/presets/tilelang/.agent/config/verification-policy.yaml) defaults to `development`, which requires syntax, build, backend, semantic, and IR checks. `presubmit` retains these requirements. `qualification` also requires `hardware-runtime`; the preset leaves that command unconfigured.

Hardware is not required at `development`. At `qualification`, the missing command remains `NOT_RUN` and prevents acceptance. Owners must supply a command and explicit target scope before hardware qualification. Native evidence and portable harness-fixture results are separate records.

## Dev Note

Independent native validation on 2026-10-06 used a source copy and build under container `/tmp/ir-validation-20261006/tilelang-src`, with a separate temporary venv. AST parsing covered 403 Python files. CPU/Ascend-stub native builds and source-only CPU codegen completed; focused pytest reported 132 passed and 5 GPU-runtime skips. The GCC 8 link required `-lstdc++fs`. These results are independent native evidence, not executions of the default preset. No device or real-model smoke ran, and the temporary paths are not preset defaults.
