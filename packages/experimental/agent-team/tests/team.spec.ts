import { afterEach, describe, expect, it, vi } from 'vitest'
import TeamService, { DEFAULT_ROLES, DEFAULT_SLOT_PLAN, RoleId } from '../src/index.ts'
import { readPersistedSession } from '../src/persisted.ts'
import { stack, testRoles, signal, text } from './fixture.ts'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('message target role assertions', () => {
  it('accepts a message when the explicit target role matches', async () => {
    const team = await stack({}, undefined, ['hang'])
    const target = await team.spawn('explorer')
    const delivered: string[] = []
    team.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent.id === target.member.id) delivered.push(message.id)
    })
    const receipt = await team.ctx.agentTeams.sendMessage(team.lead, {
      target: target.member.name, expectedRole: RoleId('explorer'), content: text('explore files'), signal,
    })
    expect(delivered).toEqual([receipt.messageId])
  })
  it('rejects a mismatched target role before any inbox delivery', async () => {
    const team = await stack({}, undefined, ['hang'])
    const target = await team.spawn('architect')
    const delivered: string[] = []
    team.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent.id === target.member.id) delivered.push(message.id)
    })
    await expect(team.ctx.agentTeams.sendMessage(team.lead, {
      target: target.member.name, expectedRole: RoleId('explorer'), content: text('explore files'), signal,
    })).rejects.toMatchObject({
      code: 'TEAM_ROLE_MISMATCH',
      message: `message target "${target.member.name}" is role "architect", expected "explorer"`,
    })
    expect(delivered).toEqual([])
  })
  it('permits cross-role communication when expectedRole is omitted', async () => {
    const team = await stack({}, undefined, ['hang', 'hang'])
    const explorer = await team.spawn('explorer')
    const architect = await team.spawn('architect')
    const caller = team.ctx.agents.get(explorer.member.id)!
    const delivered: string[] = []
    team.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent.id === architect.member.id) delivered.push(message.id)
    })
    const receipt = await team.ctx.agentTeams.sendMessage(caller, {
      target: architect.member.name, content: text('please review this exploration conclusion'), signal,
    })
    expect(delivered).toEqual([receipt.messageId])
  })
})

describe('managed Team roles and slots', () => {
  it('prefers the reserved role position and then flexible capacity', async () => {
    const team = await stack()
    const first = await team.spawn('explorer')
    const second = await team.spawn('explorer')
    expect(first.member).toMatchObject({ roleId: RoleId('explorer'), slotId: 'explorer', generation: 1, name: 'explorer-g1' })
    expect(second.member).toMatchObject({ slotId: 'flex-1', name: 'flex-1-g1' })
    expect(team.state().slots).toHaveLength(8)
  })
  it('rebuilds the same reserved position with a new identity and name', async () => {
    const team = await stack()
    const first = await team.spawn('architect')
    await team.idle(first.member.id)
    await team.ctx.agentTeams.retireTeammate(team.lead, first.member.name)
    const second = await team.spawn('architect')
    expect(second.member).toMatchObject({ slotId: 'architect', generation: 2, name: 'architect-g2' })
    expect(second.member.id).not.toBe(first.member.id)
    expect(team.state().members[0]?.phase).toBe('retired')
  })
  it('applies role concurrency independently of global capacity', async () => {
    const team = await stack({ roles: testRoles.map(role => ({ ...role, maxConcurrent: 1 })) })
    await team.spawn('explorer')
    await expect(team.spawn('explorer')).rejects.toMatchObject({ code: 'TEAM_ROLE_FULL' })
    await expect(team.spawn('unknown')).rejects.toMatchObject({ code: 'TEAM_UNKNOWN_ROLE' })
    expect(team.state().members).toHaveLength(1)
  })
  it('requires compatible roles on task claim and reassignment', async () => {
    const team = await stack({}, undefined, ['hang'])
    const architect = await team.spawn('architect')
    const task = await team.ctx.agentTeams.createTask(team.lead, { subject: 'explore', description: 'explore files', requiredRole: RoleId('explorer') })
    await expect(team.ctx.agentTeams.updateTask(team.ctx.agents.get(architect.member.id)!, { taskId: task.id, expectedRevision: 1, action: 'claim' })).rejects.toMatchObject({ code: 'TEAM_ROLE_MISMATCH' })
    await expect(team.ctx.agentTeams.updateTask(team.lead, { taskId: task.id, expectedRevision: 1, action: 'reassign', owner: architect.member.name })).rejects.toMatchObject({ code: 'TEAM_ROLE_MISMATCH' })
    expect(team.ctx.agentTeams.getTask(team.lead, task.id)).toMatchObject({ revision: 1, requiredRole: RoleId('explorer') })
  })
})


describe('per-preset role tables', () => {
  // A replacement table must repeat every reserved role, so both fixtures below
  // differ from the base table only in the model each role routes to.
  const table = (suffix: string) => testRoles.map(role => ({ ...role, model: `preset-${suffix}-${role.id}` }))

  it('routes a spawn through the table of the Lead preset', async () => {
    const team = await stack({
      presetRoles: { 'ai-compiler-magpie': table('magpie'), 'ai-compiler': table('corp') },
    }, undefined, undefined, false, 'ai-compiler-magpie')
    const spawned = await team.spawn('architect')
    await team.idle(spawned.member.id)
    expect(team.adapter.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'mock', model: 'preset-magpie-architect' }),
    ]))
    expect(team.adapter.requests).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'preset-corp-architect' }),
    ]))
  })

  it('falls back to the base role table when the Lead preset has no entry', async () => {
    const team = await stack({
      presetRoles: { 'ai-compiler-magpie': table('magpie') },
    }, undefined, undefined, false, 'some-other-preset')
    const spawned = await team.spawn('architect')
    await team.idle(spawned.member.id)
    expect(team.adapter.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'mock', model: 'mock' }),
    ]))
    expect(team.adapter.requests).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'preset-magpie-architect' }),
    ]))
  })

  it('keeps the base table when no preset is composed at all', async () => {
    const team = await stack({ presetRoles: { 'ai-compiler-magpie': table('magpie') } })
    const spawned = await team.spawn('architect')
    await team.idle(spawned.member.id)
    expect(team.adapter.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'mock', model: 'mock' }),
    ]))
  })

  it('resolves the same table for a teammate as for its Lead', async () => {
    const team = await stack({ presetRoles: { 'ai-compiler-magpie': table('magpie') } },
      undefined, ['hang'], false, 'ai-compiler-magpie')
    const spawned = await team.spawn('architect')
    const teammate = team.ctx.agents.get(spawned.member.id)!
    expect(team.ctx.agentTeams.rolesFor(teammate).map(role => role.model))
      .toEqual(team.ctx.agentTeams.rolesFor(team.lead).map(role => role.model))
  })

  it('rejects a role table that cannot fill the shared reserved slots', async () => {
    // `slotPlan` is deployment-wide, so a preset table omitting a reserved role
    // could never staff that position.
    await expect(stack({
      presetRoles: { 'ai-compiler-magpie': [testRoles[0]!] },
    })).rejects.toThrow(/slotPlan/)
  })

  it('validates every preset table by the same role rules as the base table', async () => {
    await expect(stack({
      presetRoles: { 'ai-compiler-magpie': [{ ...testRoles[0]!, model: '' }] },
    })).rejects.toThrow(/presetRoles\.ai-compiler-magpie/)
    await expect(stack({
      presetRoles: { 'ai-compiler-magpie': testRoles.map(role => ({ ...role, maxConcurrent: 0 })) },
    })).rejects.toThrow(/maxConcurrent/)
    await expect(stack({
      presetRoles: { 'ai-compiler-magpie': [...testRoles, testRoles[0]!] },
    })).rejects.toThrow(/presetRoles\.ai-compiler-magpie/)
  })
})

describe('role routes and capacity', () => {
  it.each(DEFAULT_ROLES)('records the $id role route in the child request header', async (role) => {
    const team = await stack({ roles: DEFAULT_ROLES })
    team.ctx.llm.registerAdapter(['magpie', 'corp'], team.adapter)
    const spawned = await team.spawn(role.id)
    await team.idle(spawned.member.id)
    const stored = await readPersistedSession(team.ctx.sessionPersistence, spawned.member.id, signal)
    const header = stored.events.find(event => event.type === 'request/header')
    expect(header).toMatchObject({ data: { header: { config: { provider: role.provider, model: role.model } } } })
    expect(team.adapter.requests).toEqual(expect.arrayContaining([expect.objectContaining({ provider: role.provider, model: role.model })]))
  })
  it('retains route overrides for fork context and injects the role persona', async () => {
    const role = { ...testRoles[0]!, model: 'role-specific', maxTokens: 1234, persona: 'You design architectures.' }
    const team = await stack({ roles: [role], slotPlan: { reserved: [{ id: 'architect', roleId: role.id }], flex: [] } })
    const spawned = await team.spawn('architect', { context: 'fork' })
    await team.idle(spawned.member.id)
    expect(team.adapter.requests).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'mock', model: role.model, maxTokens: 1234 })]))
    const stored = await readPersistedSession(team.ctx.sessionPersistence, spawned.member.id, signal)
    expect(stored.events.find(event => event.type === 'user/message')).toMatchObject({ data: { content: [
      { type: 'text', text: role.persona }, { type: 'text', text: 'work' },
    ] } })
  })
  it('defaults to four reserved and four flexible slots with the validated role table', () => {
    expect(DEFAULT_SLOT_PLAN.reserved.map(slot => slot.id)).toEqual(['architect', 'reviewer', 'explorer', 'implementer'])
    expect(DEFAULT_SLOT_PLAN.flex).toHaveLength(4)
    expect(DEFAULT_ROLES.map(role => role.maxConcurrent)).toEqual([1, 2, 2, 1, 1, 1])
    expect(DEFAULT_ROLES.every(role => !('maxTokens' in role) && !('reasoningEffort' in role))).toBe(true)
    expect(TeamService.Config({}).maxMembers).toBe(8)
  })
  it('validates topology capacity, slot identities, role references and role routes on startup', async () => {
    await expect(stack({ maxMembers: 7 })).rejects.toThrow(/slotPlan/)
    await expect(stack({ slotPlan: { reserved: [], flex: ['same', 'same'] } })).rejects.toThrow(/slotPlan/)
    await expect(stack({ slotPlan: { reserved: [{ id: 'missing', roleId: RoleId('missing') }], flex: [] } })).rejects.toThrow(/slotPlan/)
    await expect(stack({ roles: [{ ...testRoles[0]!, model: '' }] })).rejects.toThrow(/roles/)
  })
  it('returns capacity backpressure while an unused reserved slot remains protected', async () => {
    const team = await stack({ maxMembers: 2, slotPlan: { reserved: [{ id: 'architect', roleId: RoleId('architect') }], flex: ['flex'] } })
    await team.spawn('explorer')
    await expect(team.spawn('implementer')).rejects.toMatchObject({ code: 'TEAM_NO_CAPACITY' })
    expect(team.state().slots.find(slot => slot.id === 'architect')?.memberId).toBeUndefined()
  })
  it('reserves each slot once under simultaneous starts and counts provisioning against the role limit', async () => {
    const team = await stack({ roles: testRoles.map(role => ({ ...role, maxConcurrent: 1 })) })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const start = team.ctx.subagents.startActivation.bind(team.ctx.subagents)
    const spy = vi.spyOn(team.ctx.subagents, 'startActivation').mockImplementation(async (spec) => {
      entered.resolve(undefined)
      await release.promise
      return await start(spec)
    })
    const first = team.spawn('architect')
    try {
      await entered.promise
      expect(team.state().members[0]?.phase).toBe('provisioning')
      await expect(team.spawn('architect')).rejects.toMatchObject({ code: 'TEAM_ROLE_FULL' })
    } finally { release.resolve(undefined) }
    await first
    spy.mockRestore()
    expect(team.state().members).toHaveLength(1)
  })
})

describe('idle retention and reclamation', () => {
  it('retains pinned context while reclaiming an expired flex instance into a new generation', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const team = await stack({ maxMembers: 2, memberIdleGraceMs: 100,
      slotPlan: { reserved: [{ id: 'architect', roleId: RoleId('architect') }], flex: ['flex'] } })
    const pinned = await team.spawn('architect')
    const flexible = await team.spawn('explorer')
    await Promise.all([team.idle(pinned.member.id), team.idle(flexible.member.id)])
    now = 101
    const replacement = await team.spawn('implementer')
    expect(replacement.member).toMatchObject({ slotId: 'flex', generation: 2, name: 'flex-g2' })
    expect(team.state().members.find(member => member.id === pinned.member.id)?.phase).toBe('active')
    expect(team.state().members.find(member => member.id === flexible.member.id)?.phase).toBe('retired')
    expect(team.state().slots.find(slot => slot.id === 'architect')).toMatchObject({ pinned: true, roleId: RoleId('architect'), memberId: pinned.member.id })
    await expect(team.ctx.agentTeams.sendMessage(team.lead, { target: flexible.member.name, content: text('late'), signal })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
  })
  it('starts grace from each member idle edge rather than the root Team identity', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const team = await stack({ maxMembers: 1, memberIdleGraceMs: 100, slotPlan: { reserved: [], flex: ['flex'] } })
    now = 500
    const member = await team.spawn('explorer')
    await team.idle(member.member.id)
    now = 550
    await expect(team.spawn('implementer')).rejects.toMatchObject({ code: 'TEAM_NO_CAPACITY' })
    now = 601
    expect((await team.spawn('implementer')).member.generation).toBe(2)
  })
  it('never drains useful members for an unknown role, invalid slot, bad text, or full role', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const team = await stack({ memberIdleGraceMs: 100, roles: testRoles.map(role => ({ ...role, maxConcurrent: 1 })) })
    const architect = await team.spawn('architect')
    const flex = await team.spawn('challenger')
    await Promise.all([team.idle(architect.member.id), team.idle(flex.member.id)])
    now = 101
    const drain = vi.spyOn(team.ctx.subagents, 'drainChildren')
    await expect(team.spawn('unknown')).rejects.toMatchObject({ code: 'TEAM_UNKNOWN_ROLE' })
    await expect(team.spawn('explorer', { slotId: 'architect' })).rejects.toMatchObject({ code: 'TEAM_INVALID_SLOT' })
    await expect(team.spawn('explorer', { description: ' ' })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(team.spawn('architect')).rejects.toMatchObject({ code: 'TEAM_ROLE_FULL' })
    expect(drain).not.toHaveBeenCalled()
    expect(team.state().members.every(member => member.phase === 'active')).toBe(true)
  })
  it('protects a flex member that owns an unfinished task', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const team = await stack({ maxMembers: 1, memberIdleGraceMs: 100, slotPlan: { reserved: [], flex: ['flex'] } })
    const member = await team.spawn('explorer')
    await team.idle(member.member.id)
    const task = await team.ctx.agentTeams.createTask(team.lead, { subject: 'explore', description: 'open', requiredRole: RoleId('explorer') })
    await team.ctx.agentTeams.updateTask(team.lead, { taskId: task.id, expectedRevision: 1, action: 'reassign', owner: member.member.name })
    now = 101
    await expect(team.spawn('implementer')).rejects.toMatchObject({ code: 'TEAM_NO_CAPACITY' })
    await expect(team.ctx.agentTeams.retireTeammate(team.lead, member.member.name)).rejects.toMatchObject({ code: 'TEAM_MEMBER_BUSY' })
    expect(team.state().members[0]?.phase).toBe('active')
  })
  it('protects a running flex member even after grace and refuses explicit retirement', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const team = await stack({ maxMembers: 1, memberIdleGraceMs: 100, slotPlan: { reserved: [], flex: ['flex'] } }, undefined, ['hang'])
    const member = await team.spawn('explorer')
    now = 1000
    await expect(team.spawn('implementer')).rejects.toMatchObject({ code: 'TEAM_NO_CAPACITY' })
    await expect(team.ctx.agentTeams.retireTeammate(team.lead, member.member.name)).rejects.toMatchObject({ code: 'TEAM_MEMBER_BUSY' })
  })
  it('records failed then retired and releases a reserved slot after activation failure', async () => {
    const team = await stack()
    const spy = vi.spyOn(team.ctx.subagents, 'startActivation').mockRejectedValueOnce(new Error('activation failed'))
    await expect(team.spawn('architect')).rejects.toThrow('activation failed')
    spy.mockRestore()
    expect(team.state().members[0]?.phase).toBe('retired')
    expect(team.state().slots.find(slot => slot.id === 'architect')).toMatchObject({ roleId: RoleId('architect'), generation: 1 })
    expect(team.state().slots.find(slot => slot.id === 'architect')?.memberId).toBeUndefined()
    expect(team.lead.session.snapshotEvents().filter(event => event.type === 'team/member').map(event => event.data.member.phase)).toEqual(['provisioning', 'failed', 'retired'])
    expect((await team.spawn('architect')).member.name).toBe('architect-g2')
  })
  it('keeps member and slot ownership when drain fails and allows a later retry', async () => {
    const team = await stack()
    const member = await team.spawn('architect')
    await team.idle(member.member.id)
    const drain = vi.spyOn(team.ctx.subagents, 'drainChildren').mockRejectedValueOnce(new Error('drain failed'))
    await expect(team.ctx.agentTeams.retireTeammate(team.lead, member.member.name)).rejects.toThrow('drain failed')
    expect(team.state().members[0]?.phase).toBe('active')
    expect(team.state().slots.find(slot => slot.id === 'architect')?.memberId).toBe(member.member.id)
    drain.mockRestore()
    expect((await team.ctx.agentTeams.retireTeammate(team.lead, member.member.name)).status).toBe('retired')
    expect((await team.ctx.agentTeams.retireTeammate(team.lead, member.member.name)).status).toBe('retired')
  })
})

describe('shared admission races', () => {
  it('closes reassignment and message admission while retirement drains a selected child', async () => {
    const team = await stack()
    const member = await team.spawn('challenger')
    await team.idle(member.member.id)
    const task = await team.ctx.agentTeams.createTask(team.lead, { subject: 'next', description: 'next' })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const drain = team.ctx.subagents.drainChildren.bind(team.ctx.subagents)
    const spy = vi.spyOn(team.ctx.subagents, 'drainChildren').mockImplementation(async (root, ids) => {
      entered.resolve(undefined)
      await release.promise
      await drain(root, ids)
    })
    const retiring = team.ctx.agentTeams.retireTeammate(team.lead, member.member.name)
    await entered.promise
    const assignment = team.ctx.agentTeams.updateTask(team.lead, { taskId: task.id, expectedRevision: 1, action: 'reassign', owner: member.member.name })
    const sending = team.ctx.agentTeams.sendMessage(team.lead, { target: member.member.name, content: text('late'), signal })
    const deniedAssignment = expect(assignment).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    const deniedSend = expect(sending).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    release.resolve(undefined)
    await Promise.all([retiring, deniedAssignment, deniedSend])
    spy.mockRestore()
    expect(team.ctx.agentTeams.getTask(team.lead, task.id).ownerName).toBeUndefined()
  })
  it('holds retirement until a cold message is accepted and then protects the running recipient', async () => {
    const team = await stack({}, undefined, [() => [], 'hang'])
    const member = await team.spawn('explorer')
    await team.idle(member.member.id)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const resume = team.ctx.agents.resume.bind(team.ctx.agents)
    const spy = vi.spyOn(team.ctx.agents, 'resume').mockImplementation(async (request) => {
      entered.resolve(undefined)
      await release.promise
      return await resume(request)
    })
    const sending = team.ctx.agentTeams.sendMessage(team.lead, { target: member.member.name, content: text('resume'), signal })
    await entered.promise
    const retiring = team.ctx.agentTeams.retireTeammate(team.lead, member.member.name)
    const denied = expect(retiring).rejects.toMatchObject({ code: 'TEAM_MEMBER_BUSY' })
    release.resolve(undefined)
    await sending
    await denied
    spy.mockRestore()
    expect(team.state().members[0]?.phase).toBe('active')
  })
})


describe('reclaim ordering and drain ownership', () => {
  it('chooses the oldest member idle edge even when creation order is reversed', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const team = await stack({ maxMembers: 2, memberIdleGraceMs: 100, slotPlan: { reserved: [], flex: ['one', 'two'] } })
    const first = await team.spawn('explorer')
    const second = await team.spawn('explorer')
    await Promise.all([team.idle(first.member.id), team.idle(second.member.id)])
    now = 50
    await team.ctx.agentTeams.sendMessage(team.lead, { target: first.member.name, content: text('new work'), signal })
    await team.idle(first.member.id)
    now = 151
    const next = await team.spawn('implementer')
    expect(next.member.slotId).toBe('two')
    expect(team.state().members.find(member => member.id === first.member.id)?.phase).toBe('active')
    expect(team.state().members.find(member => member.id === second.member.id)?.phase).toBe('retired')
  })
  it('holds message admission through a slow drain beyond the runtime disposal wait budget', async () => {
    const team = await stack({ disposalTimeoutMs: 10 })
    const member = await team.spawn('explorer')
    await team.idle(member.member.id)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const drain = team.ctx.subagents.drainChildren.bind(team.ctx.subagents)
    const spy = vi.spyOn(team.ctx.subagents, 'drainChildren').mockImplementation(async (root, ids) => {
      entered.resolve(undefined)
      await release.promise
      await drain(root, ids)
    })
    const retired = team.ctx.agentTeams.retireTeammate(team.lead, member.member.name)
    await entered.promise
    let delivered = false
    const message = team.ctx.agentTeams.sendMessage(team.lead, { target: member.member.name, content: text('late'), signal })
    void message.then(() => { delivered = true }, () => undefined)
    const denied = expect(message).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    try {
      await vi.advanceTimersByTimeAsync(20)
      expect(delivered).toBe(false)
      expect(team.state().members[0]?.phase).toBe('active')
    } finally { release.resolve(undefined) }
    await Promise.all([retired, denied])
    spy.mockRestore()
    vi.useRealTimers()
  })
  it('admits a matching task claim and restricts retirement to the Lead', async () => {
    const team = await stack({}, undefined, ['hang'])
    const member = await team.spawn('explorer')
    const child = team.ctx.agents.get(member.member.id)!
    const task = await team.ctx.agentTeams.createTask(team.lead, { subject: 'explore', description: 'explore', requiredRole: RoleId('explorer') })
    expect(await team.ctx.agentTeams.updateTask(child, { taskId: task.id, expectedRevision: 1, action: 'claim' })).toMatchObject({ ownerName: member.member.name, revision: 2 })
    await expect(team.ctx.agentTeams.retireTeammate(child, member.member.name)).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
  })
})
