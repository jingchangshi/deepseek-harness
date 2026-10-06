# 工程任务协议

[English](task-protocol.md) | 中文

本 reference 定义[冻结版工程 Harness](architecture.zh.md) 的 repository artifact、状态转换和当前 `agentctl` source-launch command。当 DSH Session 或进程不可用时，repository record 仍是权威来源。

## 摘要

每个 task 都有 immutable metadata、一个 revisioned state record 和经过 schema 验证的 stage artifact。writer 在跨进程 file lock 下使用 compare-and-set revision。Artifact file 在 `STATE.json` 之前 atomic replace，因此 state commit 中断后仍可读取之前的 authoritative revision。

## 目录

- [Repository file](#repository-files)
- [状态转换](#state-transitions)
- [Revision 与 writer](#revisions-and-writers)
- [Verification 与 review](#verification-and-review)
- [Acceptance](#acceptance)
- [CLI](#cli)
- [恢复](#recovery)

-----

<a id="repository-files"></a>
## Repository file

Task directory 位于 `.agent/tasks/<task-id>/`。`TASK.yaml` 包含 immutable task identity、profile、data class 和 creation time。Profile ID 是由小写 ASCII 字母、数字和连字符组成的非空字符串，以字母或数字开头；空白和路径分隔符均无效。创建任务时，`.agent/profiles/<id>.yaml` 必须具有匹配的 `id`、受支持的 schema 版本和有效 gate 定义，验证通过后才能写入任务元数据或状态。自动项目加载验证同一份声明，恢复的任务保留原有 profile。`STATE.json` 包含当前 state、repository revision、frozen work revision、bounded-fix count、optional writer lease 和 update time。

Stage command 写入 `BASELINE.json`、`INVESTIGATION.json`、`PLAN.json`、`VERIFY.json`、`REVIEW.json` 和 `DECISION.json`。`.agent/schemas/` 中的 schema 拒绝 unknown field 和 malformed value。`EVIDENCE.jsonl` entry 使用 `evidence.schema.json`；evidence append 与 command execution 将在 verification-profile stage 实现。

<a id="state-transitions"></a>
## 状态转换

正常路径为：

```text
NEW -> BASELINED -> INVESTIGATED -> PLAN_FROZEN -> IMPLEMENTING
IMPLEMENTING -> VERIFYING -> VERIFIED -> REVIEWING -> REVIEWED -> ACCEPTED
```

`REPLAN` 通过新 investigation 返回 `INVESTIGATED`。任何 nonterminal task 都可以变为 `BLOCKED`。`ACCEPTED` 是 terminal，因此 repeated acceptance 和后续 mutation 都会失败。

`engineering_run` 在状态中返回 `nextAction`。`WAIT_FOR_CURRENT_RUN` 表示另一个运行拥有该仓库；不会启动额外任务、角色、writer 或命令。`RECOVER` 禁止未修改的重复调用；仅当 `requiresStopConfirmation` 为 `true` 时，才要求在 `engineering_recover` 前取得人工停机确认。`false` 表示拥有的工作已达到 quiescence，因此恢复不需要该确认。`REPLAN_WITH_SCOPE` 要求补充产品信息，而不是机械重试。已验证的计划若仍有阻止验收的假设，则进入 `BLOCKED` 并返回此操作，无需停机确认；为同一任务补充变更后的范围会显式重新规划。指定 `BLOCKED` 任务的重复调用返回其 blocker，不派发角色。`NONE` 对应终态验收。

重放身份由持久化 Session ID、tool call ID、已记录的调用序号和仓库规范路径组成，不使用请求文本。序号区分后续复用 ID 的模型调用；不带已记录序号的直接 API 调用方必须自行提供稳定且不同的 call ID。`.dsh/engineering/.runtime/invocations/` 下 runtime 拥有的回执在副作用前记录调用声明，随后记录所选任务和完成结果。并发重放共享进程内操作；完成后重放返回已记录结果。进程丢失后未完成的持久化声明要求显式恢复，不会启动另一条工作流。文本相同但 tool call 不同的请求属于独立调用。

<a id="revisions-and-writers"></a>
## Revision 与 writer

每个 mutating command 都要求 `--revision <current>`。store 获取 `STATE.json.lock`，重新加载并验证 current state，并在写入前拒绝 stale revision。每次成功 transition 恰好递增一次 revision；`verify` 和 `review` 都执行两个显式 transition，因此各递增两次。

`implement` 创建一个 opaque writer token。`verify` 必须提交该 exact token，清除 lease 并进入 `VERIFYING`。存在 active lease 时，task 不能获取另一个 lease。只有 implementer operation 可以创建 writer lease。

冻结 plan 会增加 `workRevision` 并重置 `fixAttempts`。Plan、verification 与 review artifact 携带其评估的 work revision。Acceptance 会拒绝来自其他 work revision 的 artifact。

<a id="verification-and-review"></a>
## Verification 与 review

Verification status 只能是 `PASS`、`FAIL`、`NOT_RUN` 或 `INCOMPLETE`。只有 `PASS` 进入 `VERIFIED`；其他 status 都消耗一次 bounded fix。第一轮失败返回 `IMPLEMENTING`，第二轮进入 `REPLAN`。

Review decision 只能是 `ACCEPT`、`FIX_BOUNDED`、`REPLAN` 或 `BLOCKED`。`ACCEPT` 进入 `REVIEWED`。`FIX_BOUNDED` 与 verification failure 消耗同一个 bounded-fix counter。`BLOCKED` 要求 non-empty blocker。

<a id="acceptance"></a>
## Acceptance

`agentctl accept` 在状态写入锁下验证状态、计划、验证、审查和命令证据。它要求 `REVIEWED`、没有写入者、任务和工作修订一致、没有阻断计划假设、版本 3 的验证为 `PASS`、每个累积必需实例通过且具有匹配命令证据，以及审查决定为 `ACCEPT`。[作用域验证](scoped-verification.zh.md)定义实例匹配；[源码封存](verification-policy-design.zh.md)定义轮次权威记录。验收写入 `DECISION.json` 并提交终态。

Reviewer output 不能绕过 deterministic check。即使 verification document 的 top-level status 是 `PASS`，只要 required check 失败，任务仍不能 accepted。

<a id="cli"></a>
## CLI

source development 期间，从固定 DSH checkout 启动 CLI；目标 repository 位于其他位置时使用 `--root`：

```sh
cd /absolute/dsh-checkout
node --import tsx/esm tools/agent/agentctl.mjs init --root /absolute/project
node --import tsx/esm tools/agent/agentctl.mjs new task-id --title "Task" --profile webapp --data-class internal --root /absolute/project
node --import tsx/esm tools/agent/agentctl.mjs status task-id --root /absolute/project
```

Artifact command 包括 `baseline`、`investigate`、`plan`、`verify` 和 `review`；每个 command 都接受 `--input <json-file>` 和 `--revision`。`implement` 接受 `--revision`，并在 state 中返回 writer token。`verify` 还接受 `--writer-token`。`accept` 与 `replan` 接受 `--revision`。

CLI 在内部使用 executable argument array，不调用 platform shell。`verify-profile` 运行 configured project command，并在目标 repository 中记录其 evidence。

<a id="recovery"></a>
## 恢复

中断的 artifact write 不会留下 partial final file，因为 replacement 使用 random sibling 和 atomic rename。在 artifact replacement 之后、state replacement 之前中断时，artifact 的 `taskRevision` 会领先 authoritative state；reader 会忽略它，直到成功 command 发布该 revision。corrupt 或 missing artifact 会 validation failure，且绝不成为 implicit default。

## 延伸阅读

- [架构](architecture.zh.md)
- [验收计划](acceptance-plan.zh.md)
- [当前状态](status.zh.md)

## 开发备注

无。
