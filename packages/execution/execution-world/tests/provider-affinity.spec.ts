import { Context, Service } from '@deepseek-ai/cordis'
import { createExecutionWorldAffinity, HOST_EXECUTION_WORLD_AFFINITY } from '@deepseek-ai/dsh-execution-world-affinity'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import SshFileSystem from '@deepseek-ai/dsh-fs-ssh'
import SshSubprocessRuntime from '@deepseek-ai/dsh-subprocess-ssh'
import SshSandboxProvider from '@deepseek-ai/dsh-sandbox-ssh'
import { describe, expect, it, onTestFinished } from 'vitest'

class Connection extends Service {
  readonly executionWorldAffinity = createExecutionWorldAffinity()
  constructor(ctx: Context) { super(ctx, 'ssh') }
}

class Policy extends Service {
  constructor(ctx: Context) { super(ctx, 'sandboxPolicy') }
}

async function remoteProviders() {
  const ctx = new Context()
  const connection = await ctx.plugin(Connection)
  onTestFinished(() => connection.dispose())
  const policy = await ctx.plugin(Policy)
  onTestFinished(() => policy.dispose())
  const filesystem = await ctx.plugin(SshFileSystem)
  onTestFinished(() => filesystem.dispose())
  const subprocess = await ctx.plugin(SshSubprocessRuntime)
  onTestFinished(() => subprocess.dispose())
  const sandbox = await ctx.plugin(SshSandboxProvider)
  onTestFinished(() => sandbox.dispose())
  return ctx
}

describe('execution provider namespace ownership', () => {
  it('shares the Host witness across local filesystem, processes, and confinement', async () => {
    const ctx = new Context()
    const filesystem = await ctx.plugin(LocalFileSystem)
    onTestFinished(() => filesystem.dispose())
    const subprocess = await ctx.plugin(LocalSubprocessRuntime)
    onTestFinished(() => subprocess.dispose())
    const sandbox = await ctx.plugin(LocalSandboxProvider)
    onTestFinished(() => sandbox.dispose())
    expect(ctx.fs.executionWorldAffinity).toBe(HOST_EXECUTION_WORLD_AFFINITY)
    expect(ctx.subprocess.executionWorldAffinity).toBe(ctx.fs.executionWorldAffinity)
    expect(ctx.sandbox.executionWorldAffinity).toBe(ctx.fs.executionWorldAffinity)
  })

  it('forwards one connection owner witness without equating distinct connections or the Host', async () => {
    const first = await remoteProviders()
    const second = await remoteProviders()
    expect(first.fs.executionWorldAffinity).toBe(first.ssh.executionWorldAffinity)
    expect(first.subprocess.executionWorldAffinity).toBe(first.fs.executionWorldAffinity)
    expect(first.sandbox.executionWorldAffinity).toBe(first.fs.executionWorldAffinity)
    expect(second.fs.executionWorldAffinity).not.toBe(first.fs.executionWorldAffinity)
    expect(first.fs.executionWorldAffinity).not.toBe(HOST_EXECUTION_WORLD_AFFINITY)
  })
})
