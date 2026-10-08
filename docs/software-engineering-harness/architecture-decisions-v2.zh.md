# Engineering Harness V2 架构决策

[English](architecture-decisions-v2.md) | 中文

## 概述

本参考记录可复用的 V2 约定及其取舍。[架构](architecture-v2.zh.md)负责完整设计；[验收矩阵](acceptance-matrix-v2.zh.md)负责各阶段要求。这些决策不表示任何阶段已通过验收。

## 决策

| 领域 | 决策 | 取舍 |
|---|---|---|
| Mutation 观察 | 在可见性、策略、守卫、参数验证和环绕分发之后，对实际注册的工具主体进行同步观察。副作用来自类型化工具元数据；省略时按可能产生 mutation 处理。 | 保守默认值可能阻止未声明工具的 fallback，因此只读工具必须在定义中声明 effect。工具名 allowlist 不能覆盖元数据。 |
| 参数验证 | `defineTool` 向 registry 分派公开其捕获的验证器，并在直接执行时保留该验证。原始定义使用 Ajv Draft 7 严格校验，并在主体观察前验证。 | 不支持的 schema 会 fail closed；不会获取远程引用。该验证器与受限的 output-schema 编译器分离，因此 MCP 参数 schema 保留通用 Draft 7 语义。 |
| Observer 所有权 | Body-start observer 是同步、作用域化的注册，并返回准确的 disposer。Observer 接收冻结的执行快照和解析后的 effect；异常、返回值或取消都会阻止主体进入。 | 同步 listener 可能延迟分派。每次 retry 都是新的主体启动，并单独观察。 |
| 呈现方式 | Engineering child 在分派前通过作用域化 `presentAs('native')` 设置呈现方式。 | Runtime 使用现有呈现 API，不增加新模式。PTC transport 仍按可能产生 mutation 处理，包括嵌套 `run_code`。 |
| Writer 权限 | Child cleanup 无法确认 quiescence 时保留 writer lease。只要任一 writer 或不确定停机状态存在，repository-wide admission 就会阻止分派。只有确认停止后，恢复流程才释放 lease。 | 拥有的工作可能仍在运行时，需要 operator 才能恢复进度。直接 replan 或 block 不能清除 writer 权限。 |
| 阶段验收 | 阶段只有在取得所需的一手证据、独立评审和交付记录后才通过。缺失或待完成证据保持 `PARTIAL` 或 `NOT_RUN`。 | 定向测试、设计批准或成功构建不能替代其他验收项或最终交付证据。 |

## 延后决策

Phase 1–4 尚未实施和验证。详细要求由[验收矩阵](acceptance-matrix-v2.zh.md)记录；本页不记录这些阶段的实施决策。
