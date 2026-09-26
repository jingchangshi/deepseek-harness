/** Real Web-profile Session ownership over the Windows Browser Harness lane. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const enabled = process.platform === 'win32' && process.env.DSH_BROWSER_HARNESS_E2E === '1'
const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))

it.runIf(enabled)('mounts Browser Harness in a real Web process and reacquires it for a fresh Session', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-browser-harness-'))
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<!doctype html><title>DSH Web Session probe</title>')
  })
  const processState: { child?: ReturnType<typeof spawn>; completion?: Promise<unknown> } = {}
  test.onTestFinished(async () => {
    let forced = false
    const watchdog = setTimeout(() => {
      if (processState.child && processState.child.exitCode === null) {
        forced = true
        processState.child.kill('SIGKILL')
      }
    }, 10_000)
    try {
      if (processState.child && processState.child.exitCode === null) {
        try { processState.child.send('stop') } catch (_closedChannel) { processState.child.kill('SIGKILL') }
      }
      const exit = await processState.completion as [number | null, NodeJS.Signals | null] | undefined
      if (exit) {
        expect(forced).toBe(false)
        expect(exit[1]).toBeNull()
        expect(exit[0]).toBe(0)
      }
    } finally {
      clearTimeout(watchdog)
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve) => { server.close(() => resolve()) })
      await rm(root, { recursive: true, force: true })
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Loopback fixture did not bind')
  const url = `http://127.0.0.1:${address.port}/probe`
  await mkdir(join(root, 'workspace'))
  const patch = join(root, 'browser.patch.yml')
  await writeFile(patch, JSON.stringify([{ insert: [
    { id: 'browser-use', name: '@deepseek-ai/dsh-browser-use' },
    { id: 'browser-use-browser-harness-mcp', name: '@deepseek-ai/dsh-experimental-browser-use-browser-harness-mcp',
      config: { command: process.env.DSH_BROWSER_HARNESS_COMMAND ?? 'browser-harness-mcp',
        cdpUrl: process.env.BU_CDP_URL ?? 'http://127.0.0.1:9222', toolCallTimeoutMs: 30_000 } },
    { id: 'browser-harness-session-observer', name: new URL('./fixtures/browser-harness-session.mjs', import.meta.url).href },
  ] }]) + '\n')
  const child = spawn(process.execPath, ['--import', 'tsx/esm', join(repoRoot, 'apps/cli/src/bin.ts'), '--profile', 'web', '--patch', patch,
    '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: repoRoot,
    env: { ...process.env, DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'),
      TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.host.json'),
      DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'keyless-no-model-calls' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  processState.child = child
  processState.completion = once(child, 'close')
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream!.on('data', (chunk) => { output = (output + String(chunk)).slice(-30_000) })
  await expect.poll(() => {
    test.signal.throwIfAborted()
    if (child.exitCode !== null) throw new Error(`Web exited before readiness: ${output}`)
    return output.includes('dsh web: http://')
  }, { timeout: 60_000 }).toBe(true)
  const reports = await new Promise<{ names: string[]; info: string }[]>((resolve, reject) => {
    child.once('message', (message: { result?: { names: string[]; info: string }[]; error?: string }) => {
      if (message.error) reject(new Error(`${message.error}\n${output.replace(/([?&]token=)[^\s&]+/gu, '$1[redacted]')}`))
      else if (message.result) resolve(message.result)
      else reject(new Error('Web observer returned no Session result'))
    })
    child.send({ command: 'probe', url }, (error) => { if (error) reject(error) })
  })
  expect(reports).toHaveLength(2)
  for (const report of reports) {
    expect(report.names).toContain('mcp__browser-harness__browser_page_info')
    expect(report.names).toContain('mcp__browser-harness__browser_list_tabs')
    expect(report.info).toContain('/probe')
  }
})
