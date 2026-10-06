import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { claimEngineeringInvocation, ENGINEERING_INVOCATION_DIR, engineeringInvocationId, readEngineeringInvocationReceipt, withEngineeringInvocationLock, writeEngineeringInvocationReceipt } from '../src/invocation.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('engineering invocation receipts', () => {
  it('reports a live owner without treating lock contention as lock corruption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-invocation-'))
    roots.push(root)
    const invocationId = engineeringInvocationId('session-a', 'call-1', root)
    let release!: () => void
    let markEntered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { markEntered = resolve })
    const owner = withEngineeringInvocationLock(root, invocationId, async () => { markEntered(); await held; return 'owned' })
    const ownerOutcome = owner.then(
      value => ({ value }),
      error => ({ error: error as Error }),
    )
    try {
      await entered
      await expect(withEngineeringInvocationLock(root, invocationId, async () => 'contender')).resolves.toEqual({ acquired: false })
    } finally {
      release()
      await expect(ownerOutcome).resolves.toEqual({ value: { acquired: true, value: 'owned' } })
    }
  })

  it('throws on a timed-out invocation lock with an incomplete owner record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-invocation-'))
    roots.push(root)
    const invocationId = engineeringInvocationId('session-a', 'call-1', root)
    const filename = join(root, ENGINEERING_INVOCATION_DIR, `${invocationId}.json`)
    await mkdir(join(root, ENGINEERING_INVOCATION_DIR), { recursive: true })
    await writeFile(`${filename}.lock`, 'incomplete', { mode: 0o600 })

    await expect(withEngineeringInvocationLock(root, invocationId, async () => 'must not run'))
      .rejects.toThrow(/timed out waiting for the writer lock/)
    expect(await readFile(`${filename}.lock`, 'utf8')).toBe('incomplete')
  })

  it('derives an identity from call identity and repository, never request text', () => {
    const first = engineeringInvocationId('session-a', 'call-1', '/repo')
    const same = engineeringInvocationId('session-a', 'call-1', '/repo')
    expect(first).toBe(same)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(engineeringInvocationId('session-b', 'call-1', '/repo')).not.toBe(first)
    expect(engineeringInvocationId('session-a', 'call-2', '/repo')).not.toBe(first)
    expect(engineeringInvocationId('session-a', 'call-1', '/other-repo')).not.toBe(first)
    const logged = engineeringInvocationId('session-a', 'call-1', '/repo', SessionSeq(12))
    expect(logged).not.toBe(first)
    expect(engineeringInvocationId('session-a', 'call-1', '/repo', SessionSeq(12))).toBe(logged)
    expect(engineeringInvocationId('session-a', 'call-1', '/repo', SessionSeq(13))).not.toBe(logged)
  })

  it('persists and reads a replay receipt atomically under the runtime-owned directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-invocation-'))
    roots.push(root)
    const id = engineeringInvocationId('session-a', 'call-1', '/repo')
    const result = { status: 'ACCEPTED' as const, taskId: 'task-1', summary: 'done', nextAction: 'NONE' as const }
    await writeEngineeringInvocationReceipt(root, {
      schemaVersion: 1, invocationId: id, sessionId: 'session-a', callId: 'call-1', repositoryIdentity: '/repo', result,
    })
    await expect(readEngineeringInvocationReceipt(root, id)).resolves.toMatchObject({ result })
    const saved = JSON.parse(await readFile(join(root, ENGINEERING_INVOCATION_DIR, `${id}.json`), 'utf8'))
    expect(saved).toMatchObject({ schemaVersion: 1, invocationId: id, result })
  })

  it('returns absent only for a missing file and rejects corrupted receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-invocation-'))
    roots.push(root)
    const id = engineeringInvocationId('session-a', 'call-1', '/repo')
    await expect(readEngineeringInvocationReceipt(root, id)).resolves.toBeUndefined()
    const filename = join(root, ENGINEERING_INVOCATION_DIR, `${id}.json`)
    await mkdir(join(root, ENGINEERING_INVOCATION_DIR), { recursive: true })
    await writeFile(filename, '{broken')
    await expect(readEngineeringInvocationReceipt(root, id)).rejects.toThrow()
  })

  it('claims exclusively and binds the task before persisting its result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-invocation-'))
    roots.push(root)
    const invocationId = engineeringInvocationId('session-a', 'call-1', root)
    const identity = { invocationId, sessionId: 'session-a', callId: 'call-1', repositoryIdentity: root }
    const claim = { ...identity, schemaVersion: 2 as const, phase: 'CLAIMED' as const }
    expect((await Promise.all([claimEngineeringInvocation(root, claim), claimEngineeringInvocation(root, claim)])).sort()).toEqual([false, true])
    await expect(readEngineeringInvocationReceipt(root, invocationId)).resolves.toEqual(claim)
    const binding = { ...identity, schemaVersion: 2 as const, phase: 'TASK_BOUND' as const, taskId: 'task-1' }
    await writeEngineeringInvocationReceipt(root, binding)
    await expect(readEngineeringInvocationReceipt(root, invocationId)).resolves.toEqual(binding)
    const result = { status: 'BLOCKED' as const, taskId: 'task-1', summary: 'confirm stopped children', nextAction: 'RECOVER' as const, requiresStopConfirmation: true }
    const completed = { ...binding, phase: 'COMPLETED' as const, result }
    await writeEngineeringInvocationReceipt(root, completed)
    await expect(readEngineeringInvocationReceipt(root, invocationId)).resolves.toEqual(completed)
  })

  it.each([-1, 1.5, '12', Number.MAX_SAFE_INTEGER + 1, 13])('rejects invalid or identity-mismatched durable occurrence %j', async loggedCallSeq => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-invocation-'))
    roots.push(root)
    const invocationId = engineeringInvocationId('session-a', 'call-1', root, SessionSeq(12))
    await mkdir(join(root, ENGINEERING_INVOCATION_DIR), { recursive: true })
    await writeFile(join(root, ENGINEERING_INVOCATION_DIR, `${invocationId}.json`), JSON.stringify({
      schemaVersion: 2, phase: 'CLAIMED', invocationId, sessionId: 'session-a', callId: 'call-1', repositoryIdentity: root, loggedCallSeq,
    }))
    await expect(readEngineeringInvocationReceipt(root, invocationId)).rejects.toThrow()
  })

  it.each([
    { schemaVersion: 8 }, { sessionId: 'wrong-session' }, { callId: 'wrong-call' }, { repositoryIdentity: '/wrong-repo' },
    { unexpected: true }, { result: {} },
    { result: { status: 'ACCEPTED', taskId: 'task-1', summary: 'done', nextAction: 'RECOVER' } },
    { result: { status: 'BLOCKED', taskId: 'task-1', summary: 'blocked', nextAction: 'NONE' } },
    { result: { status: 'BLOCKED', taskId: '../outside', summary: 'blocked', nextAction: 'RECOVER' } },
    { result: { status: 'ACCEPTED', taskId: 'task-1', summary: 'done', nextAction: 'NONE', state: { taskId: 'task-1' } } },
  ])('rejects invalid durable receipt fields %j', async patch => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-invocation-'))
    roots.push(root)
    const invocationId = engineeringInvocationId('session-a', 'call-1', root)
    await mkdir(join(root, ENGINEERING_INVOCATION_DIR), { recursive: true })
    await writeFile(join(root, ENGINEERING_INVOCATION_DIR, `${invocationId}.json`), JSON.stringify({
      schemaVersion: 1, invocationId, sessionId: 'session-a', callId: 'call-1', repositoryIdentity: root,
      result: { status: 'ACCEPTED', taskId: 'task-1', summary: 'done', nextAction: 'NONE' }, ...patch,
    }))
    await expect(readEngineeringInvocationReceipt(root, invocationId)).rejects.toThrow()
  })
})
