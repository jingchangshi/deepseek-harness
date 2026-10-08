# Harness 运维

[English](operations.md) | 中文

先一次性安装冻结的工程 profile，然后从已配置的仓库启动 DSH。交互 profile 接收一条自然语言开发需求，并自动完成调查、规划、实现、验证、独立审阅和确定性验收，无需手工执行任务命令。

## 安装

从 DSH harness 分支运行安装器；安装器先执行 freeze 检查：

```sh
cd /home/shijingchang/workspace/deepseek-harness
node tools/agent/install.mjs --root /home/shijingchang/workspace/AscendNPU-IR-1 --preset ascendnpu-ir
```

DSH 分支中的 `.agent/` 是模板来源。可选的 `--root` 初始化目标仓库；省略它只安装 runtime 和用户 deployment。安装器在当前 DSH home 下创建 `engineering` 和 `engineering-run`，并安装 `~/.local/bin/dsh`。缺失的部署配置和 persona 在 `<DSH_HOME>/engineering/.agent` 下初始化；已有用户修改予以保留。安装的 profile 不包含目标仓库路径。安装器保留 `.agent/tasks/`，只存储凭据环境变量名称，不存储凭据值。

重新运行同一命令即可更新 managed artifact schema 和用户 profile。目标仓库中的 `.agent/dsh-template-installation.json` 和 DSH home 中的 `engineering-installation.json` 记录 managed 文件哈希。仓库策略编辑予以保留，包括旧标记中列出的文件。Profile 升级会保留固定工程组合之外的 Cordis entry。Managed 内容的冲突编辑会被拒绝。仅补缺失文件的脚手架、通用初始化和 preset 身份见[仓库 preset](repository-presets.zh.md)。

确保 `~/.local/bin` 在 `PATH` 中优先于其他 DSH 安装。Launcher 使用这个冻结源码 checkout，并保留调用者的 working directory。

## 日常使用

在目标仓库启动 Web UI，并把需求作为普通消息输入：

```sh
cd /home/shijingchang/workspace/AscendNPU-IR-1
dsh
```

裸 `dsh` 默认选择 `engineering` profile，`dsh engineering` 与之等价。一次性终端运行使用：

```sh
dsh engineering-run "<requirement>"
```

Coordinator 把需求提交给工程 runtime 一次。自适应调度会选择 task 分类和最少角色阶段：simple 省略 Scout、Architect 和 Challenger；standard 仅在缺少证据时使用 Scout，并增加 Architect；complex 执行有界调查，高风险时增加 Challenger。只有一个 Implementer 获得写工具；必需 adapter command 在模型控制之外运行；新的 Reviewer 独立评估结果。只有 repository state engine 可以写入 `ACCEPTED`。

## 项目配置

Session cwd 选择目标仓库的 `.agent/config/project.yaml`、schema、verification profile、adapter 和任务状态。在仓库 `project.yaml` 中设置任务范围、验收条件和可选调度策略；compiler profile 因编译器与 IR 工作属于高风险，分类仍为 complex。模型与角色映射、全局数据策略、自适应阈值、workflow 准入限制和 persona 只来自用户 deployment。通用初始化不提供命令：缺失的 required adapter 报告 `NOT_RUN`。显式 [Ascend preset](ascend-integration.zh.md) 提供 compiler 命令；任何 required check 缺失、失败或不完整都会阻止验收。workflow 阈值和升级路由见[模型路由](model-routing.zh.md)；分类与恢复行为见[自适应调度设计](adaptive-scheduling-v2.zh.md)。

Magpie provider 在 `<DSH_HOME>/engineering/.agent/config/models.yaml` 中要求 `DSH_MAGPIE_GATEWAY_URL`，并引用 `DSH_MAGPIE_API_KEY_ENV` 选择的凭据变量（默认为 `MAGPIE_API_KEY`）。仓库模型声明不能覆盖该 deployment。`agentctl run` 和 `smoke-models` 默认读取同一份用户 deployment；`--deployment-root <directory>` 显式选择其他 deployment 目录。 设置 `DSH_MAGPIE_API_KEY_ENV=MAGPIE_API_KEY` 或不设置该变量；实际密钥放在 `MAGPIE_API_KEY` 中。选择器必须填写环境变量名，不能填写密钥内容。

根据[模型路由](model-routing.zh.md)配置 Magpie provider、可选公司网关和精确角色 ID。安装只初始化缺失文件，保留用户拥有的部署修改。现有安装必须根据[升级指南](../upgrade-guide/v0.2.1-alpha.1/engineering-model-routes/guide.zh.md)更新自己的路由声明，再重启 profile，并通过[真实 smoke 测试](provider-smoke-tests.zh.md)验证主路由和备用路由。

## 恢复

`engineering_run` 和 `engineering_status` 的可选 `taskId` 字段将空字符串视为未提供；非空的无效标识在认领运行前被拒绝。`engineering_recover` 要求非空的任务标识。

在同一仓库重新启动 `dsh`，并要求它继续返回的 task ID。Coordinator 先读取 status，再仅使用该 task ID 调用 `engineering_run`。Runtime 读取 `.agent/tasks/<task-id>/STATE.json` 和 `AUTO.json`，只从已提交状态恢复。不同需求必须创建新任务，不会被追加到已冻结计划。

遵循 `nextAction`，不要不加修改地重试 `engineering_run`。`WAIT_FOR_CURRENT_RUN` 要求等待并检查状态；`RECOVER` 要求显式恢复，并且仅当 `requiresStopConfirmation` 为 `true` 时才要求停机确认；`REPLAN_WITH_SCOPE` 要求补充产品信息。重放的工具调用返回已保存结果或关闭失败的中断声明，不创建新工作流。新的用户请求具有不同的 tool-call 身份，即使文本完全相同。

取消操作会终止本地 command process group 并等待退出。Docker 验证被取消或超时后会进入 `BLOCKED`，因为停止宿主机 `docker` client 不能证明已有容器内的命令已经停止。Writer 中断、一次有界运行耗尽或验证后 worktree 变化也会关闭失败。确认旧 agent 和容器命令均已结束后，Coordinator 调用 `engineering_recover`，在 run lock 下释放 writer、进入 `REPLAN`，并清除该轮运行的 step、role-call 和 verification checkpoint。同一 task 保留原需求并获得一轮新的有界运行；系统不会自动执行恢复。

## 诊断

固定 checkout 中仍提供 `agentctl`，用于检查 artifact 和执行协议级维护；它不属于日常开发路径。使用低层命令前，应通过 Coordinator 使用 `engineering_status`，或检查 `.agent/tasks/`。

Provider smoke test 和 Ascend device check 仍属于部署验收。无密钥 real-composition test 使用私有 mock endpoint，在不向外部发送仓库内容的情况下验证 profile 加载、真实 subagent session、工具限制、命令证据、review 和 acceptance。

Search spill 通知声明使用 `spill_read`。将 locator 原样传给该工具；不要假设仓库文件系统能够读取 `/tmp` 路径。[Spill backend](../../packages/spill/spill-local/README.zh.md)拥有存储、有界分页和 locator 验证。混合的权限失败与其他有界 search 诊断分别折叠。

## Dev Note

无。
