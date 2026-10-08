# 只读 Git 评审

[English](review-only.md) | 中文

## 摘要

Coordinator 可以评审本地 Git 变更集，而不启动 Development 或分派 Implementer。只有当 Reviewer 和 runtime 使用完整且已观察的 Git 证据覆盖每个变更路径时，结果才为 `REVIEW_COMPLETE`。

## 目录

- [发起评审](#request-a-review)
- [固定 snapshot](#pinned-snapshot)
- [证据工具](#evidence-tools)
- [范围覆盖与 finding](#coverage-and-findings)
- [保存状态与恢复](#saved-state-and-recovery)
- [延伸阅读](#further-exploration)

-----

<a id="request-a-review"></a>
## 发起评审

从顶层 Coordinator 调用 `engineering_review`。必须提供 `targetKind` 和 `target`；`base` 与 `taskId` 可选。target kind 选择本地 commit、branch tip、commit range 或已有的本地 pull-request ref。

| `targetKind` | `target` | `base` |
|---|---|---|
| `commit` | `HEAD` 或完整 commit SHA | 可选的完整 base SHA；默认使用该 commit 的父 commit，根 commit 则使用空 tree。 |
| `branch` | 本地 branch 名称 | 可选的完整 base SHA；默认使用 branch tip 的父 commit，根 commit 则使用空 tree。 |
| `range` | 使用完整 commit SHA 的 `<base-SHA>..<target-SHA>` | 已包含在 `target` 中；省略 `base`。 |
| `pr` | 正整数形式的本地 pull-request 编号 | 必填的完整 base SHA；target 读取 `refs/pull/<number>/head`。 |

评审读取当前本地 repository objects。它不会 fetch branch、查询 remote 或更新 Git ref。只有本地已存在 `refs/pull/<number>/head` 时，才能评审该 pull request。

可选的 `taskId` 用于选择已保存的评审。省略时，runtime 会创建 review ID。恢复或读取评审时，使用相同的 `taskId` 和完全相同的 target selector；同一 ID 不能改用其他 selector。

<a id="pinned-snapshot"></a>
## 固定 snapshot

首次运行会将所选 target 和 base 解析为完整 commit ID，并保存规范 repository 路径、Git object format 和 snapshot ID。省略 base 时使用 target commit 的第一个父 commit；根 commit 使用空 tree。

已保存的 snapshot 会固定后续读取内容，即使本地 branch 或 `HEAD` 移动也不受影响。恢复评审时会使用持久化 snapshot 和变更路径范围，不会重新解析 selector。Snapshot ID 由 repository 路径、base commit、target commit 和 object format 确定。

<a id="evidence-tools"></a>
## 证据工具

Reviewer 可使用 `git_snapshot`、`git_changed_files`、`git_diff`、`git_show` 和 `git_history`，以及已配置的只读工具。runtime 会过滤 shell、write、edit 和嵌套 workflow 工具。Git 读取通过固定的 `execFile` 参数数组访问固定 commit；评审不会运行任意 Git command，也不会修改 `.git`。

每次证据查询都会返回 `evidenceId`、snapshot ID 和完整性信息。`git_show` 和 `git_diff` 还会为每个文本页返回 SHA-256 hash。`git_changed_files` 和 `git_history` 返回分页记录。`git_diff` 返回带 continuation offset 的分页 diff 文本。`git_show` 返回 target commit 的源码行和 continuation line。必须跟进每个 continuation，直到 `completeness.complete` 为 `true`。

Workflow 配置设置可直接评审的最大文件数、Scout 数量上限、Git command timeout、子进程输出上限和默认证据分页大小。默认值分别为 4 个文件、2 个 Scout、30 秒、8 MiB 和 16,384 个操作单位。变更路径超过直接评审上限时，会将不重叠的路径组分配给已配置的 Scout role；Reviewer 仍会独立检查完整变更范围。

<a id="coverage-and-findings"></a>
## 范围覆盖与 finding

每个变更路径都需要完整的 target 源码和 diff 证据。Finding 必须指出固定的 target commit、变更路径、与变更 target 行重叠的源码行、具体失败条件、变更如何导致该问题，以及该路径上已观察到的证据 ID。Runtime 会拒绝伪造、未观察、不完整、超出范围或占位证据。

已删除文件和二进制内容无法提供完整的 target 源码证据。无法完整读取的源码页或 diff 页也会导致范围不完整。这些情况会返回 `PARTIAL`，附带未解决问题且不保留 finding；finding 列表为空也不能免除路径覆盖要求。

`REVIEW_COMPLETE` 表示确定性证据检查确认范围完整且引用有效。它不代表变更适用于所有部署，也不能替代项目专用测试。`PARTIAL` 表示证据缺失、不受支持或无效。`BLOCKED` 表示 child cleanup 不确定，或尝试分派了可能产生副作用的工具。

<a id="saved-state-and-recovery"></a>
## 保存状态与恢复

评审记录保存在 `.agent/reviews/<task-id>/`：`TASK.json` 固定 selector、snapshot、已分类范围和 data class；`STATE.json` 保存带 revision 的阶段；`RESULT.json` 保存结果。评审 state 不含开发 writer lease。阶段依次为 `REQUEST -> SNAPSHOT -> SCOPE_CLASSIFIED -> REVIEW_INVESTIGATION -> INDEPENDENT_REVIEW -> EVIDENCE_VALIDATION`，之后进入 `REVIEW_COMPLETE`、`PARTIAL` 或 `BLOCKED`。

`RESULT.json` 保存已验证的 finding 和引用的证据 ID。它不会把 Git 源码或 diff 页复制到评审目录。

`engineering_status` 会列出已保存的评审。未完成的评审从持久化 state、snapshot 和范围恢复。相同 task ID 和 selector 调用 `engineering_review` 时会返回已保存的终态结果。如果 cleanup 或可能产生副作用的分派导致评审以 `requiresStopConfirmation` 进入 `BLOCKED`，先停止 child 和其工作，再用该 review ID 和 `confirmedStopped: true` 调用 `engineering_recover`，然后用相同 ID 和 target 再调用 `engineering_review`。恢复会保留固定 snapshot，并从 independent review 继续。

<a id="further-exploration"></a>
## 延伸阅读

- [工程任务协议](task-protocol.zh.md)
- [工程架构](architecture.zh.md)
- [Verification policy design](verification-policy-design.zh.md)

## 开发备注

无。
