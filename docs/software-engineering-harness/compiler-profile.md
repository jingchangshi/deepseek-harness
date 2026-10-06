# Compiler Verification Profile

English | [中文](compiler-profile.zh.md)

The [compiler profile](../../.agent/profiles/compiler.yaml) defines logical checks for builds, lit or FileCheck tests, IR validation, legality, SSA and dominance, shapes, aliasing or bufferization, reference correctness, benchmarks, and profiling. The profile contains no project command.

## Project Adapters

A target repository supplies an argv adapter document with `executable`, `args`, optional `cwd`, and optional `platforms` for each supported check. `agentctl verify-profile` starts commands without a shell. A missing required adapter produces `NOT_RUN` and prevents acceptance.

## Scope

The adapter document carries target and mode matrices in `scope`. The runner preserves values such as `A5: PASS`, `A3: NOT_RUN`, `PureAIV: PASS`, and `MixCV: NOT_RUN` through verification and review. Optional checks can remain `NOT_RUN`; every required check must be `PASS`.

## Evidence

Each command records its argv, working directory, exit code, timeout state, and bounded output in `EVIDENCE.jsonl`. Nonzero exit and timeout are `FAIL`. Platform exclusions and absent adapters are `NOT_RUN`.

## Dev Note

None.
