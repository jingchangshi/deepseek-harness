/** Per-preset role-route resolution: the single authority for a Team's role table. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Config, RoleSpec } from './types.ts'

/**
 * The one preset-registry capability this module consumes: map an Agent's
 * context to the preset id it is currently composed under.
 *
 * Declared structurally on purpose. The preset registry is an optional host
 * package, so Team routing reads it through the documented `ctx.get` pattern
 * and never takes a dependency edge on it; a deployment without the registry
 * keeps working through the durable session header below.
 */
interface PresetRoster {
  composedPreset(ctx: Context): string | undefined
}

/**
 * Resolve the preset one Agent runs under.
 *
 * The live composition wins because a Lead can switch preset while blank; the
 * durable session header is the fallback for a Lead whose composition is no
 * longer queryable, such as a cold resume where no preset roster is composed.
 * @param agent - exact live Agent whose preset is requested.
 * @returns the composed preset id, else the durable header preset id, else undefined.
 */
export function presetIdOf(agent: Agent): string | undefined {
  const presets = agent.ctx.get('agentPresets') as PresetRoster | undefined
  return presets?.composedPreset(agent.ctx) ?? agent.session.header.agentPreset
}

/**
 * Resolve the role table one Team uses from its Lead's preset.
 *
 * A `presetRoles` entry replaces `roles` wholesale: a matching preset selects
 * that complete table, and every other case — an unrelated preset, an
 * unreadable preset identity, or an empty `presetRoles` — keeps the base
 * table. Resolution reads the Lead alone; a teammate never selects a table, so
 * all members of one Team share one route source.
 * @param config - resolved Team-service configuration.
 * @param lead - exact live Lead Agent whose Team role table is requested.
 * @returns the configured role table for that Lead's preset, else the base table.
 */
export function resolveRoles(config: Required<Config>, lead: Agent): readonly RoleSpec[] {
  const presetId = presetIdOf(lead)
  if (presetId === undefined) return config.roles
  return config.presetRoles[presetId] ?? config.roles
}
