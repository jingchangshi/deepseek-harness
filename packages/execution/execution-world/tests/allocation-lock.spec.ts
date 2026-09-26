import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { withAllocationLock } from '../src/allocation-lock.ts'

async function fixture(test: { onTestFinished(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-allocation-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'workspace'))
  return root
}

function child(fixtureName: string, argument: string) {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  const process = fork(fileURLToPath(new URL(`./fixtures/${fixtureName}.ts`, import.meta.url)), [argument], {
    cwd: repoRoot,
    execArgv: ['--import', 'tsx/esm'],
    env: { ...globalThis.process.env, TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.host.json') },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    timeout: 30_000,
  })
  const messages: unknown[] = []
  const first = once(process, 'message')
  const done = once(process, 'exit')
  let stderr = ''
  process.stdout?.resume()
  process.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8192) })
  process.on('message', message => messages.push(message))
  const ready = Promise.race([first, done.then(() => { throw new Error(`fixture exited before ready: ${stderr}`) })])
  const close = async () => {
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL')
    await done
  }
  return { process, ready, done, messages, close, stderr: () => stderr }
}

it('serializes overlapping producer processes over one fresh identity store', async (test) => {
  const root = await fixture(test)
  const children: ReturnType<typeof child>[] = []
  try {
    await withAllocationLock(join(root, 'identity.lock'), 30_000, new AbortController().signal, async () => {
      children.push(child('restart', root), child('restart', root))
      await Promise.all(children.map(producer => producer.ready))
      for (const producer of children) expect(producer.messages).toEqual([{ kind: 'starting' }])
    })
    for (const producer of children) expect(await producer.done, producer.stderr()).toEqual([0, null])
    const identities = children.map(producer => producer.messages.find(message => (message as { kind: string }).kind === 'identity'))
    expect(identities[0]).toHaveProperty('kind', 'identity')
    expect(identities[0]).toHaveProperty('workspaceId', expect.any(String))
    expect(identities[1]).toEqual(identities[0])
    const restarted = child('restart', root)
    children.push(restarted)
    await restarted.ready
    expect(await restarted.done, restarted.stderr()).toEqual([0, null])
    expect(restarted.messages).toContainEqual(identities[0])
  } finally { await Promise.all(children.map(producer => producer.close())) }
})

it('releases allocation ownership when the holder process is killed', async (test) => {
  const root = await fixture(test)
  const holder = child('lock-holder', join(root, 'identity.lock'))
  let producer: ReturnType<typeof child> | undefined
  try {
    expect((await holder.ready)[0]).toEqual({ kind: 'held' })
    producer = child('restart', root)
    await producer.ready
    expect(producer.messages).toEqual([{ kind: 'starting' }])
    await holder.close()
    expect(await producer.done, producer.stderr()).toEqual([0, null])
    const identity = producer.messages.find(message => (message as { kind: string }).kind === 'identity')
    expect(identity).toHaveProperty('workspaceId', expect.any(String))
  } finally {
    await holder.close()
    await producer?.close()
  }
})

it('cancels or times out a contender without invoking its transaction', async (test) => {
  const root = await fixture(test)
  const path = join(root, 'identity.lock')
  await withAllocationLock(path, 30_000, new AbortController().signal, async () => {
    await expect(withAllocationLock(path, 1, new AbortController().signal, async () => {
      throw new Error('transaction must not run')
    })).rejects.toThrow('lock wait timed out')
    const controller = new AbortController()
    const pending = withAllocationLock(path, 30_000, controller.signal, async () => {
      throw new Error('transaction must not run')
    })
    controller.abort(new Error('caller cancelled'))
    await expect(pending).rejects.toThrow('caller cancelled')
  })
  await expect(withAllocationLock(path, 30_000, new AbortController().signal, async () => 'available')).resolves.toBe('available')
})
