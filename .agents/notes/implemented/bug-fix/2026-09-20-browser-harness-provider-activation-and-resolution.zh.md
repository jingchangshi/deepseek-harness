# Agent Note: Browser Harness 提供方的激活与包名解析

Status: implemented

English | [中文](2026-09-20-browser-harness-provider-activation-and-resolution.md)

## Problem

在任何挂载了技能注册表的真实组合中，Browser Harness 提供方都无法激活。注册其上游使用技能时，它在提供方自身的 fiber 内读取了 `ctx.skills`，而 Cordis 会拒绝读取未声明服务的裸属性访问，抛出 `cannot get property "skills" without inject`。`skills` 被刻意排除在 `inject` 之外，因为该服务是可选的：一旦声明注入，凡是省略它的组合都会永久挂起，进而拒绝激活——而省略是被支持的，因为没有技能时浏览器工具依然可用。

单元测试对这两个缺陷都保持通过。它在根上下文上调用 `Provider.apply(ctx, config)`，此时 Cordis 的服务代理走的是直接全局存储查找（`ctx.fiber.runtime` 为 null → 提前返回），因此未声明的 `ctx.skills` 读取在那里会成功，而只有在插件 fiber 内才会抛出。这与 [post-mortem 0001](../../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md) 记录的盲区完全相同：手工挂载插件的测试无法观察到 Loader 实际构建的拓扑结构。

与此独立的是，该包自被引入的提交起就一直无法通过 `pnpm run verify-tsconfig-paths`。生成器只为声明名恰为 `@deepseek-ai/dsh-<目录>` 的包生成源码别名，而本提供方的目录是 `browser-use-browser-harness-mcp`，包名却是 `@deepseek-ai/dsh-experimental-browser-use-browser-harness-mcp`——`experimental-` 前缀没有对应的目录。于是任何把包名解析到 `src` 的导入方都会遇到无法解析的路径，而 [explicit-workspace-path-aliases 笔记](../../archived/process/2026-08-27-explicit-workspace-path-aliases.md) 中的覆盖断言正是要把这种情况变成具名失败。

## Decision

提供方通过 `ctx.get('skills')` 一次性解析这个可选注册表——该查找与拓扑无关——并把它作为参数传给 `registerBrowserHarnessSkill(skills, …)`。技能模块完全不执行任何 `Context` 访问，因此无论哪个 fiber 触达它，注入守卫都不可能被触发；注册仍包在带标签的 `ctx.effect` 中，因此 fiber 销毁会注销该提供方并使目录缓存失效。

`tsconfig.base.json` 在生成器保留的手写区域中携带这条名称/目录不匹配所需的手写别名。

## Alternatives considered

**把 `skills` 声明进 `inject`。** 否决：注入是硬性要求。任何没有技能服务的组合都会因此失去整条浏览器工具链路，而不是仅失去技能。

**在技能模块内部调用 `ctx.get('skills')`。** 否决：把注册表传入可以让 `skill.ts` 完全不依赖 Cordis，其测试因而可以直接针对一个普通注册表进行注册，且未来任何调用点都无法重新引入裸的 `ctx.skills` 读取。这也与 [approval seam](../feature/2026-07-06-approval-seam.zh.md) 使用的机会式 `ctx.get()` 消费方式一致。

**让生成器推导带前缀的包名。** 否决：name === directory 这条规则是刻意为之——它是被替换掉的通配符唯一能够解析的形态，而手写条目是它明确记载的逃生口。

## Consequences

两个缺陷现在都由同一个无密钥的真实 Loader 测试钉住，即 `tests/loader-composition.spec.ts`：它通过 Loader 启动一份 `cordis.yml`，分别在有、无技能注册表两种情况下引导，并通过真实子进程断言已发布的目录条目。在修复前的代码上，第一个用例会以精确的注入错误失败，因此该测试复现了手工挂载套件无法看到的拓扑。

在 apply 时刻读取注册表带来两项代价。`ctx.get` 不是响应式的，因此把 `skills` 挂载在 browser 提供方之后的组合不会得到技能注册：挂载顺序决定结果，而已发布的基础 bundle 会在插入提供方层之前先组合注册表。该别名同样需要手工维护，因此重命名目录或包时都必须手动修改——而 `verify-tsconfig-paths` 门槛会具名报出这种偏差，而不是静默地解析。

## Testing

- `pnpm vitest run packages/experimental/browser-use-browser-harness-mcp` —— 四个文件共 49 个测试，其中包含两个组合用例。
- 该组合测试已验证在修复前的提供方源码上失败，错误为 `Error: cannot get property "skills" without inject`。
- `pnpm run verify-tsconfig-paths` —— 带别名时通过，在 HEAD 上去掉别名则失败。
- `pnpm exec tsc --noEmit -p packages/experimental/browser-use-browser-harness-mcp/tsconfig.json` —— 干净。
