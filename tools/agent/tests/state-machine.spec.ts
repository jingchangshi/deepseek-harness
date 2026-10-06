import { describe, expect, it } from 'vitest'
import { transition, TransitionError } from '../src/state-machine.ts'
import type { TaskStateRecord } from '../src/types.ts'

const initial = (): TaskStateRecord => ({
  schemaVersion: 1,
  taskId: 'sample-task',
  state: 'NEW',
  revision: 0,
  workRevision: 0,
  fixAttempts: 0,
  writer: null,
  updatedAt: '2026-10-04T00:00:00.000Z',
})

describe('task state transitions', () => {
  it('walks the legal path and keeps acceptance terminal', () => {
    let state = transition(initial(), { type: 'baseline' }, '2026-10-04T00:00:01.000Z')
    state = transition(state, { type: 'investigate' }, '2026-10-04T00:00:02.000Z')
    state = transition(state, { type: 'freeze-plan' }, '2026-10-04T00:00:03.000Z')
    state = transition(state, { type: 'start-implementation', writerToken: 'writer' }, '2026-10-04T00:00:04.000Z')
    state = transition(state, { type: 'begin-verification', writerToken: 'writer' }, '2026-10-04T00:00:05.000Z')
    state = transition(state, { type: 'complete-verification', status: 'PASS' }, '2026-10-04T00:00:06.000Z')
    state = transition(state, { type: 'begin-review' }, '2026-10-04T00:00:07.000Z')
    state = transition(state, { type: 'complete-review', decision: 'ACCEPT' }, '2026-10-04T00:00:08.000Z')
    state = transition(state, { type: 'accept' }, '2026-10-04T00:00:09.000Z')

    expect(state).toMatchObject({ state: 'ACCEPTED', revision: 9, workRevision: 1, writer: null })
    expect(() => transition(state, { type: 'accept' }, '2026-10-04T00:00:10.000Z'))
      .toThrow('accepted tasks are terminal')
  })

  it('rejects illegal transitions and competing writers', () => {
    expect(() => transition(initial(), { type: 'freeze-plan' }, '2026-10-04T00:00:01.000Z'))
      .toThrow(TransitionError)

    const implementing = transition({ ...initial(), state: 'PLAN_FROZEN' }, {
      type: 'start-implementation',
      writerToken: 'first',
    }, '2026-10-04T00:00:01.000Z')
    expect(() => transition(implementing, { type: 'start-implementation', writerToken: 'second' }, '2026-10-04T00:00:02.000Z'))
      .toThrow('writer lease is already active')
  })

  it('forces replan after the second failed repair', () => {
    let state: TaskStateRecord = { ...initial(), state: 'VERIFYING', workRevision: 1 }
    state = transition(state, { type: 'complete-verification', status: 'FAIL' }, '2026-10-04T00:00:01.000Z')
    expect(state).toMatchObject({ state: 'IMPLEMENTING', fixAttempts: 1 })
    state = transition(state, { type: 'start-implementation', writerToken: 'next' }, '2026-10-04T00:00:02.000Z')
    state = transition(state, { type: 'begin-verification', writerToken: 'next' }, '2026-10-04T00:00:03.000Z')
    state = transition(state, { type: 'complete-verification', status: 'INCOMPLETE' }, '2026-10-04T00:00:04.000Z')
    expect(state).toMatchObject({ state: 'REPLAN', fixAttempts: 2 })
  })

  it.each(['BASELINED', 'INVESTIGATED', 'PLAN_FROZEN', 'REPLAN'] as const)('permits explicit replanning from %s without granting a writer', (phase) => {
    const state: TaskStateRecord = { ...initial(), state: phase, revision: 4 }
    expect(transition(state, { type: 'replan' }, '2026-10-04T00:00:01.000Z'))
      .toMatchObject({ state: 'REPLAN', revision: 5, workRevision: 0, writer: null })
  })

  it('rejects replanning an accepted task', () => {
    expect(() => transition({ ...initial(), state: 'ACCEPTED' }, { type: 'replan' }, '2026-10-04T00:00:01.000Z'))
      .toThrow('accepted tasks are terminal')
  })
})
