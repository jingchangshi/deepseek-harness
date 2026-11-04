import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RoleId, TeamId, type TeamMemberSnapshot } from '../src/index.ts'
import { readPersistedSession } from '../src/persisted.ts'
import { stack, signal, text, testRoles } from './fixture.ts'

function provisioning(id: string): TeamMemberSnapshot {
  return {
    id: SessionId(id), name: 'architect-g1', slotId: 'architect', roleId: RoleId('architect'), generation: 1,
    description: 'design', provider: 'spawn', context: 'fresh', phase: 'provisioning',
  }
}

describe('role and slot durable recovery', () => {
  it('retains retired history, empty reserved roles, and generation counters over cold restart', async () => {
    const first = await stack()
    const member = await first.spawn('architect')
    await first.idle(member.member.id)
    await first.ctx.agentTeams.retireTeammate(first.lead, member.member.name)
    await first.ctx.sessions.flush(first.lead.session)
    await first.ctx.fiber.dispose()
    const second = await stack({}, first.storageRoot, undefined, true)
    expect(second.state().members[0]?.phase).toBe('retired')
    const next = await second.spawn('architect')
    expect(next.member).toMatchObject({ name: 'architect-g2', generation: 2, slotId: 'architect' })
    await expect(second.ctx.agentTeams.sendMessage(second.lead, { target: member.member.name, content: text('late'), signal })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
  })
  it('releases a reservation whose provisioning event was never written without resetting generation', async () => {
    const first = await stack()
    first.lead.session.append('team/slot', { version: 1, teamId: TeamId(first.lead.id), slot: {
      id: 'architect', roleId: RoleId('architect'), pinned: true, generation: 1, memberId: SessionId('not-created'),
    } })
    await first.ctx.sessions.flush(first.lead.session)
    await first.ctx.fiber.dispose()
    const second = await stack({}, first.storageRoot, undefined, true)
    await vi.waitFor(() => { expect(second.state().slots[0]?.memberId).toBeUndefined() })
    expect((await second.spawn('architect')).member.name).toBe('architect-g2')
  })
  it('settles missing provisioning children through failed and retired before releasing pinned capacity', async () => {
    const first = await stack()
    const member = provisioning('missing-child')
    first.lead.session.append('team/slot', { version: 1, teamId: TeamId(first.lead.id), slot: {
      id: member.slotId, roleId: member.roleId, pinned: true, generation: member.generation, memberId: member.id,
    } })
    first.lead.session.append('team/member', { version: 4, teamId: TeamId(first.lead.id), member })
    await first.ctx.sessions.flush(first.lead.session)
    await first.ctx.fiber.dispose()
    const second = await stack({}, first.storageRoot, undefined, true)
    await vi.waitFor(() => { expect(second.state().members[0]?.phase).toBe('retired') })
    expect(second.state().members[0]?.error).toContain('child Session recovery failed')
    expect(second.state().slots[0]).toMatchObject({ roleId: RoleId('architect'), generation: 1 })
    expect((await second.spawn('architect')).member.generation).toBe(2)
  })
  it('recovers accepted provisioning and preserves its descriptor route when the role registry changes', async () => {
    const first = await stack()
    const member = provisioning('accepted-child')
    first.lead.session.append('team/slot', { version: 1, teamId: TeamId(first.lead.id), slot: {
      id: member.slotId, roleId: member.roleId, pinned: true, generation: member.generation, memberId: member.id,
    } })
    first.lead.session.append('team/member', { version: 4, teamId: TeamId(first.lead.id), member })
    await first.ctx.sessions.flush(first.lead.session)
    await first.ctx.subagents.startActivation({ delivery: 'parent', childId: member.id, provider: 'spawn', label: member.description,
      request: { parent: first.lead, prompt: text('initial'), agentOptions: { provider: 'mock', model: 'original-route' } }, signal })
    await first.idle(member.id)
    await first.ctx.sessions.flush(first.lead.session)
    await first.ctx.fiber.dispose()
    const second = await stack({ roles: testRoles.map(role => ({ ...role, model: 'new-role-route' })) }, first.storageRoot, undefined, true)
    await vi.waitFor(() => { expect(second.state().members[0]?.phase).toBe('active') })
    await second.ctx.agentTeams.sendMessage(second.lead, { target: member.name, content: text('continue'), signal })
    await second.idle(member.id)
    const stored = await readPersistedSession(second.ctx.sessionPersistence, member.id, signal)
    const headers = stored.events.filter(event => event.type === 'request/header')
    expect(headers.every(event => event.data.header.config.model === 'original-route')).toBe(true)
    expect(second.adapter.requests).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'original-route' })]))
  })
})
