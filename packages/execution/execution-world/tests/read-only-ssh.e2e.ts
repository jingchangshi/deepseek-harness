/** Opt-in root-read acceptance through an OpenSSH client and a POSIX helper. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SshConnection, type Config } from '@deepseek-ai/dsh-ssh'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { SshSandboxProvider } from '@deepseek-ai/dsh-sandbox-ssh'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it } from 'vitest'
import ExecutionWorldIdentity from '../src/index.ts'
import { bindExecutionReadLease, type ExecutionReadLease } from '@deepseek-ai/dsh-execution-world/read-lease'
import { open } from './fixtures/harness.ts'

const configPath = process.env.DSH_SSH_TEST_CONFIG

describe.skipIf(configPath === undefined)('OpenSSH root-read binding', () => {
  it.each(['binding', 'connection', 'transport'] as const)('reads the remote root and revokes access after %s disposal', async (owner) => {
    if (configPath === undefined) throw new Error('Missing SSH acceptance configuration')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Config
    const localRoot = await mkdtemp(join(tmpdir(), 'dsh-root-ssh-'))
    const harness = await open(localRoot, { mode: 'deployment', deploymentId: randomUUID() }, false)
    const fibers = []
    let remoteRoot: string | undefined
    let primaryConnectionUsable = true
    let primaryFailure: { error: unknown } | undefined
    const teardownFailures: unknown[] = []
    try {
      await writeFile(join(localRoot, 'inside.txt'), 'HOST_ONLY')
      await harness.dependencies.fs.dispose()
      const projection = harness.ctx.plugin(SessionProjectionRegistry)
      fibers.push(projection)
      await projection
      const policy = harness.ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: config.workspace })
      fibers.push(policy)
      await policy
      const connection = harness.ctx.plugin(SshConnection, config)
      fibers.push(connection)
      await connection
      for (const provider of [SshFileSystem, SshSubprocessRuntime, SshSandboxProvider]) {
        const fiber = harness.ctx.plugin(provider)
        fibers.push(fiber)
        await fiber
      }
      const hello = await harness.ctx.ssh.ready
      const identity = harness.ctx.plugin(ExecutionWorldIdentity, {
        mode: 'deployment', deploymentId: randomUUID(), allocationLockPath: join(localRoot, 'identity.lock'),
      })
      fibers.push(identity)
      await identity
      const run = async (script: string, args: string[] = []) => {
        const handle = harness.ctx.subprocess.spawn({
          argv: [hello.node, '-e', script, ...args], cwd: hello.workspace,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 1000,
        })
        const outcome = await handle.done
        expect(await handle.waitForExit()).toBe(true)
        expect(outcome.exitCode, handle.collected.stderr?.readFrom(0).text).toBe(0)
        return handle.collected.stdout?.readFrom(0).text ?? ''
      }
      remoteRoot = await run(
        'const fs=require("node:fs");const path=require("node:path");const root=fs.mkdtempSync(path.join(process.argv[1],"root-read-"));'
        + 'fs.mkdirSync(path.join(root,"bound","physical"),{recursive:true});'
        + 'fs.writeFileSync(path.join(root,"bound","inside.txt"),"REMOTE_ONLY");'
        + 'fs.writeFileSync(path.join(root,"bound",".env"),"SENSITIVE_FIXTURE");'
        + 'fs.symlinkSync(".env",path.join(root,"bound","innocent.txt"));'
        + 'fs.writeFileSync(path.join(root,"bound","physical","file.txt"),"ALIAS_DATA");'
        + 'fs.writeFileSync(path.join(root,"outside.txt"),"OUTSIDE");'
        + 'fs.symlinkSync("physical",path.join(root,"bound","inside-link"));'
        + 'fs.symlinkSync("../outside.txt",path.join(root,"bound","escape"));process.stdout.write(root)',
        [hello.workspace],
      )
      let binding: ExecutionReadLease | undefined
      const consumer = harness.ctx.plugin({
        name: 'ssh-root-acceptance', inject: ['executionWorldIdentity', 'fs', 'subprocess', 'sandbox'],
        async apply(ctx: Context) { binding = await bindExecutionReadLease(ctx, `${remoteRoot}/bound`) },
      })
      fibers.push(consumer)
      await consumer
      if (binding === undefined) throw new Error('Missing execution binding')
      expect(Object.keys(binding).sort()).toEqual(['dispose', 'fs', 'workspaceId'])
      expect(await binding.fs.readText('inside.txt', 11)).toBe('REMOTE_ONLY')
      expect(await readFile(join(localRoot, 'inside.txt'), 'utf8')).toBe('HOST_ONLY')
      expect(await binding.fs.stat('inside.txt')).toMatchObject({ type: 'file', size: 11 })
      await expect(binding.fs.readText('inside-link/file.txt', 10)).rejects.toThrow()
      await expect(binding.fs.readText('innocent.txt', 100)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(binding.fs.readText('escape', 100)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(binding.fs.readText('inside.txt', 10)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
      const entries = await binding.fs.listDir('')
      expect(entries.map(entry => entry.name)).toContain('inside.txt')
      for (const entry of entries) {
        expect(entry).not.toHaveProperty('target')
        expect(entry).not.toHaveProperty('targetKey')
      }
      for (const method of ['readBytes', 'readByteRange', 'streamText', 'writeText']) expect(binding.fs).not.toHaveProperty(method)
      await binding.dispose()
      await expect(binding.fs.readText('inside.txt', 11)).rejects.toThrow()
      await consumer.dispose()
      if (owner !== 'binding') {
        const live = harness.ctx.plugin({
          name: 'ssh-root-live-acceptance', inject: ['executionWorldIdentity', 'fs', 'subprocess', 'sandbox'],
          async apply(ctx: Context) { binding = await bindExecutionReadLease(ctx, `${remoteRoot}/bound`) },
        })
        fibers.push(live)
        await live
        expect(await binding.fs.readText('inside.txt', 11)).toBe('REMOTE_ONLY')
        const remote = harness.ctx.ssh
        primaryConnectionUsable = false
        if (owner === 'connection') {
          await connection.dispose()
          expect(await remote.joinRemoteCleanupIfClosing()).toBe(true)
          await expect(binding.fs.readText('inside.txt', 11)).rejects.toThrow()
          await binding.dispose()
        } else {
          const child = Reflect.get(remote, 'child') as ChildProcess
          const closed = once(child, 'close')
          child.kill('SIGKILL')
          await closed
          await expect(remote.joinRemoteCleanupIfClosing()).rejects.toThrow('cleanup outcome unknown')
          await expect(binding.fs.readText('inside.txt', 11)).rejects.toThrow()
          await expect(binding.dispose()).rejects.toThrow(/cleanup failed|cleanup outcome unknown/u)
        }
      }
    } catch (error) {
      primaryFailure = { error }
    } finally {
      const cleanupContext = primaryConnectionUsable ? harness.ctx : new Context()
      const cleanupFibers = []
      try {
        if (remoteRoot !== undefined && !primaryConnectionUsable) {
          const connection = cleanupContext.plugin(SshConnection, config)
          cleanupFibers.push(connection)
          await connection
          const subprocess = cleanupContext.plugin(SshSubprocessRuntime)
          cleanupFibers.push(subprocess)
          await subprocess
        }
        if (remoteRoot !== undefined) {
          const node = (await cleanupContext.ssh.ready).node
          const cleanup = cleanupContext.subprocess.spawn({
            argv: [node, '-e', 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:true})', remoteRoot],
            cwd: config.workspace, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 1000,
          })
          expect((await cleanup.done).exitCode).toBe(0)
          expect(await cleanup.waitForExit()).toBe(true)
        }
      } catch (error) {
        teardownFailures.push(error)
      } finally {
        for (const fiber of [...fibers, ...cleanupFibers].reverse()) {
          try { await fiber.dispose() } catch (error) { teardownFailures.push(error) }
        }
        try { await harness.close() } catch (error) { teardownFailures.push(error) }
        try { await rm(localRoot, { recursive: true, force: true }) } catch (error) { teardownFailures.push(error) }
      }
    }
    if (primaryFailure !== undefined) throw primaryFailure.error
    if (teardownFailures.length > 0) throw new AggregateError(teardownFailures, 'SSH acceptance fixture cleanup failed')
  }, 120_000)
})
