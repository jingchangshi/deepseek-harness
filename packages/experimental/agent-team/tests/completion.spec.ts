import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import TeamService, { TeamError, TeamId, TeamTaskId } from '../src/index.ts'
import type {
  TeamTaskCompletionAttempt,
  TeamTaskCompletionDecision,
  TeamTaskCompletionPolicy,
} from '../src/index.ts'
import { completionRequirementsDigest } from '../src/completion.ts'
import type { TeamTaskCompletionPayload } from '../src/completion.ts'
import { teamProjectionDefinition } from '../src/projection.ts'
import type { TeamMemberSnapshot, TeamTaskSnapshot } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

const roots: string[] = []
const contexts = new Set<Context>()

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const ctx of [...contexts].reverse()) {
    try {
      await ctx.fiber.dispose()
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  contexts.clear()
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Team completion test cleanup failed')
})

/** Detached durable Team read through the same projection definition as the service. */
function durable(agent: Agent): {
  members: readonly TeamMemberSnapshot[]
  tasks: readonly TeamTaskSnapshot[]
} {
  let projected = teamProjectionDefinition.init(agent.session.header)
  for (const event of agent.session.snapshotEvents()) projected = teamProjectionDefinition.apply(projected, event)
  if (projected.failure !== undefined) throw new Error(projected.failure)
  return { members: projected.members, tasks: projected.tasks }
}

/** Count committed completed revisions of one task in the durable log. */
function completedEvents(agent: Agent, id: string): number {
  return agent.session.snapshotEvents().filter(event =>
    event.type === 'team/task'
    && event.data.task.id === id
    && event.data.task.status === 'completed').length
}

async function setup(script: ConstructorParameters<typeof MockAdapter>[0] = []) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-completion-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const lead = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead, storageRoot }
}

/** A policy that records every attempt and answers with the supplied decision. */
function recordingPolicy(
  decide: (attempt: TeamTaskCompletionAttempt) => TeamTaskCompletionDecision = () => ({ outcome: 'accepted' }),
): TeamTaskCompletionPolicy & { readonly attempts: TeamTaskCompletionAttempt[] } {
  const attempts: TeamTaskCompletionAttempt[] = []
  return {
    name: 'recording',
    attempts,
    evaluate(attempt) {
      attempts.push(attempt)
      return decide(attempt)
    },
  }
}

/** Spawn one teammate and wait for its live Agent. */
async function teammate(
  ctx: Context,
  lead: Agent,
  name: string,
  agentOptions?: { readonly provider?: string; readonly model?: string },
): Promise<Agent> {
  const spawned = await ctx.agentTeams.spawnTeammate(lead, {
    name,
    description: `${name} responsibility`,
    prompt: [{ type: 'text', text: `${name} initial` }],
    context: 'fresh',
    provider: 'spawn',
    ...agentOptions === undefined ? {} : { agentOptions },
    signal: new AbortController().signal,
  })
  return vi.waitFor(() => {
    const child = ctx.agents.get(spawned.member.id)
    expect(child?.status).toBe('running')
    return child!
  }, { timeout: 5_000 })
}

function requirement(
  key: string,
  kind = 'external-check',
  payload: TeamTaskCompletionPayload = { strict: true },
) {
  return { key, kind, payload }
}

const REQUIREMENT = requirement('run')

describe('generic Team task completion policy', () => {
  it('keeps the historical completion path for a task without requirements', async () => {
    const { ctx, lead } = await setup()
    const policy = recordingPolicy()
    ctx.agentTeams.registerCompletionPolicy(policy)
    const task = await ctx.agentTeams.createTask(lead, { subject: 'plain', description: 'plain task' })
    expect(task).not.toHaveProperty('completionRequirements')
    expect(task).not.toHaveProperty('completion')

    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    const completed = await ctx.agentTeams.updateTask(lead, {
      taskId: claimed.id, expectedRevision: claimed.revision, action: 'complete',
    })
    expect(completed.status).toBe('completed')
    expect(completed).not.toHaveProperty('completion')
    // A requirement-free task never consults a policy, even one that is installed.
    expect(policy.attempts).toEqual([])
    expect(durable(lead).tasks[0]).not.toHaveProperty('completionRequirements')
    expect(completedEvents(lead, task.id)).toBe(1)
  })

  it('refuses completion of a requirement-bearing task when no policy is registered', async () => {
    const { ctx, lead } = await setup()
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'gated', description: 'requires verification', completionRequirements: [REQUIREMENT],
    })
    expect(task.completionRequirements).toEqual([REQUIREMENT])
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: claimed.revision, action: 'complete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_COMPLETION_UNAVAILABLE' })
    expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('in_progress')
    expect(completedEvents(lead, task.id)).toBe(0)
  })

  it('records the accepted evidence reference on the completed revision', async () => {
    const { ctx, lead } = await setup()
    const policy = recordingPolicy()
    ctx.agentTeams.registerCompletionPolicy(policy)
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'gated', description: 'requires verification', completionRequirements: [REQUIREMENT],
    })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    const completed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'complete',
      evidence: [{ key: 'run', reference: 'run-42' }],
    })
    expect(completed.status).toBe('completed')
    expect(completed.completion).toEqual({
      policy: 'recording',
      requirementsDigest: completionRequirementsDigest([REQUIREMENT]),
      evidence: [{ key: 'run', reference: 'run-42' }],
      acceptedRevision: claimed.revision,
    })
    expect(policy.attempts).toHaveLength(1)
    expect(policy.attempts[0]).toMatchObject({
      teamId: TeamId(lead.id),
      taskId: task.id,
      revision: claimed.revision,
      requirements: [REQUIREMENT],
      evidence: [{ key: 'run', reference: 'run-42' }],
      callerId: lead.id,
      callerName: 'lead',
    })
    // The durable value carries it too, so cold recovery sees the receipt.
    expect(durable(lead).tasks[0]?.completion).toEqual(completed.completion)
  })

  it('refuses the completion and commits no completed event when a policy rejects', async () => {
    const { ctx, lead } = await setup()
    ctx.agentTeams.registerCompletionPolicy(recordingPolicy(() => ({
      outcome: 'rejected',
      code: 'TEAM_TASK_COMPLETION_REJECTED',
      message: 'external run-42 is stale',
    })))
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'gated', description: 'requires verification', completionRequirements: [REQUIREMENT],
    })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    const before = lead.session.snapshotEvents().length
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'complete',
      evidence: [{ key: 'run', reference: 'run-42' }],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_COMPLETION_REJECTED' })
    expect(lead.session.snapshotEvents()).toHaveLength(before)
    expect(completedEvents(lead, task.id)).toBe(0)
    expect(ctx.agentTeams.getTask(lead, task.id)).toMatchObject({ status: 'in_progress', revision: claimed.revision })
  })

  it('treats a policy timeout as a rejection and leaves no completed event', async () => {
    const { ctx, lead } = await setup()
    ctx.agentTeams.registerCompletionPolicy({
      name: 'slow',
      evaluate: attempt => new Promise<TeamTaskCompletionDecision>((_resolve, reject) => {
        attempt.signal.addEventListener('abort', () => { reject(new Error('aborted by timeout')) }, { once: true })
      }),
    }, { timeoutMs: 20 })
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'gated', description: 'requires verification', completionRequirements: [REQUIREMENT],
    })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'complete',
      evidence: [{ key: 'run', reference: 'run-42' }],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_COMPLETION_TIMEOUT' })
    expect(completedEvents(lead, task.id)).toBe(0)
    expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('in_progress')
  })

  it('rechecks the task revision after verification and commits nothing on a concurrent change', async () => {
    const { ctx, lead } = await setup()
    let release!: () => void
    const verified = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const begun = new Promise<void>((resolve) => { started = resolve })
    ctx.agentTeams.registerCompletionPolicy({
      name: 'waiting',
      async evaluate() {
        started()
        await verified
        return { outcome: 'accepted' }
      },
    })
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'gated', description: 'requires verification', completionRequirements: [REQUIREMENT],
    })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    const completing = ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'complete',
      evidence: [{ key: 'run', reference: 'run-42' }],
    })
    await begun
    // The verification is running OUTSIDE the Lead transaction queue, so an
    // ordinary edit must proceed while it is pending.
    const edited = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: claimed.revision, action: 'edit', subject: 'moved on',
    })
    release()
    await expect(completing).rejects.toMatchObject({ code: 'TEAM_TASK_STALE_REVISION' })
    expect(completedEvents(lead, task.id)).toBe(0)
    expect(ctx.agentTeams.getTask(lead, task.id)).toMatchObject({ status: 'in_progress', revision: edited.revision })
  })

  it('refuses to remove or rewrite a declared requirement through an edit', async () => {
    const { ctx, lead } = await setup()
    ctx.agentTeams.registerCompletionPolicy(recordingPolicy())
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'gated', description: 'requires verification', completionRequirements: [REQUIREMENT],
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'edit',
      completionRequirements: [],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_COMPLETION_REQUIREMENT_WEAKENED' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'edit',
      completionRequirements: [requirement('run', 'external-check', { strict: false })],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_COMPLETION_REQUIREMENT_WEAKENED' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'edit',
      completionRequirements: [requirement('other')],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_COMPLETION_REQUIREMENT_WEAKENED' })

    // Adding a further requirement is the permitted direction.
    const strengthened = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'edit',
      completionRequirements: [REQUIREMENT, requirement('extra')],
    })
    expect(strengthened.completionRequirements).toEqual([REQUIREMENT, requirement('extra')])
    expect(ctx.agentTeams.getTask(lead, task.id).completionRequirements).toHaveLength(2)
  })

  it('rejects malformed requirement and evidence declarations', async () => {
    const { ctx, lead } = await setup()
    ctx.agentTeams.registerCompletionPolicy(recordingPolicy())
    await expect(ctx.agentTeams.createTask(lead, {
      subject: 'bad', description: 'bad requirement',
      completionRequirements: [requirement(' ')],
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.createTask(lead, {
      subject: 'bad', description: 'duplicate requirement',
      completionRequirements: [REQUIREMENT, REQUIREMENT],
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.createTask(lead, {
      subject: 'bad', description: 'non-json payload',
      completionRequirements: [{ key: 'run', kind: 'external-check', payload: new Date() as never }],
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })

    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'gated', description: 'requires verification', completionRequirements: [REQUIREMENT],
    })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'complete',
      evidence: [{ key: 'undeclared', reference: 'x' }],
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'complete',
      evidence: [{ key: 'run', reference: 'a' }, { key: 'run', reference: 'b' }],
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    const plain = await ctx.agentTeams.createTask(lead, { subject: 'plain', description: 'plain' })
    const plainClaim = await ctx.agentTeams.updateTask(lead, {
      taskId: plain.id, expectedRevision: plain.revision, action: 'claim',
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: plain.id,
      expectedRevision: plainClaim.revision,
      action: 'complete',
      evidence: [{ key: 'run', reference: 'a' }],
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
  })

  it('drops the acceptance receipt when a completed task reopens', async () => {
    const { ctx, lead } = await setup()
    ctx.agentTeams.registerCompletionPolicy(recordingPolicy())
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'gated', description: 'requires verification', completionRequirements: [REQUIREMENT],
    })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    const completed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'complete',
      evidence: [{ key: 'run', reference: 'run-42' }],
    })
    const reopened = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: completed.revision, action: 'reopen',
    })
    expect(reopened.status).toBe('pending')
    expect(reopened).not.toHaveProperty('completion')
    expect(reopened.completionRequirements).toEqual([REQUIREMENT])
  })

  it('stops consulting a policy once its registration is disposed', async () => {
    const { ctx, lead } = await setup()
    const policy = recordingPolicy()
    const dispose = ctx.agentTeams.registerCompletionPolicy(policy)
    dispose()
    dispose()
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'gated', description: 'requires verification', completionRequirements: [REQUIREMENT],
    })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'complete',
      evidence: [{ key: 'run', reference: 'run-42' }],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_COMPLETION_UNAVAILABLE' })
    expect(policy.attempts).toEqual([])
  })

  it('rejects invalid registration arguments and refuses registration after disposal', async () => {
    const { ctx } = await setup()
    expect(() => ctx.agentTeams.registerCompletionPolicy({ name: ' ', evaluate: () => ({ outcome: 'accepted' }) }))
      .toThrow(expect.objectContaining({ code: 'TEAM_INVALID_ARGUMENT' }))
    expect(() => ctx.agentTeams.registerCompletionPolicy(recordingPolicy(), { timeoutMs: 0 }))
      .toThrow(expect.objectContaining({ code: 'TEAM_INVALID_ARGUMENT' }))
    const teamFiber = await setup()
    // White-box disposal follows the runtime owner so coverage does not widen the service API.
    await (teamFiber.ctx.agentTeams as unknown as { disposeRuntime(): Promise<void> }).disposeRuntime()
    expect(() => teamFiber.ctx.agentTeams.registerCompletionPolicy(recordingPolicy()))
      .toThrow(expect.objectContaining({ code: 'TEAM_DISPOSED' }))
  })

  it('wraps a policy crash as a rejection and preserves a Team failure code', async () => {
    const { ctx, lead } = await setup()
    const dispose = ctx.agentTeams.registerCompletionPolicy({
      name: 'crashing',
      evaluate() { throw new Error('verifier crashed') },
    })
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'gated', description: 'requires verification', completionRequirements: [REQUIREMENT],
    })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    const crash = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'complete',
      evidence: [{ key: 'run', reference: 'run-42' }],
    }).catch((error: unknown) => error)
    expect(crash).toMatchObject({ code: 'TEAM_TASK_COMPLETION_REJECTED' })
    expect((crash as Error).message).toContain('verifier crashed')
    dispose()

    ctx.agentTeams.registerCompletionPolicy({
      name: 'coded',
      evaluate() {
        return Promise.reject(Object.assign(new Error('policy-owned failure'), { code: 'CUSTOM_POLICY_CODE' }))
      },
    })
    const second = await ctx.agentTeams.createTask(lead, {
      subject: 'gated-2', description: 'requires verification', completionRequirements: [REQUIREMENT],
    })
    const secondClaim = await ctx.agentTeams.updateTask(lead, {
      taskId: second.id, expectedRevision: second.revision, action: 'claim',
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: second.id,
      expectedRevision: secondClaim.revision,
      action: 'complete',
      evidence: [{ key: 'run', reference: 'run-43' }],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_COMPLETION_REJECTED' })
  })

  it('refuses a completion the caller is not authorized to perform', async () => {
    const { ctx, lead } = await setup()
    ctx.agentTeams.registerCompletionPolicy(recordingPolicy())
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'gated', description: 'requires verification', completionRequirements: [REQUIREMENT],
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'complete',
      evidence: [{ key: 'run', reference: 'run-42' }],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    // A stale expected revision is refused before any policy runs.
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: 1, action: 'complete',
      evidence: [{ key: 'run', reference: 'run-42' }],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_STALE_REVISION' })
    expect(claimed.status).toBe('in_progress')
  })

  it('rejects a completion whose task was deleted or never existed', async () => {
    const { ctx, lead } = await setup()
    ctx.agentTeams.registerCompletionPolicy(recordingPolicy())
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'gated', description: 'requires verification', completionRequirements: [REQUIREMENT],
    })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    const deleted = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: claimed.revision, action: 'delete',
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: deleted.revision, action: 'complete',
      evidence: [{ key: 'run', reference: 'run-42' }],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_DELETED' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: TeamTaskId('missing'), expectedRevision: 1, action: 'complete',
      evidence: [{ key: 'run', reference: 'run-42' }],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
  })

  it('restores declared requirements and the acceptance receipt from a cold-start log', async () => {
    const { ctx, lead } = await setup()
    ctx.agentTeams.registerCompletionPolicy(recordingPolicy())
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'gated', description: 'requires verification', completionRequirements: [REQUIREMENT],
    })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    const completed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'complete',
      evidence: [{ key: 'run', reference: 'run-42' }],
    })
    // Fold the exact durable log a restart would replay.
    const recovered = durable(lead).tasks.find(entry => entry.id === task.id)
    expect(recovered?.completionRequirements).toEqual([REQUIREMENT])
    expect(recovered?.completion).toEqual(completed.completion)
    expect(teamProjectionDefinition.stateVersion).toBe(4)
  })

  it('defaults the rejection code when a policy supplies none and allows adding requirements to a plain task', async () => {
    const { ctx, lead } = await setup()
    ctx.agentTeams.registerCompletionPolicy(recordingPolicy(() => ({
      outcome: 'rejected',
      message: 'evidence does not prove the requirement',
    })))
    const plain = await ctx.agentTeams.createTask(lead, { subject: 'plain', description: 'plain task' })
    const adopted = await ctx.agentTeams.updateTask(lead, {
      taskId: plain.id,
      expectedRevision: plain.revision,
      action: 'edit',
      completionRequirements: [REQUIREMENT],
    })
    expect(adopted.completionRequirements).toEqual([REQUIREMENT])
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: plain.id, expectedRevision: adopted.revision, action: 'claim',
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: plain.id,
      expectedRevision: claimed.revision,
      action: 'complete',
      evidence: [{ key: 'run', reference: 'run-42' }],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_COMPLETION_REJECTED' })
    expect(completedEvents(lead, plain.id)).toBe(0)
  })

  it('rejects a durable record that fabricates a completion without a policy receipt', async () => {
    const { ctx, lead } = await setup()
    const forged: TeamTaskSnapshot = {
      id: TeamTaskId('task-forged'),
      revision: 1,
      subject: 'forged',
      description: 'claims completion with no acceptance',
      status: 'completed',
      blockedBy: [],
      writeScopes: [],
      completionRequirements: [REQUIREMENT],
    }
    lead.session.append('team/task', { version: 3, teamId: TeamId(lead.id), task: forged })
    await ctx.sessions.flush(lead.session)
    let projected = teamProjectionDefinition.init(lead.session.header)
    for (const event of lead.session.snapshotEvents()) projected = teamProjectionDefinition.apply(projected, event)
    expect(projected.failure).toContain('must carry a policy acceptance receipt')
  })

  it('rejects a durable record whose acceptance receipt names other requirements', async () => {
    const { ctx, lead } = await setup()
    const mismatched: TeamTaskSnapshot = {
      id: TeamTaskId('task-mismatched'),
      revision: 1,
      subject: 'mismatched',
      description: 'receipt does not match the declared requirements',
      status: 'completed',
      blockedBy: [],
      writeScopes: [],
      completionRequirements: [REQUIREMENT],
      completion: {
        policy: 'forged',
        requirementsDigest: completionRequirementsDigest([requirement('other')]),
        evidence: [{ key: 'run', reference: 'run-42' }],
        acceptedRevision: 1,
      },
    }
    lead.session.append('team/task', { version: 3, teamId: TeamId(lead.id), task: mismatched })
    await ctx.sessions.flush(lead.session)
    let projected = teamProjectionDefinition.init(lead.session.header)
    for (const event of lead.session.snapshotEvents()) projected = teamProjectionDefinition.apply(projected, event)
    expect(projected.failure).toContain('must match the declared completion requirements')
  })

  it('restores a version-2 task event that predates completion requirements', async () => {
    const { ctx, lead } = await setup()
    const legacy: TeamTaskSnapshot = {
      id: TeamTaskId('task-legacy'),
      revision: 1,
      subject: 'legacy task',
      description: 'written before completion requirements existed',
      status: 'pending',
      blockedBy: [],
      writeScopes: [],
    }
    lead.session.append('team/task', { version: 2, teamId: TeamId(lead.id), task: legacy })
    await ctx.sessions.flush(lead.session)
    expect(durable(lead).tasks).toEqual([legacy])
    // The legacy task completes exactly as it always did, with no policy installed.
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: legacy.id, expectedRevision: legacy.revision, action: 'claim',
    })
    const completed = await ctx.agentTeams.updateTask(lead, {
      taskId: legacy.id, expectedRevision: claimed.revision, action: 'complete',
    })
    expect(completed.status).toBe('completed')
    expect(completed).not.toHaveProperty('completion')
  })

  it('rejects a replayed log that silently drops or rewrites a declared requirement', async () => {
    const { ctx, lead } = await setup()
    const base: TeamTaskSnapshot = {
      id: TeamTaskId('task-replay'),
      revision: 1,
      subject: 'gated',
      description: 'requires verification',
      status: 'pending',
      blockedBy: [],
      writeScopes: [],
      completionRequirements: [REQUIREMENT],
    }
    lead.session.append('team/task', { version: 3, teamId: TeamId(lead.id), task: base })
    await ctx.sessions.flush(lead.session)
    const weakened: TeamTaskSnapshot = {
      ...base,
      revision: 2,
      completionRequirements: [],
    }
    lead.session.append('team/task', { version: 3, teamId: TeamId(lead.id), task: weakened })
    await ctx.sessions.flush(lead.session)
    let projected = teamProjectionDefinition.init(lead.session.header)
    for (const event of lead.session.snapshotEvents()) projected = teamProjectionDefinition.apply(projected, event)
    expect(projected.failure).toContain('was removed')
    expect(() => ctx.agentTeams.getTask(lead, base.id)).toThrow(/was removed/u)
  })

  it('refuses a non-Lead non-owner completion of a requirement-bearing task', async () => {
    const { ctx, lead } = await setup(['hang'])
    ctx.agentTeams.registerCompletionPolicy(recordingPolicy())
    const worker = await teammate(ctx, lead, 'outsider', { provider: 'mock', model: 'mock' })
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'gated', description: 'requires verification', completionRequirements: [REQUIREMENT],
    })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    expect(claimed.ownerName).toBe('lead')
    await expect(ctx.agentTeams.updateTask(worker, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'complete',
      evidence: [{ key: 'run', reference: 'run-42' }],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_UNAUTHORIZED' })
    expect(completedEvents(lead, task.id)).toBe(0)
    ctx.agentTeams.interrupt(lead, 'outsider')
    await vi.waitFor(() => { expect(ctx.agents.get(worker.id)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('hashes array and nested payloads stably and preserves a policy Team failure code', async () => {
    const { ctx, lead } = await setup()
    ctx.agentTeams.registerCompletionPolicy({
      name: 'coded',
      evaluate() {
        return Promise.reject(new TeamError('policy-owned refusal', 'POLICY_OWN_CODE'))
      },
    })
    const nested = requirement('run', 'external-check', { gates: ['a', 'b'], nested: { list: [1, 'two', null] } })
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'gated', description: 'requires verification', completionRequirements: [nested],
    })
    // The digest is order-insensitive for object keys but not for array order.
    expect(completionRequirementsDigest([nested])).toBe(completionRequirementsDigest([
      requirement('run', 'external-check', { nested: { list: [1, 'two', null] }, gates: ['a', 'b'] }),
    ]))
    expect(completionRequirementsDigest([nested])).not.toBe(completionRequirementsDigest([
      requirement('run', 'external-check', { gates: ['b', 'a'], nested: { list: [1, 'two', null] } }),
    ]))
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'complete',
      evidence: [{ key: 'run', reference: 'run-42' }],
    })).rejects.toMatchObject({ code: 'POLICY_OWN_CODE' })
    expect(completedEvents(lead, task.id)).toBe(0)
  })

  it('treats an empty requirement replacement on a plain task as a no-op edit', async () => {
    const { ctx, lead } = await setup()
    const plain = await ctx.agentTeams.createTask(lead, { subject: 'plain', description: 'plain task' })
    const edited = await ctx.agentTeams.updateTask(lead, {
      taskId: plain.id,
      expectedRevision: plain.revision,
      action: 'edit',
      completionRequirements: [],
    })
    expect(edited).not.toHaveProperty('completionRequirements')
    expect(edited.revision).toBe(plain.revision + 1)
  })
})
