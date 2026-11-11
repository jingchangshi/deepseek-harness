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
 * keeps working through the durable projection below.
 */
interface PresetRoster {
  composedPreset(ctx: Context): string | undefined
}

/**
 * The one session-projection capability this module consumes: the durable
 * `agentPreset` record, which is the authoritative CURRENT preset.
 *
 * Declared structurally for the same reason as {@link PresetRoster}: the
 * projection is registered by the optional preset registry, which Team routing
 * reads through `ctx.get` and never takes a dependency edge on.
 */
interface PresetProjection {
  stateOf(session: Agent['session'], key: 'agentPreset'): string | null | undefined
}

/** Which rung of the preset ladder produced the observed preset id. */
export type PresetSource = 'composed' | 'projection' | 'header' | 'none'

/** One observed preset identity and the rung it was read from. */
export interface PresetSelection {
  /** The preset id this Agent runs under, or undefined when no rung could name it. */
  readonly presetId: string | undefined
  /** Which rung supplied {@link PresetSelection.presetId}. */
  readonly source: PresetSource
}

/** Which configured table a Team actually routes by. */
export type RoleTableSource = 'presetRoles' | 'roles'

/**
 * A Team's resolved role table together with the provenance of that resolution.
 *
 * The provenance exists so a model-facing surface can render WHICH preset was
 * observed and WHICH table it produced. A silent substitution of the base table
 * for a preset table is a routing defect that must be visible, not inferred
 * from prose.
 */
export interface ResolvedRoleTable {
  /** The complete role table this Team routes by. */
  readonly roles: readonly RoleSpec[]
  /** The observed preset id, or undefined when no rung could name it. */
  readonly presetId: string | undefined
  /** Which rung {@link ResolvedRoleTable.presetId} came from. */
  readonly presetSource: PresetSource
  /** Which configured table {@link ResolvedRoleTable.roles} is. */
  readonly table: RoleTableSource
  /**
   * Whether this Team routes by the base `roles` table while the deployment
   * DOES configure per-preset routing — either because the observed preset has
   * no entry, or because no preset id could be observed at all. False when
   * per-preset routing is not configured, because then the base table is the
   * only configured authority rather than a substitute for a missing one.
   */
  readonly fellBack: boolean
}

/**
 * Resolve the preset one Agent runs under, and the rung that answered.
 *
 * The live composition wins because a Lead can switch preset while blank. The
 * durable `agentPreset` Session projection is the next authority: it folds the
 * creation header's value forward through every `agent-preset/selected` event,
 * so it is the ONLY record that reflects a preset chosen after creation. The
 * creation-time header is the last rung, used only when neither the registry
 * nor the projection is composed — it is deep-frozen by design and therefore
 * reports the preset a Session STARTED with, never the one it runs under.
 * @param agent - exact live Agent whose preset is requested.
 * @returns the observed preset id and the rung that supplied it.
 */
export function presetSelectionOf(agent: Agent): PresetSelection {
  const composed = (agent.ctx.get('agentPresets') as PresetRoster | undefined)?.composedPreset(agent.ctx)
  if (composed !== undefined) return { presetId: composed, source: 'composed' }
  const projected = (agent.ctx.get('sessionProjections') as PresetProjection | undefined)
    ?.stateOf(agent.session, 'agentPreset')
  if (projected !== undefined && projected !== null) return { presetId: projected, source: 'projection' }
  const header = agent.session.header.agentPreset
  if (header !== undefined) return { presetId: header, source: 'header' }
  return { presetId: undefined, source: 'none' }
}

/**
 * Resolve the preset one Agent runs under.
 * @param agent - exact live Agent whose preset is requested.
 * @returns the observed preset id, or undefined when no rung could name it.
 */
export function presetIdOf(agent: Agent): string | undefined {
  return presetSelectionOf(agent).presetId
}

/**
 * Resolve the role table one Team uses from its Lead's preset, with provenance.
 *
 * A `presetRoles` entry replaces `roles` wholesale: a matching preset selects
 * that complete table, and every other case — an unrelated preset, an
 * unreadable preset identity, or an empty `presetRoles` — keeps the base
 * table. Resolution reads the Lead alone; a teammate never selects a table, so
 * all members of one Team share one route source.
 * @param config - resolved Team-service configuration.
 * @param lead - exact live Lead Agent whose Team role table is requested.
 * @returns the resolved table plus the preset id, the rung, and the table used.
 */
export function resolveRoleTable(config: Required<Config>, lead: Agent): ResolvedRoleTable {
  const { presetId, source } = presetSelectionOf(lead)
  const entry = presetId === undefined ? undefined : config.presetRoles[presetId]
  if (entry !== undefined) {
    return { roles: entry, presetId, presetSource: source, table: 'presetRoles', fellBack: false }
  }
  return {
    roles: config.roles,
    presetId,
    presetSource: source,
    table: 'roles',
    // Per-preset routing that exists but did not answer this Team is a
    // substitution the caller must be able to report, not an ordinary default.
    fellBack: Object.keys(config.presetRoles).length > 0,
  }
}

/**
 * Resolve the role table one Team uses from its Lead's preset.
 * @param config - resolved Team-service configuration.
 * @param lead - exact live Lead Agent whose Team role table is requested.
 * @returns the configured role table for that Lead's preset, else the base table.
 */
export function resolveRoles(config: Required<Config>, lead: Agent): readonly RoleSpec[] {
  return resolveRoleTable(config, lead).roles
}
