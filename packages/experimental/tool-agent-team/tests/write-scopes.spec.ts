import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { TeamError } from '@deepseek-ai/dsh-experimental-agent-team'
import { writeScope } from '../../agent-team/src/validation.ts'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import TeamService from '../../agent-team/src/index.ts'
import * as toolTeam from '../src/index.ts'
import { sessionDirectory, sessionWriteScope, sessionWriteScopes } from '../src/index.ts'

/**
 * The exact value from session 757fa075, seq 587. It is absolute, and it is
 * outside the session workspace it was offered from, which is why it survived
 * no normalization and destroyed four task creations at once.
 */
const SESSION_OUTSIDE_SCOPE = '/home/s00653124/workspace/TileFoundry_p3_02/targets/ascend/tilefoundry_ascend/plan/resolved_plan.py'

/** The session workspace those four tasks were meant to record scopes inside. */
const SESSION_WORKSPACE = '/home/s00653124/workspace/TileFoundry_Ascend950PR_AgentTeam'

const SIGNAL = new AbortController().signal

/** Capture the typed refusal so code and message are asserted separately. */
function refusal(run: () => unknown): TeamError {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof TeamError) return error
    throw error
  }
  throw new Error('expected the write scope to be refused')
}

/** Read the created tasks out of one `team_task_list` result. */
function taskList(result: Awaited<ReturnType<typeof execute>>): unknown[] {
  const parsed = JSON.parse(result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')) as
    { tasks: unknown[] }
  return parsed.tasks
}

describe('sessionWriteScope', () => {
  it('converts an absolute path inside the session workspace', () => {
    expect(sessionWriteScope(SESSION_WORKSPACE, `${SESSION_WORKSPACE}/targets/ascend/tests/test_plan.py`))
      .toBe('targets/ascend/tests/test_plan.py')
    expect(sessionWriteScope(SESSION_WORKSPACE, `${SESSION_WORKSPACE}/targets/ascend/`)).toBe('targets/ascend')
    // Redundant separators and "." segments are lexical forms of the same path.
    expect(sessionWriteScope(SESSION_WORKSPACE, `${SESSION_WORKSPACE}//./targets/plan`)).toBe('targets/plan')
    // Stored value is the bare prefix; the caller's cwd prefix never survives.
    expect(sessionWriteScope(SESSION_WORKSPACE, `${SESSION_WORKSPACE}/targets/plan`))
      .not.toContain('TileFoundry_Ascend950PR_AgentTeam')
  })

  it('refuses the out-of-workspace absolute path from the session with that exact reason', () => {
    const error = refusal(() => sessionWriteScope(SESSION_WORKSPACE, SESSION_OUTSIDE_SCOPE))
    expect(error.code).toBe('TEAM_INVALID_WRITE_SCOPE')
    expect(error.message).toContain(JSON.stringify(SESSION_OUTSIDE_SCOPE))
    expect(error.message).toContain('it is outside the session workspace')
    expect(error.message).toContain(JSON.stringify(SESSION_WORKSPACE))
    expect(error.message).toContain('a scope from another tree cannot be stored')
    // The retry has to be obvious from the message alone.
    expect(error.message).toContain('record the prefix inside the session workspace that the work changes')
  })

  it('does not widen into a sibling whose name is only a prefix of the workspace', () => {
    const error = refusal(() => sessionWriteScope('/work/repo', '/work/repo-other/src'))
    expect(error.message).toContain('it is outside the session workspace')
  })

  it('refuses an absolute path with no recorded session directory', () => {
    const error = refusal(() => sessionWriteScope(undefined, SESSION_OUTSIDE_SCOPE))
    expect(error.code).toBe('TEAM_INVALID_WRITE_SCOPE')
    expect(error.message).toContain('this session records no working directory')
  })

  it('refuses the workspace root itself, which names no prefix', () => {
    const error = refusal(() => sessionWriteScope(SESSION_WORKSPACE, SESSION_WORKSPACE))
    expect(error.code).toBe('TEAM_INVALID_WRITE_SCOPE')
    expect(error.message).toContain('session workspace root')
  })

  it('passes every relative scope through to the Team validator untouched', () => {
    // The Team service stays the single authority on relative syntax, so the
    // tool layer neither pre-normalizes nor pre-accepts it: an invalid relative
    // value reaches the service and is refused there with the same code.
    expect(sessionWriteScope(SESSION_WORKSPACE, 'targets//plan')).toBe('targets//plan')
    for (const value of ['../escape', '  ', '.']) {
      expect(sessionWriteScope(SESSION_WORKSPACE, value)).toBe(value)
      expect(refusal(() => writeScope(value)).code).toBe('TEAM_INVALID_WRITE_SCOPE')
    }
  })

  it('normalizes drive-letter workspaces and traversal inside the workspace', () => {
    // A Windows session records a drive-letter directory; it must convert too.
    expect(sessionWriteScope('C:\\work\\repo', 'C:\\work\\repo\\src\\a.ts')).toBe('src/a.ts')
    expect(refusal(() => sessionWriteScope('C:\\work\\repo', 'C:\\work\\other\\a.ts')).message)
      .toContain('outside the session workspace')
    // A '..' segment inside the workspace resolves lexically before the prefix is stored.
    expect(sessionWriteScope(SESSION_WORKSPACE, `${SESSION_WORKSPACE}/targets/../src/a.ts`)).toBe('src/a.ts')
  })

  it('treats a filesystem-root workspace as a root, not as a prefix', () => {
    // The root has no separator of its own, so the slice must not eat a character.
    expect(sessionWriteScope('/', '/tmp/a.ts')).toBe('tmp/a.ts')
  })

  it('converts every entry and refuses the first unconvertible one', () => {
    expect(sessionWriteScopes(SESSION_WORKSPACE, ['src/a.ts', `${SESSION_WORKSPACE}/src`])).toEqual(['src/a.ts', 'src'])
    expect(refusal(() => sessionWriteScopes(SESSION_WORKSPACE, ['src/a.ts', SESSION_OUTSIDE_SCOPE])).code)
      .toBe('TEAM_INVALID_WRITE_SCOPE')
  })
})

const created: string[] = []
const contexts = new Set<Context>()
let callNumber = 0

class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('not configured')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('not configured')) }
}

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Mount the Team tool stack with a Lead whose Session records `cwd`. */
async function stack(cwd: string): Promise<{ ctx: Context; lead: Agent }> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-write-scope-'))
  created.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TeamService, {})
  await ctx.plugin(toolTeam)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
  const lead = await ctx.agentLoop.create(SessionId('write-scope-lead'), { provider: 'mock', model: 'mock' }, { cwd })
  return { ctx, lead }
}

function execute(ctx: Context, agent: Agent, name: string, args: unknown) {
  return ctx.tools.execute({
    callId: ToolCallId(`write-scope-call-${++callNumber}`),
    name, arguments: args, signal: SIGNAL, agent,
  })
}

describe('sessionDirectory', () => {
  /** Stub the two reads the helper performs, without mounting a Host. */
  const probe = (projection: string | undefined, header: string | undefined) => sessionDirectory(
    { get: () => projection === undefined ? undefined : { get: () => projection } } as unknown as Context,
    { session: { header: header === undefined ? {} : { cwd: header } } } as unknown as Agent,
  )

  it('prefers the live directory projection over the durable header', () => {
    expect(probe('/live/dir', '/header/dir')).toBe('/live/dir')
  })

  it('falls back to the durable header when no projection is mounted', () => {
    expect(probe(undefined, '/header/dir')).toBe('/header/dir')
  })

  it('reports unknown when neither source names a directory', () => {
    expect(probe(undefined, undefined)).toBeUndefined()
    // A blank directory must not degrade into the filesystem root, which would
    // make every absolute path on the machine look in-workspace.
    expect(probe('   ', undefined)).toBeUndefined()
  })
})

describe('team_task_create write scopes', () => {
  it('accepts an absolute path inside the session workspace instead of failing the call', async () => {
    const { ctx, lead } = await stack(SESSION_WORKSPACE)
    const result = await execute(ctx, lead, 'team_task_create', {
      subject: 'plan the ascend pipeline',
      description: 'record the resolved plan edit',
      write_scopes: [`${SESSION_WORKSPACE}/targets/ascend/plan/resolved_plan.py`],
    })
    expect(result.isError).toBe(false)
    const task = JSON.parse(result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')) as
      { writeScopes: string[] }
    // Stored relative, comparable with another task's scope.
    expect(task.writeScopes).toEqual(['targets/ascend/plan/resolved_plan.py'])
  })

  it('keeps the overlap warning working across a converted absolute scope', async () => {
    const { ctx, lead } = await stack(SESSION_WORKSPACE)
    const first = await execute(ctx, lead, 'team_task_create', {
      subject: 'first', description: 'own the directory', write_scopes: ['targets/ascend'],
    })
    expect(first.isError).toBe(false)
    const firstTask = JSON.parse(first.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')) as
      { id: string; revision: number }
    const claimed = await execute(ctx, lead, 'team_task_update', {
      task_id: firstTask.id, expected_revision: firstTask.revision, action: 'claim',
    })
    expect(claimed.isError).toBe(false)
    const second = await execute(ctx, lead, 'team_task_create', {
      subject: 'second',
      description: 'same tree, absolute form',
      write_scopes: [`${SESSION_WORKSPACE}/targets/ascend/plan/resolved_plan.py`],
    })
    expect(second.isError).toBe(false)
    const secondTask = JSON.parse(second.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')) as
      { writeScopeWarnings: string[] }
    expect(secondTask.writeScopeWarnings).toContain(`write scopes overlap with ${firstTask.id}`)
  })

  it('refuses an absolute path outside the session workspace and names the reason', async () => {
    const { ctx, lead } = await stack(SESSION_WORKSPACE)
    const result = await execute(ctx, lead, 'team_task_create', {
      subject: 's', description: 'd', write_scopes: [SESSION_OUTSIDE_SCOPE],
    })
    expect(result.isError).toBe(true)
    const message = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(message).toContain('it is outside the session workspace')
    expect(message).toContain('a scope from another tree cannot be stored')
    // A single call stays atomic: nothing was created.
    const list = await execute(ctx, lead, 'team_task_list', {})
    expect(taskList(list)).toEqual([])
  })

  it('applies the same conversion to the team_task_update edit path', async () => {
    const { ctx, lead } = await stack(SESSION_WORKSPACE)
    const createdTask = await execute(ctx, lead, 'team_task_create', { subject: 's', description: 'd' })
    const task = JSON.parse(createdTask.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')) as
      { id: string; revision: number }
    const edited = await execute(ctx, lead, 'team_task_update', {
      task_id: task.id,
      expected_revision: task.revision,
      action: 'edit',
      write_scopes: [`${SESSION_WORKSPACE}/targets/ascend/tests`],
    })
    expect(edited.isError).toBe(false)
    const view = JSON.parse(edited.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')) as
      { writeScopes: string[] }
    expect(view.writeScopes).toEqual(['targets/ascend/tests'])
  })
})
