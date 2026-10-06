# 仓库无关工程验收

[English](portability-acceptance.md) | 中文

本参考页记录仓库无关工程重构的可执行验收 oracle。它补充[现有验收计划](acceptance-plan.zh.md)；安装检查通过不代表仓库 preset 或硬件执行已经通过验收。

## 摘要

Runtime 安装仓库无关的 `engineering` 与 `engineering-run` profile，并使用同一个用户 deployment 快照完成 provider bootstrap、授权和角色派发。仓库定义的 profile ID 通过 schema、CLI、自动流程和恢复验证。Ascend 与 TileLang preset、声明式知识发现和作用域验证已有正向覆盖。可移植性测试保留策略身份、确定性影响、验收层级和 runner 的真实失败断言；compiler 资格验证和第三仓库接入证据仍未完成。

## 目录

- [源码基线](#source-baseline)
- [可执行 oracle](#executable-oracle)
- [覆盖限制](#coverage-limits)
- [验证命令](#verification-commands)

<a id="source-baseline"></a>
## 源码基线

已检查的 harness 分支为 `ascendnpu-engineering-harness`，本地 head 与远端分支一致。用户提供的设计和目标文件是未跟踪输入。已检查的 TileLang checkout 位于 `main`，工作区干净，并与远端 HEAD 一致。精确身份通过 `git rev-parse HEAD` 和 `git ls-remote` 检查，不作为 commit 引用保留在维护中的文档里。

安装器生成的 `engineering` 和 `engineering-run` 使用用户自有的 `deploymentRoot`，而不是仓库路径。Profile ID 使用小写 ASCII 字母、数字和连字符，并以字母或数字开头；写入任务或派发角色前，仓库 profile 文件必须存在且声明匹配。安装器拥有的旧 schema 可刷新而不改写任务元数据；仅执行初始化会保留已有 schema。自动流程的源码哈希排除 `.agent`，因此 verification profile、adapter 和项目策略变更不会使已记录的源码哈希失效。[作用域验证](scoped-verification.zh.md)通过名称与规范化 JSON 作用域标识实例。命令结果不报告 quiescence，自动流程的 Docker recovery 通过可执行文件名称判断。

<a id="executable-oracle"></a>
## 可执行 oracle

新增[可移植性测试](../../tools/agent/tests/portability-acceptance.spec.ts)使用临时仓库、公开 CLI、实际 Node 命令、持久化 artifact 和注入的角色响应。模型角色 fixture 不需要凭据。Git 配置隔离，输出源码已被跟踪，各命令写入独立执行记录，teardown 在删除仓库前取消并等待其拥有的自动任务结束。

| 要求 | 当前结果 | 直接观察 |
|---|---|---|
| 仓库无关的安装内容生成 | PASS | 改变目标仓库不会改变安装后的 profile 内容 |
| 通用 profile 名称和 launcher 默认值 | PASS | 安装器生成 `engineering` 和 `engineering-run` |
| 同一个已安装 deployment 支持两个仓库 | PASS | 真实 DSH profile 无需重装即可完成两个仓库的任务；第二个仓库没有模型、角色、workflow、数据策略或 persona 文件 |
| 路由和授权共享快照 | PASS | Provider bootstrap 和角色派发共享快照；即使仓库文件声明更宽松的 route，受限快照仍禁止派发 |
| Deployment 配置所有权 | PASS | 仓库初始化不复制模型 route、角色映射、workflow 限制、数据策略或 persona；用户 deployment 修改在重装后保留 |
| Deployment 写保护 | PASS | Implementer 不能编辑仓库内的 deployment，也不能通过符号链接别名访问它 |
| 通用初始化不包含 Ascend adapter | PASS | 默认初始化安装空的 local adapter；Ascend 需要显式选择 preset |
| Schema、项目 loader、CLI 和自动流程中的任意 profile ID | PASS | 有效的 `synthetic-compiler` profile 完成自动流程和初始任务恢复 |
| 文件系统访问前的 profile grammar | PASS | 拒绝路径穿越、大写、下划线、空 ID 和末尾换行 |
| 验收时的 verification policy 身份 | PASS | Review 期间修改 profile 要求、adapter 配置、项目设置、命令输入或影响策略声明会在验收前使轮次失效 |
| Architect 遗漏的 always-required gate | PASS | 每个必需命令实际执行，且存在通过的持久化命令证据记录 |
| 确定性路径影响与层级要求 | PASS | Profile、影响、层级和模型附加要求形成冻结的单调集合；无关路径使可选验证保持 `NOT_RUN` |
| 同一个 gate 对应两个仓库定义的 scope | PASS | 命令、状态、证据及必需实例验收各自独立；缺失作用域和借用证据均被拒绝 |
| Local 退出和取消的 quiescence | PASS | Linux 命令使用系统拥有的 systemd 范围；确认前回收脱离的后代；不支持范围管理时返回 `NOT_RUN` |
| Docker 超时和取消恢复 | PASS | Fake 和真实 `s00653124_build` 负载返回 `UNCERTAIN`；自动恢复持久化 `BLOCKED`，不写入 decision |
| Synthetic 第三个 compiler 流程 | PASS | Pebble 解析 IR、折叠常量、生成 stack/register IR、拒绝非法输入，并在两个任意 Profile ID 下完成验收 |
| 第三仓库零 core 修改证明 | PASS | 完整 `tools/agent/src` 和 `tools/agent/runtime` 路径及内容清单在接入和执行前后保持不变 |

<a id="coverage-limits"></a>
## 覆盖限制

此 oracle 区分架构验收和原生资格验证。loader 检查或安装内容比较不能替代 compiler 证据。

| 目标分组 | 缺少的证据 |
|---|---|
| A：仓库无关 profile | 已由安装后的 profile 双仓库集成测试覆盖 |
| B：任意 profile ID | 已由 schema、loader、CLI、项目、pending 恢复、无效声明和安装器拥有的旧 schema 迁移测试覆盖 |
| C：preset | 已覆盖 Ascend 与 TileLang 初始化、旧安装重装后的可编辑策略、独立 core/preset 身份和 preset 准入；native compiler 资格验证仍单独处理 |
| D：策略身份 | 已由 Plan、Verify、Review、Accept 中持久化的源码、策略、Profile、命令输入和 preset 身份覆盖 |
| E：确定性 impact 要求 | 已由冻结的单调要求、路径影响、层级选择、模型附加要求、必需 gate 失败或不可运行和旧轮次拒绝覆盖。[策略设计](verification-policy-design.zh.md)定义源码封印 |
| F：带 scope 的 verification | 已覆盖独立执行、拒绝缺失或不匹配的必需实例、带作用域的证据、拒绝前代产物验收及安装 profile 快照 |
| G：runner | Linux 管理范围取消、Docker 不确定取消及超时导致 BLOCKED、结构化环境、类型化参数和不依赖可执行文件 basename 的派发 |
| H：第三仓库 | Pebble compiler fixture、两个任意 Profile ID、完整 artifact 链和完整 generic source/runtime 路径内容清单 |

Deployment/repository 配置分离、core/preset freeze 分离和声明式仓库知识发现已有聚焦回归覆盖。无密钥安装 profile 快照将实际模型输入与记录的 child Session log 对照，且不预加载 Markdown 正文。已检查的 TileLang checkout 通过 preset 的只读语法命令，解析 403 个 Python 源文件；空源码和错误语法 fixture 均失败。从复制的仓库文档和 skill 文件中发现其九个已有 skill。Native build、聚焦 pytest、硬件、benchmark 和真实 provider 资格验证保持 `NOT_RUN`，不是 `PASS`。

硬件 qualification、GPU/NPU 执行、benchmark、真实 provider 和 macOS/Windows 原生 containment 保持 `NOT_RUN`。本次 source/IR 证据不能替代这些资格验证。

<a id="verification-commands"></a>
## 验证命令

这些命令分别执行。第一条覆盖 portability oracle。第二条仅排除平台相关的 freeze fixture，检查其余 harness 回归测试。

```sh
pnpm exec vitest run --config tools/agent/vitest.config.ts tools/agent/tests/portability-acceptance.spec.ts
pnpm exec vitest run --config tools/agent/vitest.config.ts --exclude tools/agent/tests/portability-acceptance.spec.ts
```

Portability suite 已独立断言带 scope 的证据、策略拒绝、命令证据、隔离的 Git 配置和受管理任务的 teardown。上面的覆盖限制只列出不属于源码级 oracle 的资格验证证据。

## 开发备注

无。
