# Agent Note: Engineering coordinator tool surface

Status: implemented

[English](2026-10-06-engineering-coordinator-tool-surface.md) | 中文

## Problem

一次记录的 engineering harness 多 Agent 运行暴露了两个失败，它们源于同一件事：Coordinator 被提供了工作流不希望它使用的工具。

运行时把 Coordinator 限制为 `engineering_run`、`engineering_status` 和 `engineering_recover`，但常驻的 `tool-subagent` 行把它的 `subagent` 工具注册进每个 Agent 自己的 scope。工具注册表只把限制层施加于某个 scope *继承*的表面；scope 自己的注册留在过滤之外，因为正是这一豁免让子 Agent 的结构化输出通道在子能力过滤下仍然存活。于是 `subagent` 行一直显示在工作流工具旁边，模型调用了它。工作流守卫拒绝了该调用，所以每次尝试都消耗一个 turn 且没有任何进展。被委派的角色看到同一行，把调用花在 `subagent` 上，随后被深度上限拒绝。

Web fetch 产生了同一类失败：`file:` URL 和 `127.0.0.1` 主机被拒绝，而消息只说明规则，于是角色重试一个永远不可能成功的形态。

## Decision

只面向 Coordinator 的组合直接移除 delegation 组，而不是在运行时过滤它；面向角色的失败会指明下一步动作。

`engineering` 和 `engineering-run` profile 构建在 Web bundle 之上。[`installationFiles`](../../../../tools/agent/src/installation.ts) 现在读取该 bundle 自带的 `standard` preset，通过 [`classifyPresetRows`](../../../../tools/agent/src/preset-rows.ts) 去掉 `delegation` 组，解析 preset 的两个 `!!js` 平台条件，并把结果写为受管 profile patch 中的一条按 id 键控的 `preset-standard` 行。组合后的树按 id 替换 bundle 行，因此 profile 层无需重述 bundle 的兄弟声明。preset 在安装时生成、而不是在 bundle 中编辑，因为自带 preset 是 Web 产品表面，其他 profile 保持其不变；而重写 `config.plugins` 的 overlay 必须重述整个子列表。

组合是唯一能抑制该行的层次。preset 子列表里的 `!!js` `disabled` 表达式不可 patch：entry patch 作用于组合后的树，而 preset 的 `plugins` 在 preset mount 时求值。运行时的 `tools.restrict()` 调用按设计无法屏蔽 own-scope 注册。

Coordinator 可见的工作还需要 `get_goal` 和 `update_goal`。工作流把它们列在 [`COORDINATOR_TOOLS`](../../../../tools/agent/runtime/index.ts) 中，因此限制保留它们、守卫放行它们。限制本身现在过滤出该 Session 实际暴露的名称，因为 `tools.restrict()` 拒绝未知名称，而某个部署可能省略 goal 工具。

角色失败会带上恢复动作。[`SubagentDepthError`](../../../../packages/subagent/subagent/src/child-agent.ts) 说明该 Session 无法继续委派，角色必须用自己的工具完成。[web-fetch 策略](../../../../packages/web/web-fetch-http/src/policy.ts)为本地路径指明 read/search 工具，并说明只有公共互联网主机可达。来自模型端点的策略拒绝被归类为 [`POLICY_REFUSAL`](../../../../packages/llm/llm/src/error.ts)。重试该路由不会成功，但只读角色可以在独立策略检查后使用其唯一配置的备用路由。

## Alternatives considered

**在 `dsh-tools` 中解决限制不匹配。** 拒绝：屏蔽 own-scope 注册会破坏子能力过滤，而子能力过滤依赖该豁免保持子 Agent 的结构化输出工具可达。

**只在调度时按名称过滤 Coordinator。** 拒绝：模型仍会在工具列表中看到 `subagent`，而正是这一点产生了那些调用。

**从自带的 Web preset 中删除 delegation 组。** 拒绝：standard preset 是产品表面，其他 profile 保持其不变。

**从 profile 层 patch preset 的子列表。** 拒绝：preset 行的 `config` 整体替换，因此 overlay 必须重述每个子项，并会静默丢弃 bundle 之后新增的任何子项。

## Consequences

engineering profile 依赖 Web bundle 的 `standard` preset 标识（`preset-standard`）及其内部的 `delegation` 组 id。bundle 重命名会让安装大声失败，而不是交付一个带 delegation 工具的 Coordinator。生成的 preset 只解析自带 preset 的平台条件；出现新的 `!!js` 条件会拒绝安装，而不是写入一个字面量、静默禁用某一行。

尚未重装 profile 的部署保留旧 patch 和旧行为；`dsh plugin install` 会重新生成它。

## Testing

[Preset 行单元测试](../../../../tools/agent/tests/preset-rows.spec.ts)覆盖哪些组存活。[安装测试](../../../../tools/agent/tests/installation.spec.ts)断言受管 profile patch 去掉 delegation 组、保留 goal 工具，并解析平台条件且不泄漏 `__jsExpr` 节点。
