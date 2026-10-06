# 冻结版工程 Harness 验收计划

[English](acceptance-plan.md) | 中文

本计划为[冻结版多模型软件工程 Harness](architecture.zh.md) 的每个实现阶段定义可证伪证据。只有全部 required check 都具有当前证据时，阶段才算完成；缺失、`NOT_RUN` 和 `INCOMPLETE` 均不代表成功。

## 摘要

验收组合 focused unit test、invalid-case test、mock model route、fake compiler 与 webapp repository、配置检查，以及单独调用的 real-provider smoke test。最终决定由 `agentctl accept` 根据 repository artifact 产生，绝不来自模型 prose。

## 目录

- [证据规则](#evidence-rules)
- [Stage A：架构](#stage-a-architecture)
- [Stage B：状态机](#stage-b-state-machine)
- [Stage C：固定 DSH profile](#stage-c-pinned-dsh-profile)
- [Stage D：模型路由](#stage-d-model-routing)
- [Stage E：orchestration](#stage-e-orchestration)
- [Stage F：verification profile](#stage-f-verification-profiles)
- [Stage G：失败与恢复](#stage-g-failure-and-recovery)
- [Stage H：AscendNPU-IR 集成](#stage-h-ascendnpu-ir-integration)
- [Stage I：冻结](#stage-i-freeze)
- [外部门槛](#external-gates)

-----

<a id="evidence-rules"></a>
## 证据规则

每个 machine check 记录 command、exit code、task revision 和 result artifact。通过的 narrow test 只证明其实际覆盖的行为。Real-provider check 与不需要 credential 的 automated test 分开。任何不可用的 external dependency 都记录为 `NOT_RUN` 并说明精确原因，且不能满足 required production check。

每个 validator 的 test suite 至少包含一个 valid fixture 和一个可到达 top-level command 的 invalid fixture。测试检查 public CLI behavior 和 committed artifact field，不能只调用 private helper。

<a id="stage-a-architecture"></a>
## Stage A：架构

| ID | 要求 | 证伪证据 | Required evidence |
|---|---|---|---|
| A1 | Runtime 精确固定 | tag、commit 或 manifest 不一致 | tag 与 commit 检查，以及 architecture 中的 freeze fact |
| A2 | DSH 假设来自固定源码 | 声称的 capability 缺失或不支持 | subagent、workflow、Ralph、goal、job、profile 与 reasoning 的 source link |
| A3 | DSH core 不变 | 计划实现修改已有 DSH runtime package | responsibility 与 placement review |
| A4 | Acceptance 是确定性的 | 模型可以直接写入 `ACCEPTED` | architecture review 与 Stage B negative test design |
| A5 | 每个后续要求都有 check | goal requirement 缺少 evidence owner | 本阶段完整 matrix |

<a id="stage-b-state-machine"></a>
## Stage B：状态机

| ID | 要求 | Required check |
|---|---|---|
| B1 | 所有 task artifact 均被验证 | valid 与 malformed document 的 schema unit test |
| B2 | Legal transition 成功 | table-driven transition test |
| B3 | Illegal 与 stale transition 失败 | invalid edge、stale revision 与 corrupt state 的 CLI test |
| B4 | Acceptance 是终态 | double-acceptance 与 post-acceptance mutation test |
| B5 | Repair count 有界 | 两轮 fix sequence 强制进入 `REPLAN` |
| B6 | 写入可从中断恢复 | fault-injection test 后最后完整 revision 仍可读 |
| B7 | CLI 跨平台 | unit test 只使用 Node filesystem/process API，不使用 shell command string |

<a id="stage-c-pinned-dsh-profile"></a>
## Stage C：固定 DSH profile

| ID | 要求 | Required check |
|---|---|---|
| C1 | 每个 delegated role 有一个固定工具 | `dsh --profile ... --dump-config` 检查 |
| C2 | 每个角色具有显式 route | configuration validator 拒绝缺失 provider、model、effort 或 token limit |
| C3 | 深度为一 | dumped in-process role tool 包含 `maxDepth: 1`，nested delegation 失败 |
| C4 | 默认并发为三 | workflow engine config 报告 `maxConcurrentAgents: 3`，orchestration admission 拒绝第四个 worker |
| C5 | 只有 implementer 可写 | role-policy test 拒绝其他角色取得 writer lease |
| C6 | Arbiter 可选 | 默认 orchestration trace 不包含 arbiter call |
| C7 | DSH package 不变 | diff check 排除已有 `packages/` runtime source |

<a id="stage-d-model-routing"></a>
## Stage D：模型路由

| ID | 要求 | Required check |
|---|---|---|
| D1 | Logical role 解析为 exact route | 覆盖所有角色的 table-driven route test |
| D2 | Unknown provider 或 model 失败 | child creation 之前的 mock catalog negative test |
| D3 | Unsupported effort 失败 | mock exact-model capability test |
| D4 | Expensive route 使用是显式的 | cost-class policy 拒绝未授权 role mapping |
| D5 | 普通 completion 与 tool use 可用 | credential-free mock provider smoke test |
| D6 | Subagent 与 background execution 可用 | 有界收集的 mock child 与 job smoke test |
| D7 | 所需 structured output 可用 | mock structured response validation |
| D8 | Cancellation 有界 | timeout test 观察到 child/job 终止及 terminal evidence |
| D9 | Actual route 可诊断 | smoke artifact 记录 provider、model、effort 与 evidence source |

<a id="stage-e-orchestration"></a>
## Stage E：orchestration

| ID | 要求 | Required check |
|---|---|---|
| E1 | Plain subagent 是正常路径 | architecture、implementation 与 review 的 scenario trace |
| E2 | Workflow 只用于 fan-out | validator 拒绝少于两个 independent branch 的 workflow stage |
| E3 | Ralph 必须显式请求 | default profile 保持 Ralph disabled，explicit overlay 启用它 |
| E4 | Goal 不是 repository authority | 没有 Goal Session 时 resume test 仍可重建 state |
| E5 | One writer 被执行 | concurrent writer-admission test 只授予一个 lease |
| E6 | Repository revision 绑定 output | stale subagent result 不能更新较新的 task revision |

<a id="stage-f-verification-profiles"></a>
## Stage F：verification profile

| ID | 要求 | Required check |
|---|---|---|
| F1 | 四种 result state 保持区分 | `PASS`、`FAIL`、`NOT_RUN` 与 `INCOMPLETE` 的 parser 与 acceptance test |
| F2 | Partial compiler scope 被保留 | mixed status 的 target/mode matrix fixture |
| F3 | Compiler command 是 adapter | synthetic repository config 提供所有 invoked command |
| F4 | Webapp category 可配置 | fake typecheck、unit、API/E2E 与 build command |
| F5 | Failed process 不是 pass | nonzero exit 与 timeout fixture |
| F6 | Compiler mock E2E 完整 | 完整 state path，包括一次 failed verification 与成功 bounded fix |
| F7 | Webapp mock E2E 完整 | 使用其 verification profile 的完整 state path |

<a id="stage-g-failure-and-recovery"></a>
## Stage G：失败与恢复

| ID | 要求 | Required check |
|---|---|---|
| G1 | Interrupted command 可恢复 | kill fixture 后执行 `status` 与 resume |
| G2 | Interrupted subagent 不推进 state | mock cancellation scenario |
| G3 | Missing 或 corrupt artifact fail closed | CLI end-to-end negative fixture |
| G4 | Reviewer 不能覆盖 check | `ACCEPT` review 加 failed verification 时被拒绝 |
| G5 | Bounded review repair 被执行 | 两次 `FIX_BOUNDED` 决定强制 `REPLAN` |
| G6 | Sensitive data policy 被执行 | disallowed route fixture 与 expired approval fixture |
| G7 | Secret 不被提交 | focused fixture scan 拒绝 credential value 并允许 reference |

<a id="stage-h-ascendnpu-ir-integration"></a>
## Stage H：AscendNPU-IR 集成

| ID | 要求 | Required check |
|---|---|---|
| H1 | 既有 command 保持权威 | adapter configuration 命名 project-owned build/test command |
| H2 | Result 结构化且带 scope | fixture 覆盖 build、test、IR verify/diff、reference、benchmark 与 profile category |
| H3 | 缺少 hardware 时显式报告 | device-dependent check 记录 target 及原因，并标为 `NOT_RUN` |
| H4 | 第一版集成保持有界 | design 不包含 custom compiler analysis engine |

<a id="stage-i-freeze"></a>
## Stage I：冻结

| ID | 要求 | Required check |
|---|---|---|
| I1 | Runtime 与 toolchain 已记录 | freeze manifest 对 tag、commit、Node、pnpm 与 lock hash 的验证 |
| I2 | Config 可复现 | fresh temporary Harness home 能解析 committed profile overlay |
| I3 | 文档与 command 一致 | final validation pass 执行每个 documented command |
| I4 | Upgrade 是显式过程 | upgrade guide 要求新 manifest 与完整 regression matrix |
| I5 | Automated check 通过 | focused unit、negative 与两个 fake E2E suite 通过 |
| I6 | Final acceptance 由机器推导 | `agentctl accept` 只在 complete accepted fixture 上成功 |

<a id="external-gates"></a>
## 外部门槛

Real-provider smoke test 需要 deployment-specific endpoint、model ID 和 credential。在这些信息可用前，final report 会把每条 route 标为 `NOT_RUN`，并说明缺少的 credential 或 deployment value。缺少所需 target 时，real Ascend device check 同样保持 `NOT_RUN`。这些结果不阻止 generic harness 的开发，但会阻止声称相应 production route 或 device target 已通过资格验证。

## 延伸阅读

- [架构](architecture.zh.md)
- [DSH provider 指南](../user/guide/providers.zh.md)
- [DSH 测试策略](../testing.zh.md)

## 开发备注

无。
