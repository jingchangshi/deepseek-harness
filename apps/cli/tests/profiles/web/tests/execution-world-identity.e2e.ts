import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))

it('preserves base-owned workspace identity across real Web process restart', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-world-'))
  const children: { child: ReturnType<typeof spawn>; done: Promise<unknown> }[] = []
  const stop = async (entry: typeof children[number]) => {
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) return
    let forced = false
    const watchdog = setTimeout(() => { forced = true; entry.child.kill('SIGKILL') }, 10_000)
    try {
      if (entry.child.connected) entry.child.send('stop')
      else entry.child.kill('SIGTERM')
      const result = await entry.done
      expect(forced).toBe(false)
      expect(result).toEqual([0, null])
    } finally { clearTimeout(watchdog) }
  }
  test.onTestFinished(async () => {
    try { await Promise.all(children.map(stop)) }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  const workspaceRoot = join(root, 'workspace')
  await mkdir(workspaceRoot)
  const patch = join(root, 'observer.patch.yml')
  await writeFile(patch, JSON.stringify([{ insert: [
    { id: 'execution-world-observer', name: new URL('./fixtures/execution-world-observer.mjs', import.meta.url).href },
  ] }]) + '\n')
  const identities: string[] = []
  for (let generation = 0; generation < 2; generation += 1) {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', join(repoRoot, 'apps/cli/src/bin.ts'),
      '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'),
        TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.host.json'), DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: 'keyless-no-model-calls' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const entry = { child, done: once(child, 'close') }
    children.push(entry)
    let output = ''
    let identityReady = false
    let response: { workspaceId?: string; error?: string } | undefined
    child.on('message', (message: { kind?: string; workspaceId?: string; error?: string }) => {
      if (message.kind === 'identity-ready') identityReady = true
      else response = message
    })
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk) => { output = (output + String(chunk)).slice(-30_000) })
    }
    await expect.poll(() => {
      test.signal.throwIfAborted()
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Web exited before readiness: ${output.replace(/([?&]token=)[^\s&]+/gu, '$1[redacted]')}`)
      return identityReady && output.includes('dsh web: http://')
    }, { timeout: 60_000 }).toBe(true)
    child.send({ command: 'resolve', root: workspaceRoot })
    await expect.poll(() => response, { timeout: 30_000 }).toBeDefined()
    expect(response?.error).toBeUndefined()
    expect(response?.workspaceId).toMatch(/^[0-9a-f-]{36}$/u)
    if (response?.workspaceId === undefined) throw new Error('observer returned no workspace identity')
    identities.push(response.workspaceId)
    await stop(entry)
  }
  expect(identities[1]).toBe(identities[0])
})
