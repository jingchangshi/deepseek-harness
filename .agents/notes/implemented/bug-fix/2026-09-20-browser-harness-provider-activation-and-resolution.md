# Agent Note: Browser Harness provider activation and package-name resolution

Status: implemented

English | [中文](2026-09-20-browser-harness-provider-activation-and-resolution.zh.md)

## Problem

The Browser Harness provider refused to activate in any real composition that mounts a skill registry.

Registering its upstream usage skill read `ctx.skills` inside the provider's own fiber, and Cordis rejects a bare property read of an undeclared service with `cannot get property "skills" without inject`.

`skills` is deliberately absent from `inject` because the service is optional: a declared injection would pend forever, and therefore refuse activation, on every composition that omits it — and omitting it is supported, since the browser tools work without the skill.

The unit suite stayed green through both defects.

It calls `Provider.apply(ctx, config)` on a root context, where the Cordis service proxy takes its direct global-store lookup (`ctx.fiber.runtime` is null → early return), so an undeclared `ctx.skills` read succeeds there and throws only inside a plugin fiber.

This is the same blind spot [post-mortem 0001](../../../../docs/postmortem/0001-acp-default-export-drops-inject.md) records: a test that mounts a plugin by hand cannot observe the topology the Loader builds.

Independently, the package failed `pnpm run verify-tsconfig-paths` from the commit that added it.

The generator emits a source alias only for a package whose declared name is exactly `@deepseek-ai/dsh-<directory>`, and this provider's directory is `browser-use-browser-harness-mcp` while its name is `@deepseek-ai/dsh-experimental-browser-use-browser-harness-mcp` — the `experimental-` prefix has no directory.

Importers resolving the package name to `src` therefore hit an unresolved path, which the coverage assertion in the [explicit-workspace-path-aliases note](../../archived/process/2026-08-27-explicit-workspace-path-aliases.md) exists to turn into a named failure.

## Decision

The provider resolves the optional registry once through `ctx.get('skills')` — the topology-independent global-store lookup — and passes it into `registerBrowserHarnessSkill(skills, …)` as a parameter.

The skill module performs no `Context` access at all, so the inject guard cannot trip regardless of which fiber reaches it, and registration stays inside a labelled `ctx.effect` so fiber disposal unregisters the provider and invalidates catalog caches.

`tsconfig.base.json` carries the hand-written alias for the name/directory mismatch, in the hand-written region the generator preserves.

## Alternatives considered

**Declare `skills` in `inject`.** Rejected: an injection is a hard requirement.

Every composition without a skill service would lose the browser-tool lane entirely rather than lose only the skill.

**Call `ctx.get('skills')` inside the skill module.** Rejected: passing the registry in keeps `skill.ts` free of Cordis, so its tests can register against a plain registry and no future call site can reintroduce a bare `ctx.skills` read.

It also matches the opportunistic `ctx.get()` consumption the [approval seam](../feature/2026-07-06-approval-seam.md) uses.

**Make the generator derive prefixed package names.** Rejected: the name === directory rule is deliberate — it is the only shape the wildcard it replaced could ever resolve — and hand-written entries are its documented escape hatch.

## Consequences

Both defects are now pinned by one keyless real-Loader test, `tests/loader-composition.spec.ts`: it boots a `cordis.yml` through the Loader with and without the skill registry and asserts the published catalog entry through a real child process.

On the pre-fix code the first case fails with the exact inject error, so the test reproduces the topology the hand-built suite cannot see.

Two costs follow from reading the registry at apply time.

`ctx.get` is not reactive, so a composition that mounts `skills` after the browser provider gets no skill registration: mount order decides, and the shipped base bundle composes the registry before provider layers are inserted.

The alias is also maintained by hand, so renaming the directory or the package requires editing it — a drift the `verify-tsconfig-paths` gate names rather than silently resolves.

## Testing

- `pnpm vitest run packages/experimental/browser-use-browser-harness-mcp` — 49 tests across four files, including the two composition cases.
- The composition test was verified to fail against the pre-fix provider source, with `Error: cannot get property "skills" without inject`.
- `pnpm run verify-tsconfig-paths` — passes with the alias and fails at HEAD without it.
- `pnpm exec tsc --noEmit -p packages/experimental/browser-use-browser-harness-mcp/tsconfig.json` — clean.
