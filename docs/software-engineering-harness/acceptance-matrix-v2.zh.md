# Engineering Harness V2 验收矩阵

[English](acceptance-matrix-v2.md) | 中文

## 概述

本参考文档冻结[实现计划](implementation-plan-v2.zh.md)要求的行为。每一行都必须有主要证据才能判定 PASS。通过的 mock、smoke 或 schema validator 不能替代其他类别的证据。所有阶段目前都要求实现和验证。

## 需求追踪

| ID | 要求 | 必需的独立证据 |
|---|---|---|
| P0-01 | 未知 Scout bash 不会标记 mutation | 真实 registry/runtime 回归测试；展示修复前的 RED |
| P0-02 | Guard、可见性、注册和参数拒绝不会标记 mutation | 负向 dispatch 测试，并统计 body 调用次数 |
| P0-03 | read、grep 和 lsp 保持只读 | 类型化 effect 的 body-start 测试 |
| P0-04 | 完全停稳的只读超时可以 fallback | fallback 开始前的 child disposal barrier |
| P0-05 | 实际 writer dispatch 会禁用 fallback | 副作用 body 已进入，失败的 role 不能切换 route |
| P0-06 | 后台工作仍在运行时不会准入另一个 writer | 可控的停止/disposal barrier 和 writer 准入断言 |
| P0-07 | 并发 child 不能共享 mutation 状态 | 两个 Agent identity 的重叠执行 |
| P0-08 | 取消、wrapper 短路和 observer 失败仍然安全 | Registry 集成测试，精确断言 body 调用次数 |
| P0-09 | 原始 schema 验证先于 observer；未声明的 effect 按可能产生 mutation 处理 | 无效原始 schema/参数和默认 effect fixture |
| P0-10 | Observation 是同步的、受 scope 限制且可 dispose | 多回调/异常回调、回调取消、retry 和 HMR teardown 测试 |
| P0-11 | 每个允许的只读工具都有自己的 metadata；PTC 仍按保守策略处理 | 检查实际定义、native 限制和嵌套 PTC 测试 |
| P1-01 | Commit、branch tip、range 和可解析 PR target 固定到 SHA | 合成 Git 仓库及 snapshot 后移动分支 |
| P1-02 | Snapshot/files/diff/show/history 是安全的类型化工具 | 拒绝 argv 和路径注入；不执行 shell |
| P1-03 | 二进制和大型输出保持显式且可分页 | 二进制和超大合成 commit；检查覆盖完整性 |
| P1-04 | Review-only 不会调度 Implementer 或写入源码 | End-to-end runtime 测试，包含被拒绝的写入和未知 bash |
| P1-05 | Finding 包含严重级别、失败条件、变更关系和固定源码位置 | 含缺陷和干净合成 commit，并使用独立 oracle |
| P1-06 | 占位内容、伪造位置和缺失范围不能通过 | Schema 有效但证据无效的 fixture 返回 PARTIAL |
| P2-01 | Scout A 会保留，并且不会因 Scout B 超时而重复调查 | 统计实际 dispatch 次数的 checkpoint/recovery 测试 |
| P2-02 | Snapshot、范围和依赖项变化会使受影响证据失效 | 选择性 checkpoint 失效测试 |
| P2-03 | 软/硬时限和工具上限在 runtime 中执行 | 可控时钟/barrier 测试；不得伪造部分证据 |
| P2-04 | Recover/replan 保留所有生命周期计数器 | 重复恢复和并发预留测试 |
| P2-05 | 耗尽时停止调度且不会重复 writer | BUDGET_EXHAUSTED 和关停不确定性集成测试 |
| P2-06 | 上下文包含相关增量，spill locator 错误可操作 | 有界 prompt capture 和无效 locator 诊断测试 |
| P3-01 | Simple 省略 Scout；Standard 进行设计；Complex 评审风险 | 可复现的分类和 dispatch trace fixture |
| P3-02 | Review-only 不能进入 Development | 状态转换和 role 准入拒绝 |
| P3-03 | Provider fallback 与能力升级有区别 | 已分类失败/证据不足的 dispatch trace |
| P3-04 | 重复失败和低预算会安全终止 | 有限升级及 mutation/quiescence 回归 |
| P4-01 | 实际 request 用量会持久化原始和标准化字段 | 单元测试/回放，以及可用时的在线 provider 集成 |
| P4-02 | Retry、压缩、缓存和回放只计数一次 | 持久化 event/request identity fixture；保留未知用量 |
| P4-03 | 缺少价格时为 UNKNOWN；重叠区间保留 task wall time | 价格版本/缓存和重叠区间 fixture |
| P4-04 | 四种策略共享可复现输入和独立 oracle | Compiler 设计、MLIR 变更、Review 和注入式恢复 fixture |
| P4-05 | 如实报告质量、首次通过率、延迟、token、成本和失败 | Benchmark 报告验证；不可用的真实对比标记 NOT_RUN |
| ALL-01 | 现有安全、preset、验证和路由继续有效 | 相关现有回归测试和 pinned-runtime 检查 |
| ALL-02 | 每个阶段都独立评审、提交和推送 | 独立结论、准确命令、commit 链和 remote SHA |

## 验收记录

每份阶段报告记录起始/最终 HEAD、模块、决定、RED 基线、GREEN 和回归命令/结果、Reviewer 结论、未解决风险、commit 和 push 确认。初始状态为 NOT_RUN；证据不完整或缺失时仍为 PARTIAL 或 NOT_RUN。原始私有 Session ZIP 文件是诊断输入，不是可发布的测试产物。确定性 fixture 可以复现文档所述的失败模式，但不得声称它们来自原始 Session。
