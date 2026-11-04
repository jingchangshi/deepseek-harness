import { describe, expect, it } from 'vitest'
import { SessionId, SessionSeq, type SessionEvent, type SessionEventMap } from '@deepseek-ai/dsh-session'
import { emptyTeamState, teamProjectionDefinition, teamProjectionView } from '../src/projection.ts'
import { RoleId, TeamId, type TeamMemberSnapshot, type TeamSlotSnapshot } from '../src/types.ts'

const root = SessionId('root')
const child = SessionId('child')
const slot: TeamSlotSnapshot = { id: 'architect', pinned: true, roleId: RoleId('architect'), generation: 1, memberId: child }
const member: TeamMemberSnapshot = { id: child, name: 'architect-g1', roleId: RoleId('architect'), slotId: 'architect', generation: 1, description: 'design', provider: 'spawn', context: 'fresh', phase: 'provisioning' }
function event<T extends 'team/member' | 'team/slot'>(type: T, data: SessionEventMap[T]): SessionEvent<T> {
  return { type, data, seq: SessionSeq(0), time: 0 } as SessionEvent<T>
}
function fold(events: readonly SessionEvent[]) {
  return events.reduce((state, entry) => teamProjectionDefinition.apply(state, entry), emptyTeamState(root))
}
const reserve = event('team/slot', { version: 1, teamId: TeamId(root), slot })
const provision = event('team/member', { version: 4, teamId: TeamId(root), member })
const active = event('team/member', { version: 4, teamId: TeamId(root), member: { ...member, phase: 'active' } })

describe('role and slot projection', () => {
  it('publishes slot reservations and member identities through a version six checkpoint', () => {
    const state = fold([reserve, provision, active])
    expect(state.failure).toBeUndefined()
    expect(teamProjectionDefinition.stateVersion).toBe(6)
    expect(teamProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
    expect(teamProjectionView(state)).toMatchObject({ slots: [slot], members: [expect.anything(), { id: child, name: member.name, role: 'teammate', roleId: member.roleId, slotId: slot.id, generation: 1, phase: 'active' }] })
  })
  it.each([
    { ...slot, pinned: false },
    { ...slot, roleId: RoleId('explorer') },
    { ...slot, generation: 0 },
    { ...slot, id: 'other' },
  ])('rejects invalid reservation changes %#', (changed) => {
    const state = fold([reserve, provision, event('team/slot', { version: 1, teamId: TeamId(root), slot: changed })])
    expect(state.failure).toBeDefined()
  })
  it('rejects member creation without a matching reservation', () => {
    expect(fold([provision]).failure).toContain('binding mismatch')
  })
  it('makes member identity immutable and retired absorbing', () => {
    const changed = event('team/member', { version: 4, teamId: TeamId(root), member: { ...member, generation: 2, phase: 'active' } })
    expect(fold([reserve, provision, changed]).failure).toBeDefined()
    const retired = event('team/member', { version: 4, teamId: TeamId(root), member: { ...member, phase: 'retired' } })
    expect(fold([reserve, provision, active, retired]).failure).toBeUndefined()
    expect(fold([reserve, provision, active, retired, active]).failure).toContain('invalid retired')
  })
  it('allows retirement then release while retaining generation and reserved role', () => {
    const retired = event('team/member', { version: 4, teamId: TeamId(root), member: { ...member, phase: 'retired' } })
    const { memberId: _memberId, ...empty } = slot
    const release = event('team/slot', { version: 1, teamId: TeamId(root), slot: empty })
    expect(fold([reserve, provision, active, release]).failure).toBeDefined()
    const state = fold([reserve, provision, active, retired, release])
    expect(state.failure).toBeUndefined()
    expect(state.slots).toEqual([empty])
    expect(teamProjectionView(state).slots).toEqual([empty])
  })
  it('ignores inherited records and freezes after invalid input', () => {
    expect(fold([event('team/slot', { version: 1, teamId: TeamId('ancestor'), slot })]).slots).toEqual([])
    const failed = fold([provision])
    expect(teamProjectionDefinition.apply(failed, reserve)).toBe(failed)
  })
})


describe('slot checkpoint replay', () => {
  it('produces the same state from a checkpoint plus tail as a full replay across generations', () => {
    const retired = event('team/member', { version: 4, teamId: TeamId(root), member: { ...member, phase: 'retired' } })
    const { memberId: _memberId, ...empty } = slot
    const release = event('team/slot', { version: 1, teamId: TeamId(root), slot: empty })
    const next = { ...member, id: SessionId('next'), name: 'architect-g2', generation: 2 }
    const tail = [retired, release,
      event('team/slot', { version: 1, teamId: TeamId(root), slot: { ...slot, memberId: next.id, generation: 2 } }),
      event('team/member', { version: 4, teamId: TeamId(root), member: next }),
    ]
    const checkpoint = teamProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(fold([reserve, provision, active]))))
    const restored = tail.reduce((state, entry) => teamProjectionDefinition.apply(state, entry), checkpoint)
    expect(restored.failure).toBeUndefined()
    expect(restored).toEqual(fold([reserve, provision, active, ...tail]))
  })
  it('rejects generation reuse and multiple slots for one member', () => {
    const duplicate = event('team/slot', { version: 1, teamId: TeamId(root), slot: { ...slot, id: 'duplicate' } })
    expect(fold([reserve, duplicate]).failure).toContain('multiple slots')
    const changed = event('team/slot', { version: 1, teamId: TeamId(root), slot: { ...slot, generation: 2 } })
    expect(fold([reserve, changed]).failure).toContain('immutable')
  })
})
