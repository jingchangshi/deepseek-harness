---
kind: upgrade-guide
description: 工程 profile 使用用户部署配置，不再使用绑定仓库的 Ascend profile。
---
# 工程 Profile

[English](guide.md) | 中文

## 变更

安装器将 `ascend` 和 `ascend-run` 替换为 `engineering` 和 `engineering-run`。部署配置来自 `<DSH_HOME>/engineering/.agent`；Session cwd 选择仓库策略和任务。插件 `configRoot` 改为 `deploymentRoot`。

`agentctl run` 和 `smoke-models` 默认使用用户 deployment，而不使用仓库模型声明。直接调用自动 driver 的消费者传入角色执行器所使用的、经过验证的 `deployment` 快照，不再依赖仓库路由文件。

任务创建要求 `.agent/profiles/<id>.yaml`。Profile ID 是仓库定义的小写 ASCII 字符串，不再是枚举。已有 ID 仍受支持。

通用初始化不安装 Ascend 命令。仓库脚手架在重装时保留编辑；Artifact Schema 继续由 Runtime 管理。

远程包装命令必须选择显式运行器。命令要求系统拥有的 Linux 管理范围；不支持的宿主返回 `NOT_RUN`，不启动命令。

新的 `PLAN.json`、`REVIEW.json` 和 `DECISION.json` 使用版本 2；`VERIFY.json` 使用版本 3。它们将验证轮次绑定到源码内容、仓库策略、Profile 输入和累积必需实例。旧 Schema 仍可读取，但不能授权验收。检查保留 `category` 和 JSON `scope`；执行结果是实例数组，不再是按名称索引的映射。

直接调用方使用 `beginVerification`，获取 `verificationIdentity` 和 `verificationGates`，携带该身份执行命令，携带派发状态修订追加 `verificationEvidence`，再调用 `finishVerification`。证据不会重新绑定到后续轮次。`verify-profile --project-config` 必须匹配仓库 Adapter。源码、策略或 Profile 变化会使验收失效，Reviewer 批准不能绕过检查。

## 迁移

1. 在 harness checkout 中运行 `node tools/agent/install.mjs`，安装新 profile。非默认用户目录使用 `--home` 和 `--bin-dir`；`--root` 是可选项，用于初始化仓库。
2. 将旧 deployment 的 `.agent/config` 中定制的 `models.yaml`、`roles.yaml`、`workflow.yaml` 和 `data-policy.yaml` 复制到 `<DSH_HOME>/engineering/.agent/config`。将定制 persona 复制到 `<DSH_HOME>/engineering/.agent/roles`。项目声明、adapter、profile 和任务 artifact 保留在各自仓库中。不要提交凭据。
3. 将手工配置的 `engineering-bootstrap` 或 `engineering-harness` 插件的 `configRoot` 替换为 `deploymentRoot`，指向 `<DSH_HOME>/engineering`。修改部署 route 后重启 profile。
4. 在每个仓库中运行 `dsh engineering` 或 `dsh engineering-run "request"`。向 `agentctl run` 或 `smoke-models` 传入 `--deployment-root <directory>` 可选择其他 deployment。
5. 运行 `node tools/agent/install.mjs --root <repository>` 刷新安装器拥有的任务 Schema。初始化只添加缺失文件。备份不属于安装器或已编辑的 Schema，再与 Checkout 显式协调；安装器拒绝替换它们。安装 `.agent/profiles/<id>.yaml`，包含匹配的 `id`，纯元数据调用方也不例外。重启 Schema Reader。不要重写任务元数据。
6. 为新的 AscendNPU-IR 仓库初始化时，向指定 `--root` 的安装器或 `agentctl init` 增加 `--preset ascendnpu-ir`。已有项目声明和 adapter 保持不变。通用仓库必须配置必需命令，否则验证保持 `NOT_RUN`。所有权和脚手架身份见[仓库 preset](../../../software-engineering-harness/repository-presets.zh.md)。
7. 安装后继 `plan-v2`、`verification-v2`、`verification-v3`、`review-v2` 和 `decision-v2` Schema，不替换旧版本。缺少源码和策略绑定的待处理任务必须显式重新规划和验证。参见[作用域验证](../../../software-engineering-harness/scoped-verification.zh.md)和[验证策略](../../../software-engineering-harness/verification-policy-design.zh.md)。
