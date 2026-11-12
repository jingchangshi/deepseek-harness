/** Decide whether a live profile recomposition must wait for running agent turns. */

/** The facts one profile-configuration refresh observes before recomposing. */
export interface ProfileRefreshFacts {
  /** True when the profile's `dsh.profile.bundles` list differs from the running one. */
  readonly bundlesChanged: boolean
  /** Number of live agents currently executing a turn. */
  readonly runningTurns: number
}

/** One agent's identity and lifecycle status, as the roster/status edge reports them. */
export interface TrackedAgent {
  readonly id: unknown
  readonly status?: string
}

/**
 * Maintains the set of agents currently executing a turn.
 *
 * A consumer seeds it from the live roster at subscription time, so a late or
 * restarted consumer still sees turns that were already running, then applies
 * every subsequent `agent/status` edge. This is why an absent/empty tracker is a
 * trusted "no known running turn" only for a freshly seeded consumer, not a guess.
 */
export class TurnTracker {
  private readonly active = new Set<string>()

  /**
   * Seed from a roster snapshot so already-running turns are counted.
   * @param agents - the current roster (or any snapshot) of tracked agents.
   */
  seed(agents: Iterable<TrackedAgent>): void {
    for (const agent of agents) {
      if (agent.status === 'running') this.active.add(String(agent.id))
    }
  }

  /**
   * Apply one agent status edge; only `'running'` counts as an active turn.
   * @param agent - the agent whose status changed.
   */
  onStatus(agent: TrackedAgent): void {
    const id = String(agent.id)
    if (agent.status === 'running') this.active.add(id)
    else this.active.delete(id)
  }

  /** Number of agents currently executing a turn. */
  get count(): number {
    return this.active.size
  }
}

/**
 * Whether a profile refresh must be deferred rather than applied now.
 *
 * A bundle-list change restarts the plugin entries that carry `presetRoles` and
 * the Team tool plane; applying it while an agent turn is mid-flight aborts the
 * turn's PTC program ("code run failed (abort)") and transiently unregisters the
 * agent-scoped Team tools ("unknown tool ..."). Only that specific case defers:
 * a patch-only change (bundles unchanged) or any change with no running turn is
 * applied immediately, exactly as before.
 * @param facts - what the refresh observed.
 * @returns `true` when the caller must postpone recomposition until idle.
 */
export function shouldDeferProfileRefresh(facts: ProfileRefreshFacts): boolean {
  return facts.bundlesChanged && facts.runningTurns > 0
}
