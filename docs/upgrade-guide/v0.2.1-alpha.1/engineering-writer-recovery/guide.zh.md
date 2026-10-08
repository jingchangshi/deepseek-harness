---
kind: upgrade-guide
description: child cleanup 状态不确定时会保留 engineering writer 权限，直到完成确认恢复。
---

# 工程 Writer 恢复

[English](guide.md) | 中文

## 变更

role child cleanup 无法确认工作已停止时，task 会保留其 active writer lease。Repository-wide writer admission 会在 writer 存在或停机状态不确定时，阻止同一或其他 task 分派工作。此状态下，`engineering_recover` 会拒绝缺少停机确认的调用；operator 确认 agent 及其 command 均已停止后，恢复才会释放 lease。直接重新规划遇到 active writer 时也会失败，并保留 lease。

## 迁移

1. `engineering_run` 返回 `requiresStopConfirmation: true` 时，停止旧 agent 及其拥有的所有 command。仅发出取消请求不能证明它们已停止。
2. 使用准确的 `taskId` 调用 `engineering_recover`，并设置 `confirmedStopped: true`。确认结果为 `REPLAN` 且 `writer: null`，然后通过 `engineering_run` 恢复任务。
3. task 不要求确认工作已停止时，传入 `confirmedStopped: false`。只有 task 没有 active writer 或不确定停机 blocker 时才能直接执行 `agentctl replan`；该命令不再清除 writer lease。
