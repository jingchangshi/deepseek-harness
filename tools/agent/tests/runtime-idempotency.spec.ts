import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Runtime from '../runtime/index.ts'
import { getEngineeringStatus, runEngineeringTask } from '../src/automatic.ts'
import { claimEngineeringInvocation, ENGINEERING_INVOCATION_DIR, engineeringInvocationId, readEngineeringInvocationReceipt, withEngineeringInvocationLock, writeEngineeringInvocationReceipt } from '../src/invocation.ts'

vi.mock('../src/automatic.ts', () => ({
  loadEngineeringProject: vi.fn(async () => {}),
  getEngineeringStatus: vi.fn(async () => ({ tasks: [], pendingTasks: [] })),
  recoverEngineeringTask: vi.fn(async () => ({ state: 'REPLAN' })),
  runEngineeringTask: vi.fn(),
}))

const mockedRun = vi.mocked(runEngineeringTask)
const mockedStatus = vi.mocked(getEngineeringStatus)
const SOURCE = resolve(import.meta.dirname, '../../..')
const disposals: (() => Promise<unknown>)[] = []
const roots: string[] = []
afterEach(async () => {
  for (const dispose of disposals.reverse()) await dispose()
  disposals.length = 0
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  mockedRun.mockReset()
  mockedStatus.mockReset()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

async function fixture(existingRoot?: string) {
  const root = existingRoot ?? await realpath(await mkdtemp(join(tmpdir(), 'dsh-engineering-replay-')))
  if (existingRoot === undefined) {
    roots.push(root)
    await cp(join(SOURCE, '.agent'), join(root, '.agent'), { recursive: true })
    const modelsPath = join(root, '.agent/config/models.yaml')
    await writeFile(modelsPath, (await readFile(modelsPath, 'utf8')).replaceAll('${DSH_MAGPIE_GATEWAY_URL}', 'https://fixture.invalid/v1'))
  }
  const ctx = new Context()
  disposals.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Runtime, { deploymentRoot: root, roleTimeoutMs: 1000 })
  const parent = await ctx.agentLoop.create(SessionId('session-1'), {}, { cwd: root })
  return { ctx, parent, root }
}

describe('engineering_run replay idempotency', () => {
  it('treats an empty taskId as omitted before claiming a new run', async () => {
    const { parent, root } = await fixture()
    mockedRun.mockImplementation(async options => {
      expect(options.taskId).toBeUndefined()
      await options.onTaskSelected?.('task-1')
      return { status: 'ACCEPTED', taskId: 'task-1', summary: 'done', nextAction: 'NONE' }
    })
    const result = await parent.ctx.tools.execute({
      callId: ToolCallId('empty-task-id'), name: 'engineering_run',
      arguments: { request: 'request', taskId: '' }, signal: new AbortController().signal, agent: parent,
    })
    expect(result.isError).toBe(false)
    expect(JSON.parse(String(result.value))).toMatchObject({ status: 'ACCEPTED', taskId: 'task-1' })
    expect(mockedRun).toHaveBeenCalledTimes(1)
    const invocationId = engineeringInvocationId('session-1', 'empty-task-id', root)
    await expect(readEngineeringInvocationReceipt(root, invocationId)).resolves.toMatchObject({ phase: 'COMPLETED', taskId: 'task-1' })
  })

  it('rejects an invalid nonempty taskId before claiming an invocation', async () => {
    const { parent, root } = await fixture()
    const result = await parent.ctx.tools.execute({
      callId: ToolCallId('invalid-task-id'), name: 'engineering_run',
      arguments: { request: 'request', taskId: 'INVALID' }, signal: new AbortController().signal, agent: parent,
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: taskId must be a nonempty valid task identifier; omit taskId for a new task or to list all tasks' }])
    expect(mockedRun).not.toHaveBeenCalled()
    const invocationId = engineeringInvocationId('session-1', 'invalid-task-id', root)
    await expect(readEngineeringInvocationReceipt(root, invocationId)).resolves.toBeUndefined()
  })

  it('treats an empty taskId as omitted when listing status', async () => {
    const { parent, root } = await fixture()
    mockedStatus.mockResolvedValue({ tasks: [], pendingTasks: [] })
    const result = await parent.ctx.tools.execute({
      callId: ToolCallId('empty-status-task-id'), name: 'engineering_status',
      arguments: { taskId: '' }, signal: new AbortController().signal, agent: parent,
    })
    expect(result.isError).toBe(false)
    expect(JSON.parse(String(result.value))).toEqual({ tasks: [], pendingTasks: [] })
    expect(mockedStatus).toHaveBeenCalledWith(root, undefined)
  })

  it('returns WAIT_FOR_CURRENT_RUN while another process owns the invocation lock', async () => {
    const { parent, root } = await fixture()
    const invocationId = engineeringInvocationId('session-1', 'locked-call', root, SessionSeq(44))
    const ownerReady = deferred<void>()
    const release = deferred<void>()
    const owner = withEngineeringInvocationLock(root, invocationId, async () => {
      ownerReady.resolve()
      await release.promise
      return undefined
    })
    try {
      await ownerReady.promise
      const result = await parent.ctx.tools.execute({
        callId: ToolCallId('locked-call'), loggedCallSeq: SessionSeq(44), name: 'engineering_run',
        arguments: { request: 'request' }, signal: new AbortController().signal, agent: parent,
      })
      expect(JSON.parse(String(result.value))).toMatchObject({ status: 'RUN_ALREADY_ACTIVE', taskId: '', nextAction: 'WAIT_FOR_CURRENT_RUN' })
      expect(mockedRun).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await owner
    }
  })

  it.each([1, 2] as const)('fails closed for an unmapped legacy v%s completed receipt without changing its bytes', async schemaVersion => {
    const { parent, root } = await fixture()
    const invocationId = engineeringInvocationId('session-1', 'reused-id', root)
    const identity = { invocationId, sessionId: 'session-1', callId: 'reused-id', repositoryIdentity: root }
    const result = { status: 'ACCEPTED' as const, taskId: 'legacy-task', summary: 'accepted before occurrence identity', nextAction: 'NONE' as const }
    await writeEngineeringInvocationReceipt(root, schemaVersion === 1
      ? { ...identity, schemaVersion: 1, result }
      : { ...identity, schemaVersion: 2, phase: 'COMPLETED', taskId: 'legacy-task', result })
    const filename = join(root, ENGINEERING_INVOCATION_DIR, `${invocationId}.json`)
    const originalBytes = await readFile(filename)
    const input = {
      callId: ToolCallId('reused-id'), loggedCallSeq: SessionSeq(12), name: 'engineering_run',
      arguments: { request: 'same request' }, signal: new AbortController().signal, agent: parent,
    }
    const blocked = await parent.ctx.tools.execute(input)
    const replay = await parent.ctx.tools.execute(input)
    expect(replay.value).toBe(blocked.value)
    expect(JSON.parse(String(blocked.value))).toMatchObject({ status: 'BLOCKED', taskId: 'legacy-task', nextAction: 'RECOVER', requiresStopConfirmation: true })
    expect(String(blocked.value)).toContain('cannot safely map')
    expect(mockedRun).not.toHaveBeenCalled()
    expect(await readFile(filename)).toEqual(originalBytes)
    const occurrenceId = engineeringInvocationId('session-1', 'reused-id', root, SessionSeq(12))
    await expect(readEngineeringInvocationReceipt(root, occurrenceId)).resolves.toBeUndefined()
  })

  it('replays a logged occurrence after restart but creates a distinct task for a reused model call id', async () => {
    const first = await fixture()
    let taskCount = 0
    mockedRun.mockImplementation(async options => {
      taskCount++
      const taskId = `task-${taskCount}`
      await options.onTaskSelected?.(taskId)
      return { status: 'ACCEPTED', taskId, summary: 'done', nextAction: 'NONE' }
    })
    const input = {
      callId: ToolCallId('reused-id'), loggedCallSeq: SessionSeq(12), name: 'engineering_run',
      arguments: { request: 'same request' }, signal: new AbortController().signal,
    }
    const original = await first.parent.ctx.tools.execute({ ...input, agent: first.parent })
    expect(JSON.parse(String(original.value))).toMatchObject({ status: 'ACCEPTED', taskId: 'task-1' })
    const invocationId = engineeringInvocationId('session-1', 'reused-id', first.root, SessionSeq(12))
    await expect(readEngineeringInvocationReceipt(first.root, invocationId)).resolves.toMatchObject({ phase: 'COMPLETED', loggedCallSeq: 12, taskId: 'task-1' })
    const replay = await first.parent.ctx.tools.execute({ ...input, agent: first.parent })
    expect(replay.value).toEqual(original.value)
    await first.ctx.fiber.dispose()
    const restarted = await fixture(first.root)
    const afterRestart = await restarted.parent.ctx.tools.execute({ ...input, agent: restarted.parent })
    expect(afterRestart.value).toEqual(original.value)
    expect(mockedRun).toHaveBeenCalledTimes(1)
    const distinct = await restarted.parent.ctx.tools.execute({ ...input, loggedCallSeq: SessionSeq(20), agent: restarted.parent })
    expect(JSON.parse(String(distinct.value))).toMatchObject({ status: 'ACCEPTED', taskId: 'task-2' })
    expect(mockedRun).toHaveBeenCalledTimes(2)
    const oldReplay = await restarted.parent.ctx.tools.execute({ ...input, agent: restarted.parent })
    expect(oldReplay.value).toEqual(original.value)
    expect(mockedRun).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight invocation and treats a later distinct call with the same request text as new', async () => {
    const { parent, root } = await fixture()
    const tool = parent.ctx.tools.get('engineering_run', parent)
    expect(tool).toBeDefined()
    const firstRun = deferred<{ status: 'ACCEPTED'; taskId: string; summary: string; nextAction: 'NONE' }>()
    mockedRun.mockImplementation(async options => {
      const id = engineeringInvocationId('session-1', 'call-1', root)
      await expect(readEngineeringInvocationReceipt(root, id)).resolves.toMatchObject({ phase: 'CLAIMED' })
      await options.onTaskSelected?.('task-1')
      await expect(readEngineeringInvocationReceipt(root, id)).resolves.toMatchObject({ phase: 'TASK_BOUND', taskId: 'task-1' })
      await firstRun.promise
      return { status: 'ACCEPTED', taskId: 'task-1', summary: 'first', nextAction: 'NONE' }
    })
    const signal = new AbortController().signal
    const first = parent.ctx.tools.execute({
      callId: ToolCallId('call-1'), name: 'engineering_run', arguments: { request: 'same request text' }, signal, agent: parent,
    })
    const second = parent.ctx.tools.execute({
      callId: ToolCallId('call-1'), name: 'engineering_run', arguments: { request: 'same request text' }, signal, agent: parent,
    })
    await vi.waitFor(() => expect(mockedRun).toHaveBeenCalledTimes(1))
    expect(mockedRun).toHaveBeenCalledTimes(1)
    firstRun.resolve({ status: 'ACCEPTED', taskId: 'task-1', summary: 'first', nextAction: 'NONE' })
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.isError).toBe(false)
    expect(secondResult.isError).toBe(false)
    expect(firstResult.value).toBe(secondResult.value)
    expect(JSON.parse(String(firstResult.value))).toMatchObject({ taskId: 'task-1' })
    expect(mockedRun).toHaveBeenCalledTimes(1)

    const replayed = await parent.ctx.tools.execute({
      callId: ToolCallId('call-1'), name: 'engineering_run', arguments: { request: 'same request text' }, signal, agent: parent,
    })
    expect(replayed.isError).toBe(false)
    expect(replayed.value).toBe(firstResult.value)
    expect(mockedRun).toHaveBeenCalledTimes(1)

    mockedRun.mockResolvedValue({ status: 'ACCEPTED', taskId: 'task-2', summary: 'second', nextAction: 'NONE' })
    const third = await parent.ctx.tools.execute({
      callId: ToolCallId('call-2'), name: 'engineering_run', arguments: { request: 'same request text' }, signal, agent: parent,
    })
    expect(third.isError).toBe(false)
    expect(JSON.parse(String(third.value))).toMatchObject({ taskId: 'task-2' })
    expect(mockedRun).toHaveBeenCalledTimes(2)
  })

  it.each(['ACCEPTED', 'BLOCKED'] as const)('replays durable %s results from a fresh runtime', async status => {
    const first = await fixture()
    const result = { status, taskId: 'task-1', summary: 'settled', nextAction: status === 'ACCEPTED' ? 'NONE' as const : 'REPLAN_WITH_SCOPE' as const }
    mockedRun.mockImplementation(async options => {
      await options.onTaskSelected?.('task-1')
      return result
    })
    const input = { callId: ToolCallId('call-1'), name: 'engineering_run', arguments: { request: 'request' }, signal: new AbortController().signal }
    const original = await first.parent.ctx.tools.execute({ ...input, agent: first.parent })
    await first.ctx.fiber.dispose()
    const second = await fixture(first.root)
    const replay = await second.parent.ctx.tools.execute({ ...input, arguments: { request: 'changed replay text' }, agent: second.parent })
    expect(replay.value).toEqual(original.value)
    expect(JSON.parse(String(replay.value))).toEqual(result)
    expect(mockedRun).toHaveBeenCalledTimes(1)
  })

  it.each(['CLAIMED', 'TASK_BOUND'] as const)('fails closed after interruption at %s without dispatching a task', async phase => {
    const { parent, root } = await fixture()
    const invocationId = engineeringInvocationId('session-1', 'call-1', root)
    const identity = { invocationId, sessionId: 'session-1', callId: 'call-1', repositoryIdentity: root }
    await claimEngineeringInvocation(root, { ...identity, schemaVersion: 2, phase: 'CLAIMED' })
    if (phase === 'TASK_BOUND') await writeEngineeringInvocationReceipt(root, { ...identity, schemaVersion: 2, phase, taskId: 'task-original' })
    const input = { callId: ToolCallId('call-1'), name: 'engineering_run', arguments: { request: 'request' }, signal: new AbortController().signal, agent: parent }
    const first = await parent.ctx.tools.execute(input)
    const replay = await parent.ctx.tools.execute(input)
    expect(replay.value).toBe(first.value)
    expect(JSON.parse(String(first.value))).toMatchObject({ status: 'BLOCKED', taskId: phase === 'TASK_BOUND' ? 'task-original' : '', nextAction: 'RECOVER', requiresStopConfirmation: true })
    expect(String(first.value)).toContain('Do not start another task')
    expect(mockedRun).not.toHaveBeenCalled()
  })

  it('does not dispatch when receipt storage or JSON validation fails', async () => {
    const { parent, root } = await fixture()
    const invocationId = engineeringInvocationId('session-1', 'call-1', root)
    await mkdir(join(root, ENGINEERING_INVOCATION_DIR), { recursive: true })
    await writeFile(join(root, ENGINEERING_INVOCATION_DIR, `${invocationId}.json`), '{broken')
    const result = await parent.ctx.tools.execute({ callId: ToolCallId('call-1'), name: 'engineering_run', arguments: { request: 'request' }, signal: new AbortController().signal, agent: parent })
    expect(JSON.parse(String(result.value))).toMatchObject({ status: 'BLOCKED', nextAction: 'RECOVER' })
    expect(mockedRun).not.toHaveBeenCalled()
  })

  it('clears the active map after persistence failure so a repaired receipt is replayed', async () => {
    const { parent, root } = await fixture()
    const invocationId = engineeringInvocationId('session-1', 'call-1', root)
    mockedRun.mockImplementation(async options => {
      await options.onTaskSelected?.('task-1')
      const filename = join(root, ENGINEERING_INVOCATION_DIR, `${invocationId}.json`)
      await rm(filename)
      await mkdir(filename)
      return { status: 'ACCEPTED', taskId: 'task-1', summary: 'done', nextAction: 'NONE' }
    })
    const input = { callId: ToolCallId('call-1'), name: 'engineering_run', arguments: { request: 'request' }, signal: new AbortController().signal, agent: parent }
    const first = await parent.ctx.tools.execute(input)
    await rm(join(root, ENGINEERING_INVOCATION_DIR, `${invocationId}.json`), { recursive: true, force: true })
    const repaired = { status: 'ACCEPTED' as const, taskId: 'task-1', summary: 'repaired', nextAction: 'NONE' as const }
    await writeEngineeringInvocationReceipt(root, {
      invocationId, sessionId: 'session-1', callId: 'call-1', repositoryIdentity: root,
      schemaVersion: 2, phase: 'COMPLETED', taskId: 'task-1', result: repaired,
    })
    const replay = await parent.ctx.tools.execute(input)
    expect(JSON.parse(String(first.value))).toMatchObject({ status: 'BLOCKED', nextAction: 'RECOVER' })
    expect(JSON.parse(String(replay.value))).toEqual(repaired)
    expect(mockedRun).toHaveBeenCalledTimes(1)
  })
})
