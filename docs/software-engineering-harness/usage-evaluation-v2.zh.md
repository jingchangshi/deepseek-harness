# V2 用量核算与评估设计

[English](usage-evaluation-v2.md) | 中文

## 概述

本参考文档说明 Phase 4 的实际 provider 用量核算和可复现工程评估。设计评审和独立源码评审已批准；聚焦实现检查通过，在线对比质量为 PARTIAL。脱敏记录见下方链接和验证报告。合成 fixture 不能证明模型节省；没有可信的部署估算时，provider 费用为未知。

## 目录

- [实际 request 用量](#actual-request-usage)
- [用量报告和估算](#usage-reports-and-estimates)
- [可复现评估](#reproducible-evaluation)
- [执行与验收](#execution-and-acceptance)

-----

<a id="actual-request-usage"></a>
## 实际 request 用量

`lifecycle.ts` 中的 `TaskLifecycle` 使用 adapter dispatch 前预留的 request ID 结算 provider request。预留状态为 `ADMITTED`；调用 adapter 后变为 `DISPATCHED` 并等待结算。结算持久化 repository clock 的准确开始/结束时间戳、结果（`SUCCESS`、`FAILED`、`ABORTED` 或 `INTERRUPTED`）及原始 `TokenUsage` 字段。缺少结算、usage 对象或权威总量时均记为 `UNKNOWN`；历史记录不表示用量为零。同一 request ID 收到相同结算时保持幂等；结算冲突则拒绝。Runtime 为每个已 dispatch 的 request 结算，包括失败和未返回 usage 的响应。只有所属 lifecycle 能结算带 brand 的 request ID 和 attempt ID。

`TaskLifecycle.settleProviderRequest(requestId, settlement)` 接收 `{ startedAt, endedAt, outcome, usage? }` 并记录 provider 结果；`usageReport()` 返回 task 报告。`settleAttempt(attemptId, settlement)` 在 executor 销毁并完成 schema 验证后记录 child 结果，结果为 `SUCCESS`、`FAILED`、`CAPABILITY_INSUFFICIENT` 或 `UNCERTAIN`。Attempt 结算不能抹去 provider stream 结果；二者与 role 的语义验收分别记录。只有调用方记录了 adapter 确实未被调用的权威证据，才可将中止记为 `ABORTED_BEFORE_DISPATCH`；此状态没有已知用量，也不计入 provider 失败率。已 dispatch 但缺少 post-dispatch 结算的 request 在迟到结算或显式恢复前保持 `UNKNOWN_DISPATCH`。其用量和费用未知，并与已测得的 provider 失败分开计数。Adapter 无法观察 SDK 内部 retry 的独立 dispatch，因此这些 retry 不计为独立 request。Compaction 保留单独的 request purpose。Session 回放不调用 provider，也不能重复计费。Session usage event 仅通过 `requestId` 和 `sessionId` 提供辅助对账链接；它不能结算缺失的 adapter usage，也不能产生第二笔费用。对账不一致时保留审计记录且结果为未知。报告读取不能修改核算状态。

Adapter 用量标准化会单独记录 `cacheOmission: 'zero' | 'unsupported' | 'unknown'`，不与价格混为一谈。pi-ai adapter 声明 `zero`，因此省略的 cache 计数按已知零处理；其他 adapter 若未明确声明不支持某一类别，则默认 `unknown`。明确上报的零是已知零。Adapter 提供的 `totalTokens` 是唯一权威总量，不从组件字段重算。

<a id="usage-reports-and-estimates"></a>
## 用量报告和估算

每条用量记录包含 task、workflow、role、provider、model、route、logical invocation、attempt、request、purpose、可选 Session ID、原始 usage、标准化总量、时间区间、结果和 cost 状态。报告汇总实际 request、逻辑调用、attempt、失败、中止、compaction、token 总量、用量未知的 request 数、cache 原始小计，以及按 role/provider/model 的明细。只有每个实际 request 都提供权威 `totalTokens` 时，token 总量才是已知。保留 input、output、cache-read、cache-write 和 reasoning 原始计数；不得把 cache 计数加到 provider 总量。

分别报告 request 时长之和、provider 活动时间和 task 端到端时长。Provider 活动时间是已结算 request 时间区间的并集；request 时长之和是区间时长的算术和。持久化 `admittedAt` 和终态 `finishedAt`。初次准入 `RUNNING` 和每次恢复都会开始运行区间；`BLOCKED` 和 `BUDGET_EXHAUSTED` 会关闭区间，但不结束 task。Repository 先写终态 `STATE.updatedAt`，再将该时间戳复制到 lifecycle ledger。两个文件不属于同一事务；若时间写入缺失或中断，task 时长为 `UNKNOWN`。恢复时不得在生成报告时补造结束时间。累计端到端时长包含持久化的运行区间和暂停时长。不得把早先的 blocked 结束时间当作验收完成时间。`wallTimeMs` 根据持久化 request 时间戳计算；区间无效或时钟倒退时结果为 `UNKNOWN`，保留原始时间戳且绝不产生负时长。估算费用与实际账单金额分开；没有账单数据时，实际金额为 `UNKNOWN`。

部署定价配置可选且须验证，可包含 `currency: 'USD'`、来源、验证时间、每百万 token 的 input/output 单价、可选 cache-read/cache-write 单价，以及 `inputAccounting: 'aggregate' | 'exclusive'` 和 `cacheAccounting: 'reported' | 'not-supported'`。Request 预留时保存稳定的定价版本或 digest，后续配置变更不得重新计算历史费用。部署元数据只代表部署方的声明，不等同于独立核验 provider 定价。Aggregate input 核算时，可计费 input 为 `inputTokens - cacheReadTokens - cacheWriteTokens`；结果为负或缺少必要字段时 cost 未知。Exclusive 核算时，分别按 input 和已报告的 cache 类别计价。省略的 cache 字段仅能根据 adapter metadata 处理为零、不支持或未知；价格配置不能推断这一语义。缺少费率、不支持的 usage 类别、无效/未来验证时间或不一致的 cache 核算会使费用为 `{ status: 'UNKNOWN' }` 或导致配置拒绝。只有支持的 usage 和费率均完整时，费用才为 `{ status: 'ESTIMATED', usd, pricingDigest }`；不得称为实际账单金额。在线实验只有在官方费率已核实后才能使用价格。不得在交付版本中编造价格。`maxKnownCostUsd` 只使用已配置的估算；request 成本未知时 fail closed。

<a id="reproducible-evaluation"></a>
## 可复现评估

由 `tools/agent/src/benchmark.ts` 负责，评审后的 fixture 放在 `tools/agent/tests/fixtures/evaluation`。这套评估不得放入禁止网络访问的性能 gate 目录 `benchmarks/`。四种策略按部署配置的 route ID 选择：强单 Agent（A）、低成本单 Agent（B）、固定多 Agent（C）和自适应 V2（D）。对于实现 fixture，A 和 B 各执行一次可修改仓库的实现调用，再使用相同的 verifier 和 oracle；二者只在配置的强/低成本 route 上不同。C 固定依次运行 Scout、Architect、Challenger、Implementer、Verification、Reviewer；D 使用 `runEngineeringTask`。Review fixture 中所有策略保持只读：A 和 B 各调用一次 reviewer；C 依次运行只读 Scout、Architect、Challenger、Verification、Reviewer；D 使用 `runEngineeringReview`。所有策略都会收到相同的不可变 request、验收 criteria、allowed paths、command profile 和命名故障注入。Direct A/B/C 的 role context 携带这些 manifest 字段；Development fixture 配置将相同 scope 和 criteria 提供给 D 的 automatic classifier。现有风险下限仍控制 D 选择的阶段。

每种在线实现策略都在独立的 fixture clone 中，通过 harness 拥有的空闲 AgentHandle 在规范 fixture cwd 下运行。保留原始 coordinator delegation depth、preset 和 policy；不得 prompt carrier。A 和 B 使用 supervisor 生成的有界 Simple plan，并参考正常 workflow。C 使用 supervisor 冻结的、已验收 Architect plan。Development 使用真实 TaskRepository 和 Writer Token；只有 supervisor 持有 Writer Token。验证使用配置的 `runVerificationProfile` 和其身份绑定 artifact，然后运行独立 fixture oracle。Role execution 断言 Session cwd 与 invocation root 一致。Fixture teardown 或释放 writer 前必须等待 executor disposal；无法确定进程已静止时保留 lease。Review 继续只使用不可变 Git evidence，不创建 Development task state。

每个策略的用量包含其 lifecycle 记录的 provider 和 compaction request，也包括 child role 的 request。调用 `engineering_evaluate` 的外层 evaluation-driver Coordinator request 属于共享 orchestration overhead：将其排除在各策略总量之外并标记为未归属，不能记为零。空闲 fixture carrier 不会发起 provider request。策略 `wallTimeMs` 从 fixture 开始执行时计时，不包括 CLI 启动和外层 Coordinator 调用。这些报告不能证明整个进程的账单总额；全进程成本仍为 `UNKNOWN`。

四个不可变 Git fixture 分别是：编译器功能/设计任务 `pebble-mul`，由 `node tools/agent/tests/fixtures/evaluation/pebble/check.mjs` 检查；MLIR pass 改写回归 `mlir-pass`，由固定版本 `mlir-opt` 和 grammar oracle 检查；固定 Review 任务 `review-overflow`，包含引入缺陷与干净 commit，并要求 finding path、SHA 和行号；以及确定性失败恢复 `recovery-latch`，包含首次尝试失败和最终源码 oracle。每个 fixture 固定 seed Git SHA 和源码 digest、request 和 criteria digest、命令配置、oracle、允许修改范围及执行/故障注入清单。清单包含分类策略和模型 route 配置，并移除凭据。Oracle 不接受模型自称成功作为证据。运行使用隔离的临时仓库、确定性初始化和已等待完成的清理。每次运行都记录 seed 和重复编号。

Review oracle 只接受持久化的完整结果、固定 target、通过验证的缺陷和干净 control，以及针对 `add.mjs` 的 finding，且 `startLine` 和 `endLine` 必须都等于 2；还要求观测到的 target-path citation、覆盖第 2 行的 source-show evidence 和 target diff evidence。诊断会分别报告布尔检查，并单独报告有效行区间是否包含第 2 行；包含性诊断不影响验收。Failure condition 检查查找字面字符串 `2147483647` 和 `1`；它们不能证明文本在语义上正确解释了有符号溢出。

`recovery-latch` fixture 仅在 fixture ID 为 `fail-first-implementer-before-write` 的 `InjectedBeforeWriteFailure` 下允许同一 task 恢复一次。恢复前必须确认 stop 已发生、`BLOCKED` receipt 已持久化、没有活动 writer 或未完成的 stop request，且本次未被 abort。普通 provider、role 和 review failure 不会触发恢复；一次恢复后的 failure 不会重试。保留不确定的 workspace 供诊断。

`runEngineeringBenchmark({ cases, strategies, executor, oracle, now? })` 返回 `OFFLINE_SYNTHETIC` 或 `LIVE_PROVIDER` 报告，内容包括运行条件、case digest、策略、结果和汇总。每项结果包含状态（`ACCEPTED`、`REJECTED`、`BLOCKED`、`BUDGET_EXHAUSTED`、`UNCERTAIN` 或 `NOT_RUN`）、`firstImplementationPass`、wall time、usage、provider failure rate、fallback 和 escalation 数、人工介入数（未观测时为 `UNKNOWN`）及 oracle 证据。`firstImplementationPass` 记录首次实现尝试是否通过独立 oracle。即使后续 repair 成功，首次失败仍为 `false`；证据缺失或不完整时为 `UNKNOWN`。Provider failure rate 报告已 dispatch request 的可确认失败，并单独报告 `unknownDispatchCount`；未知 dispatch 既不算已测量失败，也不算已知成功。人工介入需要持久化 receipt；缺少 receipt 时为 `UNKNOWN`。每个成功任务的 token 和 cost 包含该任务的全部工作量；任一相关 request 不完整时结果为 `UNKNOWN`。零成功时指标未定义/为 `UNKNOWN`。缺少的策略或 case 不能算作通过。损坏输出、错误源码范围、伪造 review finding 和执行失败等负向控制必须被 oracle 拒绝。

<a id="execution-and-acceptance"></a>
## 执行与验收

离线测试使用 scripted role 执行生产 workflow，并运行真实 Git/命令 oracle。其 token 数值为合成数据，不能证明模型节省。在线评估使用受支持的 `dsh` headless profile、engineering 仓库 overlay 和真实 provider adapter，可通过 `dsh --profile headless --patch <engineering-overlay> <request>` 或已发布的 `engineering-run` profile 启动。不得使用自定义 app launcher。至少一个可用 provider 必须在 task ledger 中持久化非零原始 usage 和结果。Provider 可用时，至少在一个有界 fixture 上尝试四种策略，并分别报告连接失败、任务验收和策略比较。若编译器、MLIR 或 Review 在线用例因外部、时间或资源限制无法运行，可记录为 partial 或 `NOT_RUN`。脱敏运行记录和各策略 usage 见[机器可读证据报告](evaluation-evidence-v2.json)。[验证报告](verification-report-v2.zh.md)记录在线结果。原始最新 Review 运行中的 A_STRONG 通过验收；语义重试则在隔离备用部署下使 D 通过，其 `scout-secondary` 和 `challenger` 的 `worker-secondary` 路由被改为 `worker`，角色 snapshot 和 freeze manifest 未改变。默认部署仍未验证，这些结果不能证明策略节省。估算费用和实际账单金额均为 UNKNOWN。

原始 provider 日志和 Session 保留在 Git 之外；仅发布已脱敏的元数据和汇总用量，并明确标示未知费率。Phase 4 验收要求持久化核算、回放和恢复控制、所有 fixture 的独立 oracle、准确报告未知值，以及诚实的在线 provider 证据。设计已冻结。持久化 ledger、独立 fixture 和聚焦检查已实现。原始 Review 运行中 A_STRONG 通过；一次语义重试在隔离的备用部署下使 D 通过。HY4 完整 MLIR 运行中 A/B 通过；C 的源码和 LLVM 语法 oracle 通过，但整体结果为 REJECTED，具体原因未知。D 在 300 秒超时后被阻断；GLM fallback 尝试在 provider dispatch 前失败，原因 UNKNOWN；Qwen fallback 未尝试。七个配置的 Responses role smoke 和两个 fallback role smoke 均通过，但 structured-output 检查为 NOT_RUN。另一项 600 秒 Responses MLIR 尝试在 2400 秒 CLI 时限处超时，之后从磁盘恢复完整报告为 run 12：A 通过，B 因修改工具已 dispatch 但无 structured output 而被阻断，C 虽通过源码和 grammar oracle 仍被拒绝，D 被阻断且有一个未知 request 总量；完整评测目标未通过。Run 13 使用旧 persona：A/B 在写入前停止，C 被拒绝，D 虽被阻断但 oracle 接受了源码修改；这不代表恢复最终验收。命名的写入前恢复保护在两个 RED 后通过五个聚焦用例，独立安全评审已批准。更广的默认 automatic run 超时，因此不声称整个测试套件通过。Fixed-persona 恢复尝试首次因 provider overload 在外层 coordinator 中失败，evaluation tool 未运行；报告更新时重试仍在运行，尚无结果。这些运行不是受控策略对比。默认部署仍未验证，不能据此证明策略节省。估算费用和实际账单金额均为 UNKNOWN。
