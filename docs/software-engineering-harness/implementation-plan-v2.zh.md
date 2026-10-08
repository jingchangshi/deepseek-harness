# Engineering Harness V2 实现计划

[English](implementation-plan-v2.md) | 中文

## 概述

本参考文档规定[V2 架构](architecture-v2.zh.md)的交付顺序。每个阶段都要求独立测试、适用时观察到 RED 结果、实现、GREEN 结果、回归检查和独立评审，然后才能向目标分支提交并推送。Phase 4 设计已冻结；生产实现和验证尚未开始。详见[用量核算与评估设计](usage-evaluation-v2.zh.md)。[验收标准](acceptance-matrix-v2.zh.md)不能为了迎合实现而降低。

## 基线与执行

保留现有未跟踪的索引缓存。目标分支是 jingchangshi/deepseek-harness 中的 ascendnpu-engineering-harness。目标 fork 配置为 remote jcshi；origin 指向上游仓库，不得向其推送。在机器可读的交付产物中记录准确的起始和最终 commit ID、命令证据及 remote 确认。原始 Session 和凭据不得放入 Git。

主 agent 负责接口和验收。只读 Scout 调查工具流水线。独立 Test Designer 先编写测试，再由单独的 Implementer 修改生产代码。独立 Reviewer 检查主要设计和实现证据。此环境无法使用已配置的 worker model；应使用受支持的 subagent，并如实记录实际 agent 和 role 分配，不得声称不可用的 worker 已执行任务。

## 阶段顺序

| 阶段 | 生产代码范围 | 交付条件 |
|---|---|---|
| 0 | Tool registry dispatch metadata 和 runtime mutation observation | 仅允许通过授权且验证成功的 dispatch；writer fallback 安全 |
| 1 | 类型化 Git 证据和独立的 Review-only task 生命周期 | 不可变 SHA、已验证证据、不使用 Implementer 或源码写入 |
| 2 | 工作单元、持久化 checkpoint 和 task 生命周期预算 | Runtime 限制及恢复时累计核算 |
| 3 | 可审计的自适应 task 分类、最少角色阶段和独立能力升级 | 分类下限单调、升级持久且有限、writer 诊断具备崩溃安全；必需测试见[验收矩阵](acceptance-matrix-v2.zh.md)和[自适应调度设计](adaptive-scheduling-v2.zh.md) |
| 4 | Request 用量账本和可复现 benchmark runner（[已冻结设计](usage-evaluation-v2.zh.md)） | 去重后的实际用量和独立 E2E，或明确标记 NOT_RUN |

前一阶段通过验收之前，不得开始任何阶段的生产代码实现。Phase 0 实现前要完成架构评审。创建测试时可能会发现缺失的新能力；应将其记录为 capability RED，而不是已有回归。生产代码修正不得修改独立测试的预期结果来接受错误行为。

只有冻结接口和独立 RED 测试获得批准后，才能开始 Phase 3 实现。[自适应调度设计](adaptive-scheduling-v2.zh.md)是分类下限、成功与升级响应、持久化升级状态及 writer 诊断崩溃顺序的唯一详细说明。

## 验证与交付

根据实际 diff 选择 tools/agent Vitest 测试、变更涉及的 core package 测试、TypeScript、lint 和文档检查。Tool pipeline API 变更要同时更新所属 README/JSDoc 及其消费者。产品可见变更需要记录输出证据。审慎维护 pinned-runtime 完整性：只有审查确认是预期变更时才更新受管 hash，并测试 freeze 检查。每个已验收里程碑都要只提交明确指定的文件；检查 remote 祖先关系后进行普通的非 force 推送，并验证 remote SHA。

## 证据归属

验收矩阵负责需求 ID 和测试义务。Phase 验证报告记录已执行命令、RED/GREEN/回归结果、独立评审决定和未解决风险。机器可读状态报告负责 commit/push identity。Runtime log、Session ZIP 内容和凭据不得写入已提交报告。文档要记录设计是 proposed 还是 frozen；只有主要证据支持时，才能声称已实现。

## 公共工具 API 交付

Phase 0 更新工具定义验证/effect metadata 和 registry observation。同步更新所属 README 配对文件、JSDoc、子系统参考文档、适用的录制输出证据，以及针对原始无效参数拒绝行为的 upgrade guide。独立测试覆盖捕获的 defineTool schema 和原始完整 schema 行为。不得使用 output-schema 子集限制来悄然改变上游 MCP 参数 schema。
