/** Opt-in fixed Git lease acceptance through real POSIX OpenSSH and a Linux helper. */
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
import { bindExecutionGitLease, type ExecutionGitLease } from '@deepseek-ai/dsh-execution-world/git-lease'
import { open } from './fixtures/harness.ts'

const configPath = process.env.DSH_SSH_TEST_CONFIG
const prefix = ['--no-optional-locks', '-c', 'core.fsmonitor=false'] as const

describe.skipIf(configPath === undefined || process.platform === 'win32')('OpenSSH fixed Git lease', () => {
  it.each(['binding', 'connection', 'transport'] as const)('reads the remote repository and revokes %s ownership', async (owner) => {
    if (configPath === undefined) throw new Error('Missing SSH acceptance configuration')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Config
    const localRoot = await mkdtemp(join(tmpdir(), 'dsh-git-ssh-'))
    const harness = await open(localRoot, { mode: 'deployment', deploymentId: randomUUID() }, false)
    const fibers = []
    let remoteRoot: string | undefined
    let primaryConnectionUsable = true
    const teardownFailures: unknown[] = []
    let primaryFailure: { error: unknown } | undefined
    try {
      await writeFile(join(localRoot, 'REMOTE_ONLY.txt'), 'HOST_ONLY')
      await harness.dependencies.fs.dispose()
      const connection = harness.ctx.plugin(SshConnection, config)
      for (const fiber of [
        harness.ctx.plugin(SessionProjectionRegistry),
        harness.ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: config.workspace }),
        connection,
      ]) {
        fibers.push(fiber)
        await fiber
      }
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
      const run = async (argv: string[], cwd = config.workspace) => {
        const handle = harness.ctx.subprocess.spawn({
          argv, cwd, stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } }, graceMs: 1_000,
        })
        const outcome = await handle.done
        expect(await handle.waitForExit()).toBe(true)
        expect(outcome.exitCode, handle.collected.stderr?.readFrom(0).text).toBe(0)
        return handle.collected.stdout?.readFrom(0).text ?? ''
      }
      remoteRoot = await run([hello.node, '-e',
        'const fs=require("node:fs");const path=require("node:path");process.stdout.write(fs.mkdtempSync(path.join(process.argv[1],"git-lease-")))',
        config.workspace])
      await run(['git', 'init', '-q', remoteRoot])
      await run([hello.node, '-e',
        'const fs=require("node:fs");const path=require("node:path");for(const [name,data] of [["REMOTE_ONLY.txt","REMOTE_ONLY"],["converted.txt","CONVERTED_BASE"],[".gitattributes","converted.txt diff=converted\\n"]])fs.writeFileSync(path.join(process.argv[1],name),data)',
        remoteRoot])
      await run(['git', 'add', 'REMOTE_ONLY.txt', 'converted.txt', '.gitattributes'], remoteRoot)
      await run(['git', '-c', 'user.name=DSH Test', '-c', 'user.email=dsh-test@example.invalid', 'commit', '-qm', 'remote initial'], remoteRoot)
      const head = (await run(['git', 'rev-parse', 'HEAD'], remoteRoot)).trim()
      await run([hello.node, '-e', 'require("node:fs").writeFileSync(require("node:path").join(process.argv[1],"committed.txt"),"COMMITTED_REMOTE")', remoteRoot])
      await run(['git', 'add', 'committed.txt'], remoteRoot)
      await run(['git', '-c', 'user.name=DSH Test', '-c', 'user.email=dsh-test@example.invalid', 'commit', '-qm', 'remote second'], remoteRoot)
      await run([hello.node, '-e',
        'const fs=require("node:fs");const path=require("node:path");fs.writeFileSync(path.join(process.argv[1],"REMOTE_ONLY.txt"),"REMOTE_ONLY_CHANGED");fs.writeFileSync(path.join(process.argv[1],"converted.txt"),"CONVERTED_CHANGED");fs.writeFileSync(path.join(process.argv[1],"staged.txt"),"STAGED_REMOTE");fs.mkdirSync(path.join(process.argv[1],"nested"));fs.writeFileSync(path.join(process.argv[1],"nested","new.txt"),"REMOTE_NEW");for(const [name,data] of [["external.sh","#!/bin/sh\\nprintf EXTERNAL_DIFF_EXECUTED\\n"],["textconv.sh","#!/bin/sh\\nprintf TEXTCONV_EXECUTED\\ncat \\\"$1\\\"\\n"]]){const script=path.join(process.argv[1],name);fs.writeFileSync(script,data);fs.chmodSync(script,0o700)}',
        remoteRoot])
      await run(['git', 'add', 'staged.txt'], remoteRoot)
      await run(['git', 'config', 'diff.external', remoteRoot + '/external.sh'], remoteRoot)
      await run(['git', 'config', 'diff.converted.textconv', remoteRoot + '/textconv.sh'], remoteRoot)
      expect(await run(['git', 'diff', '--ext-diff', 'HEAD', '--', 'REMOTE_ONLY.txt'], remoteRoot)).toContain('EXTERNAL_DIFF_EXECUTED')
      expect(await run(['git', 'diff', '--textconv', 'HEAD', '--', 'converted.txt'], remoteRoot)).toContain('TEXTCONV_EXECUTED')
      let readLease!: ExecutionReadLease
      let gitLease!: ExecutionGitLease
      const consumer = harness.ctx.plugin({
        name: 'ssh-git-acceptance', inject: ['executionWorldIdentity', 'fs', 'subprocess', 'sandbox'],
        async apply(ctx: Context) {
          readLease = await bindExecutionReadLease(ctx, remoteRoot!)
          gitLease = await bindExecutionGitLease(ctx, remoteRoot!)
        },
      })
      fibers.push(consumer)
      await consumer
      expect(gitLease.workspaceId).toBe(readLease.workspaceId)
      const execute = (args: string[]) => gitLease.git.execute([...prefix, ...args], {
        maxBytes: 8192, timeoutMs: 20_000, signal: new AbortController().signal,
      })
      const status = await execute(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
      expect(status.stdout).toContain('REMOTE_ONLY.txt')
      expect(status.stdout).toContain('nested/new.txt')
      expect(status.stdout).toContain('staged.txt')
      expect(status.stdout).not.toContain('HOST_ONLY')
      const diff = await execute(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ':(literal)REMOTE_ONLY.txt'])
      expect(diff.stdout).toContain('REMOTE_ONLY_CHANGED')
      expect(diff.stdout).not.toContain('HOST_ONLY')
      expect(diff.stdout).not.toContain('EXTERNAL_DIFF_EXECUTED')
      const converted = await execute(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ':(literal)converted.txt'])
      expect(converted.stdout).toContain('CONVERTED_CHANGED')
      expect(converted.stdout).not.toContain('TEXTCONV_EXECUTED')
      const committed = await execute(['diff', '--no-ext-diff', '--no-textconv', head, '--', ':(literal)committed.txt'])
      expect(committed.stdout).toContain('COMMITTED_REMOTE')
      const staged = await execute(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ':(literal)staged.txt'])
      expect(staged.stdout).toContain('STAGED_REMOTE')
      const newFile = await execute(['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', 'nested/new.txt'])
      expect(newFile.exitCode).toBe(1)
      expect(newFile.stdout).toContain('REMOTE_NEW')
      const history = await execute(['log', '--max-count=5', '--pretty=format:%H %s'])
      expect(history.stdout).toContain(head)
      expect(history.stdout).toContain('remote initial')
      expect(await readLease.fs.readText('REMOTE_ONLY.txt', 100)).toBe('REMOTE_ONLY_CHANGED')
      if (owner === 'binding') {
        await gitLease.dispose()
        await readLease.dispose()
      } else {
        const remote = harness.ctx.ssh
        primaryConnectionUsable = false
        if (owner === 'connection') {
          await connection.dispose()
          expect(await remote.joinRemoteCleanupIfClosing()).toBe(true)
          await expect(execute(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).rejects.toThrow()
          await gitLease.dispose()
          await readLease.dispose()
        } else {
          const child = Reflect.get(remote, 'child') as ChildProcess
          const closed = once(child, 'close')
          child.kill('SIGKILL')
          await closed
          await expect(remote.joinRemoteCleanupIfClosing()).rejects.toThrow('cleanup outcome unknown')
          await expect(execute(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).rejects.toThrow()
          await expect(gitLease.dispose()).rejects.toThrow(/cleanup failed|cleanup outcome unknown/u)
          await expect(readLease.dispose()).rejects.toThrow(/cleanup failed|cleanup outcome unknown/u)
        }
      }
    } catch (error) {
      primaryFailure = { error }
    } finally {
      const cleanupContext = primaryConnectionUsable ? harness.ctx : new Context()
      const cleanupFibers = []
      if (remoteRoot !== undefined && !primaryConnectionUsable) {
        try {
          const connection = cleanupContext.plugin(SshConnection, config)
          cleanupFibers.push(connection)
          await connection
          const subprocess = cleanupContext.plugin(SshSubprocessRuntime)
          cleanupFibers.push(subprocess)
          await subprocess
        } catch (error) { teardownFailures.push(error) }
      }
      if (remoteRoot !== undefined && cleanupContext.ssh !== undefined) {
        try {
          const node = (await cleanupContext.ssh.ready).node
          const handle = cleanupContext.subprocess.spawn({
            argv: [node, '-e', 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:true})', remoteRoot],
            cwd: config.workspace, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 1_000,
          })
          expect((await handle.done).exitCode).toBe(0)
          expect(await handle.waitForExit()).toBe(true)
        } catch (error) { teardownFailures.push(error) }
      }
      for (const fiber of [...fibers, ...cleanupFibers].reverse()) {
        try { await fiber.dispose() } catch (error) { teardownFailures.push(error) }
      }
      try { await harness.close() } catch (error) { teardownFailures.push(error) }
      try { await rm(localRoot, { recursive: true, force: true }) } catch (error) { teardownFailures.push(error) }
    }
    if (primaryFailure !== undefined) throw primaryFailure.error
    if (teardownFailures.length > 0) throw new AggregateError(teardownFailures, 'SSH Git acceptance cleanup failed')
  }, 120_000)
})
