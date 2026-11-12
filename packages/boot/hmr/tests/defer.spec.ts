import { describe, expect, it } from 'vitest'
import { shouldDeferProfileRefresh, TurnTracker } from '../src/defer.ts'

describe('shouldDeferProfileRefresh', () => {
  it('never defers when the bundle list did not change', () => {
    expect(shouldDeferProfileRefresh({ bundlesChanged: false, runningTurns: 3 })).toBe(false)
  })

  it('never defers when no agent turn is running', () => {
    expect(shouldDeferProfileRefresh({ bundlesChanged: true, runningTurns: 0 })).toBe(false)
  })

  it('defers exactly when the bundle list changed AND a turn is running', () => {
    expect(shouldDeferProfileRefresh({ bundlesChanged: true, runningTurns: 1 })).toBe(true)
    expect(shouldDeferProfileRefresh({ bundlesChanged: true, runningTurns: 2 })).toBe(true)
  })
})

describe('TurnTracker', () => {
  it('seeds already-running agents so a late/restarted consumer still defers', () => {
    const turns = new TurnTracker()
    turns.seed([{ id: 'a', status: 'running' }, { id: 'b', status: 'idle' }])
    expect(turns.count).toBe(1)
    // A late HMR that seeded the roster must still defer while 'a' runs.
    expect(shouldDeferProfileRefresh({ bundlesChanged: true, runningTurns: turns.count })).toBe(true)
  })

  it('applies status edges: running adds, idle/disposed removes', () => {
    const turns = new TurnTracker()
    turns.onStatus({ id: 'a', status: 'running' })
    expect(turns.count).toBe(1)
    turns.onStatus({ id: 'a', status: 'idle' })
    expect(turns.count).toBe(0)
    turns.onStatus({ id: 'b', status: 'running' })
    turns.onStatus({ id: 'c', status: 'running' })
    expect(turns.count).toBe(2)
    turns.onStatus({ id: 'b', status: 'disposed' })
    expect(turns.count).toBe(1)
    // Idle after the last turn lets a deferred bundle change apply.
    turns.onStatus({ id: 'c', status: 'idle' })
    expect(shouldDeferProfileRefresh({ bundlesChanged: true, runningTurns: turns.count })).toBe(false)
  })

  it('seeding is additive and idempotent', () => {
    const turns = new TurnTracker()
    turns.onStatus({ id: 'a', status: 'running' })
    turns.seed([{ id: 'a', status: 'running' }, { id: 'b', status: 'running' }])
    expect(turns.count).toBe(2)
  })
})
