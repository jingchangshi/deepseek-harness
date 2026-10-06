/** Compose-preserving suppression of a shipped preset row for the engineering profile. */

/** One composed group after the engineering profile's delegation suppression. */
export interface PresetRowPlan {
  /** Whether the group is kept at all; false removes the whole group. */
  readonly keep: boolean
  /** Plans for the group's `config` children, in declaration order. */
  readonly children?: readonly PresetRowPlan[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether one row is the delegation group holding the standing subagent tools. */
function isDelegationGroup(row: Record<string, unknown>): boolean {
  if (row['id'] !== 'delegation' || row['group'] !== true || !Array.isArray(row['config'])) return false
  return (row['config'] as unknown[]).some(child => isRecord(child) && child['id'] === 'tool-subagent')
}

/**
 * Plan which rows of one composed preset an engineering profile keeps.
 *
 * The standing delegation row installs itself into each Agent's own tool
 * scope, which no scoped restriction can mask, so a coordinator-only profile
 * must not compose it at all. Removing the row in the profile patch cannot
 * reach it: a preset's `plugins` are evaluated when the preset mounts, after
 * patch composition, so an overlay acting on the composed entry list has no
 * view into them. This plan is applied to the re-dumped patch instead.
 *
 * Only the `delegation` group carrying a `tool-subagent` child is removed. A
 * coordinator keeps `engineering_run`, `engineering_status`,
 * `engineering_recover`, and any other row the profile declares.
 * @param groups - the registered group rows of one preset, in declaration order.
 * @returns one plan per group, in declaration order; a removed group plans `keep: false`.
 */
export function classifyPresetRows(groups: readonly unknown[]): PresetRowPlan[] {
  return groups.map((row): PresetRowPlan => {
    if (!isRecord(row)) return { keep: true }
    if (isDelegationGroup(row)) return { keep: false }
    // Only a group row carries a nested entry list; a plugin whose `config`
    // happens to be an array keeps that array verbatim.
    if (row['group'] !== true || !Array.isArray(row['config'])) return { keep: true }
    return { keep: true, children: classifyPresetRows(row['config'] as readonly unknown[]) }
  })
}

/**
 * Apply a {@link classifyPresetRows} plan to the same group list.
 *
 * A kept group keeps its own fields and only replaces its `config` child list,
 * so keys this planner does not model (schema-dependent plugin fields) survive.
 * @param groups - the registered group rows the plan was derived from.
 * @param plan - the plan returned by {@link classifyPresetRows} for those rows.
 * @returns the kept rows, with removed groups and their children absent.
 */
export function suppressPresetRows(groups: readonly unknown[], plan: readonly PresetRowPlan[]): Record<string, unknown>[] {
  const kept: Record<string, unknown>[] = []
  for (const [index, row] of groups.entries()) {
    const entry = plan[index]
    if (entry === undefined || !entry.keep || !isRecord(row)) continue
    if (entry.children === undefined) {
      kept.push(row)
      continue
    }
    kept.push({ ...row, config: suppressPresetRows(row['config'] as readonly unknown[], entry.children) })
  }
  return kept
}
