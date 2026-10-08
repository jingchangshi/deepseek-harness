# V2 用量核算与评估设计

[English](usage-evaluation-v2.md) | 中文

## 概述

本参考文档定义 Phase 4 的 `DESIGN_FROZEN` 设计，内容涵盖实际 provider 用量核算和可复现工程评估。设计评审已批准；尚未开始实现或验证。合成 fixture 不能证明模型节省；除非有可信的部署估算，否则 provider 费用仍为未知。

## 目录

- [实际 request 用量](#actual-request-usage)
- [用量报告和估算](#usage-reports-and-estimates)
- [可复现评估](#reproducible-evaluation)
- [执行与验收](#execution-and-acceptance)

-----

<a id="actual-request-usage"></a>
## 实际 request 用量

扩展 `lifecycle.ts` 中的 `TaskLifecycle`，让 provider request 结算使用 adapter dispatch 前已预留的 request ID。预留状态为 `ADMITTED`；调用 adapter 后变为 `DISPATCHED` 并等待结算。使用 repository clock 持久化准确的开始/结束时间戳、结果（`SUCCESS`、`FAILED`、`ABORTED` 或 `INTERRUPTED`）以及原始 `TokenUsage` 字段。缺少结算、usage 对象或权威总量时均记为 `UNKNOWN`；历史记录不表示用量为零。同一 request ID 收到相同结算时保持幂等；结算冲突则拒绝。Runtime 为每个已 dispatch 的 request 结算，包括失败和未返回 usage 的响应。只有所属 lifecycle 能结算带 brand 的 request ID 和 attempt ID。

`TaskLifecycle.settleProviderRequest(requestId, settlement)` 接收 `{ startedAt, endedAt, outcome, usage? }` 并记录 provider 结果；`usageReport()` 返回 task 报告。`settleAttempt(attemptId, settlement)` 在 executor 销毁并完成 schema 验证后记录 child 结果，结果为 `SUCCESS`、`FAILED`、`CAPABILITY_INSUFFICIENT` 或 `UNCERTAIN`。Attempt 结算不能抹去 provider stream 结果；二者与 role 的语义验收分别记录。只有调用方记录了 adapter 确实未被调用的权威证据，才可将中止记为 `ABORTED_BEFORE_DISPATCH`；此状态没有已知用量，也不计入 provider 失败率。已 dispatch 但缺少 post-dispatch 结算的 request 在迟到结算或显式恢复前保持 `UNKNOWN_DISPATCH`。其用量和费用未知，并与已测得的 provider 失败分开计数。Adapter 无法观察 SDK 内部 retry 的独立 dispatch，因此这些 retry 不计为独立 request。Compaction 保留单独的 request purpose。Session 回放不调用 provider，也不能重复计费。Session usage event 仅通过 `requestId` 和 `sessionId` 提供辅助对账链接；它不能结算缺失的 adapter usage，也不能产生第二笔费用。对账不一致时保留审计记录且结果为未知。报告读取不能修改核算状态。

Adapter 用量标准化会单独记录 `cacheOmission: 'zero' | 'unsupported' | 'unknown'`，不与价格混为一谈。pi-ai adapter 声明 `zero`，因此省略的 cache 计数按已知零处理；其他 adapter 若未明确声明不支持某一类别，则默认 `unknown`。明确上报的零是已知零。Adapter 提供的 `totalTokens` 是唯一权威总量，不从组件字段重算。

<a id="usage-reports-and-estimates"></a>
## 用量报告和估算

每条用量记录包含 task、workflow、role、provider、model、route、logical invocation、attempt、request、purpose、可选 Session ID、原始 usage、标准化总量、时间区间、结果和 cost 状态。报告汇总实际 request、逻辑调用、attempt、失败、中止、compaction、token 总量、用量未知的 request 数、cache 原始小计，以及按 role/provider/model 的明细。只有每个实际 request 都提供权威 `totalTokens` 时，token 总量才是已知。保留 input、output、cache-read、cache-write 和 reasoning 原始计数；不得把 cache 计数加到 provider 总量。

分别报告 request 时长之和、provider 活动时间和 task 端到端时长。Provider 活动时间是已结算 request 时间区间的并集；request 时长之和是区间时长的算术和。持久化 `admittedAt` 和终态 `finishedAt`。Task 时间由 lifecycle 写入者管理：初次准入 `RUNNING` 和每次恢复都会开始一个运行区间；`BLOCKED` 和 `BUDGET_EXHAUSTED` 只关闭该区间，不结束 task。持久化终态时，在同一个状态事务中写入 `finishedAt`。时间写入失败时，task 时长保持 `UNKNOWN`；恢复时不得在生成报告时补造结束时间。累计端到端时长包含持久化的运行区间和暂停时长。不得把早先的 blocked 结束时间当作验收完成时间。`wallTimeMs` 根据持久化 request 时间戳计算；区间无效或时钟倒退时结果为 `UNKNOWN`，保留原始时间戳且绝不产生负时长。估算费用与实际账单金额分开；没有账单数据时，实际金额为 `UNKNOWN`。

部署定价配置可选且须验证，可包含 `currency: 'USD'`、来源、验证时间、每百万 token 的 input/output 单价、可选 cache-read/cache-write 单价，以及 `inputAccounting: 'aggregate' | 'exclusive'` 和 `cacheAccounting: 'reported' | 'not-supported'`。Request 预留时保存稳定的定价版本或 digest，后续配置变更不得重新计算历史费用。部署元数据只代表部署方的声明，不等同于独立核验 provider 定价。Aggregate input 核算时，可计费 input 为 `inputTokens - cacheReadTokens - cacheWriteTokens`；结果为负或缺少必要字段时 cost 未知。Exclusive 核算时，分别按 input 和已报告的 cache 类别计价。省略的 cache 字段仅能根据 adapter metadata 处理为零、不支持或未知；价格配置不能推断这一语义。缺少费率、不支持的 usage 类别、无效/未来验证时间或不一致的 cache 核算会使费用为 `{ status: 'UNKNOWN' }` 或导致配置拒绝。只有支持的 usage 和费率均完整时，费用才为 `{ status: 'ESTIMATED', usd, pricingDigest }`；不得称为实际账单金额。在线实验只有在官方费率已核实后才能使用价格。不得在交付版本中编造价格。`maxKnownCostUsd` 只使用已配置的估算；request 成本未知时 fail closed。

<a id="reproducible-evaluation"></a>
## 可复现评估

由 `tools/agent/src/benchmark.ts` 负责，评审后的 fixture 放在 `tools/agent/tests/fixtures/evaluation`。这套评估不得放入禁止网络访问的性能 gate 目录 `benchmarks/`。四种策略按部署配置的 route ID 选择：强单 Agent（A）、低成本单 Agent（B）、固定多 Agent（C）和自适应 V2（D）。对于实现 fixture，A 和 B 各执行一次可修改仓库的实现调用，再使用相同的 verifier 和 oracle；二者只在配置的强/低成本 route 上不同。C 固定依次运行 Scout、Architect、Challenger、Implementer、Verification、Reviewer；D 使用 `runEngineeringTask`。Review fixture 中所有策略保持只读：A 和 B 各调用一次 reviewer；C 依次运行只读 Scout、Architect、Challenger、Verification、Reviewer；D 使用 `runEngineeringReview`。所有策略应用相同的命名故障注入。

四个不可变 Git fixture 分别是：编译器功能/设计任务 `pebble-mul`，由 `node tools/agent/tests/fixtures/evaluation/pebble/check.mjs` 检查；MLIR pass 改写回归 `mlir-pass`，由固定版本 `mlir-opt` 和 grammar oracle 检查；固定 Review 任务 `review-overflow`，包含引入缺陷与干净 commit，并要求 finding path、SHA 和行号；以及确定性失败恢复 `recovery-latch`，包含首次尝试失败和最终源码 oracle。每个 fixture 固定 seed Git SHA 和源码 digest、request 和 criteria digest、命令配置、oracle、允许修改范围及执行/故障注入清单。清单包含分类策略和模型 route 配置，并移除凭据。Oracle 不接受模型自称成功作为证据。运行使用隔离的临时仓库、确定性初始化和已等待完成的清理。每次运行都记录 seed 和重复编号。

`runEngineeringBenchmark({ cases, strategies, executor, oracle, now? })` 返回 `OFFLINE_SYNTHETIC` 或 `LIVE_PROVIDER` 报告，内容包括运行条件、case digest、策略、结果和汇总。每项结果包含状态（`ACCEPTED`、`REJECTED`、`BLOCKED`、`BUDGET_EXHAUSTED` 或 `NOT_RUN`）、`firstImplementationPass`、wall time、usage、provider failure rate、fallback 和 escalation 数、人工介入数（未观测时为 `UNKNOWN`）及 oracle 证据。`firstImplementationPass` 是首次在 repair/retry 前通过独立 oracle 的实现阶段；receipt 不完整时为 `UNKNOWN`。Provider failure rate 报告已 dispatch request 的可确认失败，并单独报告 `unknownDispatchCount`；未知 dispatch 既不算已测量失败，也不算已知成功。人工介入需要持久化 receipt；缺少 receipt 时为 `UNKNOWN`。每个成功任务的 token 和 cost 包含该任务的全部工作量；任一相关 request 不完整时结果为 `UNKNOWN`。零成功时指标未定义/为 `UNKNOWN`。缺少的策略或 case 不能算作通过。损坏输出、错误源码范围、伪造 review finding 和执行失败等负向控制必须被 oracle 拒绝。

<a id="execution-and-acceptance"></a>
## 执行与验收

离线测试使用 scripted role 执行生产 workflow，并运行真实 Git/命令 oracle。其 token 数值为合成数据，不能证明模型节省。在线评估使用受支持的 `dsh` headless profile、engineering 仓库 overlay 和真实 provider adapter，可通过 `dsh --profile headless --patch <engineering-overlay> <request>` 或已发布的 `engineering-run` profile 启动。不得使用自定义 app launcher。至少一个可用 provider 必须在 task ledger 中持久化非零原始 usage 和结果。Provider 可用时，至少在一个有界 fixture 上尝试四种策略，并分别报告连接失败、任务验收和策略比较。若编译器、MLIR 或 Review 在线用例因外部、时间或资源限制无法运行，可记录为 partial 或 `NOT_RUN`。

原始 provider 日志和 Session 保留在 Git 之外；仅发布已脱敏的元数据和汇总用量，并明确标示未知费率。Phase 4 验收要求持久化核算、回放和恢复控制、所有 fixture 的独立 oracle、准确报告未知值，以及诚实的在线 provider 证据。设计已冻结；在这些检查通过前，Phase 4 仍未实现、未验证。
