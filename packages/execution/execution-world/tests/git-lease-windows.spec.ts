import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { bindExecutionGitLease, type ExecutionGitLease } from '@deepseek-ai/dsh-execution-world/git-lease'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { probeWindowsJob } from '../../../subprocess/subprocess-local/src/windows-job.ts'
import { open } from './fixtures/harness.ts'

const prefix = ['--no-optional-locks', '-c', 'core.fsmonitor=false']
const status = ['status', '--porcelain=v1', '-z', '--untracked-files=all']
const diff = ['diff', '--no-ext-diff', '--no-textconv']
const limits = () => ({ maxBytes: 65536, timeoutMs: 20_000, signal: new AbortController().signal })

async function snapshot(root: string): Promise<unknown[]> {
  const entries: unknown[] = []
  async function visit(relative: string): Promise<void> {
    const target = join(root, relative)
    const info = await lstat(target, { bigint: true })
    const kind = info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : 'file'
    const content = kind === 'link' ? await readlink(target)
      : kind === 'file' ? createHash('sha256').update(await readFile(target)).digest('hex') : undefined
    entries.push({ relative, kind, size: info.size, mtime: info.mtimeNs, ctime: info.ctimeNs, content })
    if (kind === 'directory') {
      for (const name of (await readdir(target)).sort()) await visit(relative ? relative + '/' + name : name)
    }
  }
  await visit('')
  return entries
}

async function fixture() {
  expect(probeWindowsJob(), 'native Windows Job containment is required').toBe(true)
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-windows-'))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const workspace = join(root, 'workspace')
  const tripwire = join(root, 'tripwire')
  await mkdir(workspace)
  await mkdir(tripwire)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'fixture')
  git('config', 'user.name', 'Git lease fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.autocrlf', 'false')
  await writeFile(join(workspace, 'tracked.txt'), 'first\n')
  git('add', 'tracked.txt')
  git('commit', '-qm', 'first fixture commit')
  await writeFile(join(workspace, 'tracked.txt'), 'second\n')
  git('commit', '-qam', 'second fixture commit')
  git('branch', 'upstream')
  git('branch', '--set-upstream-to=upstream')
  const head = git('rev-parse', 'HEAD')
  await writeFile(join(workspace, 'tracked.txt'), 'staged\n')
  git('add', 'tracked.txt')
  await writeFile(join(workspace, 'tracked.txt'), 'unstaged\n')
  await writeFile(join(workspace, 'untracked.txt'), 'untracked payload\n')
  await writeFile(join(workspace, '.gitattributes'), '*.txt diff=hostile\n')
  const marker = join(tripwire, 'helper-ran').replaceAll('\\', '/')
  const helper = "echo escaped > '" + marker + "'"
  for (const key of ['diff.external', 'diff.hostile.textconv', 'core.fsmonitor', 'core.pager', 'credential.helper']) git('config', key, helper)
  git('config', 'alias.escape', '!' + helper)
  git('config', 'core.hooksPath', tripwire.replaceAll('\\', '/'))
  for (const directory of [workspace, tripwire]) {
    execFileSync('icacls', [directory, '/grant', '*S-1-1-0:(OI)(CI)(M)', '/T'], { stdio: 'pipe' })
  }
  const harness = await open(root)
  onTestFinished(() => harness.close())
  const subprocess = harness.ctx.plugin(LocalSubprocessRuntime)
  onTestFinished(() => subprocess.dispose())
  await subprocess
  const sandbox = harness.ctx.plugin(LocalSandboxProvider, {})
  onTestFinished(() => sandbox.dispose())
  await sandbox
  async function mount(policy: 'require-full' | 'allow-hardened-windows' = 'allow-hardened-windows') {
    let lease!: ExecutionGitLease
    const consumer = harness.ctx.plugin({
      name: 'native-git-acceptance',
      inject: ['executionWorldIdentity', 'fs', 'subprocess', 'sandbox'],
      async apply(ctx: Context) { lease = await bindExecutionGitLease(ctx, workspace, undefined, policy) },
    })
    onTestFinished(() => consumer.dispose())
    await consumer
    return lease
  }
  return { root, workspace, tripwire, head, harness, mount }
}

describe.skipIf(process.platform !== 'win32')('native Windows fixed Git reads', () => {
  it('leaves writable repository state and helper tripwires unchanged for each allowed read', async () => {
    const { workspace, tripwire, head, mount } = await fixture()
    const before = await snapshot(workspace)
    const markers = await snapshot(tripwire)
    const lease = await mount()
    expect(lease.assurance).toBe('hardened-windows')
    expect(await snapshot(workspace)).toEqual(before)
    const cases: [string[], number, string][] = [
      [['rev-parse', '--verify', 'HEAD'], 0, head],
      [['rev-parse', '--is-inside-work-tree'], 0, 'true'],
      [['rev-parse', '--abbrev-ref', 'HEAD'], 0, 'fixture'],
      [['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 0, 'upstream'],
      [['rev-parse', '--verify', '@{u}'], 0, head],
      [['rev-list', '--left-right', '--count', 'HEAD...@{u}'], 0, '0\t0'],
      [status, 0, 'MM tracked.txt'],
      [['log', '--max-count=2', '--pretty=format:%H %s'], 0, 'first fixture commit'],
      [diff, 0, '+unstaged'],
      [[...diff, '--cached'], 0, '+staged'],
      [[...diff, 'HEAD', '--', ':(literal)tracked.txt'], 0, '+unstaged'],
      [[...diff, ':(literal)tracked.txt'], 0, '+unstaged'],
      [[...diff, '--no-index', '--', 'NUL', 'untracked.txt'], 1, '+untracked payload'],
    ]
    for (const [args, exitCode, text] of cases) {
      const result = await lease.git.execute([...prefix, ...args], limits())
      expect(result, args.join(' ')).toMatchObject({ exitCode })
      expect(result.stdout).toContain(text)
      expect(await snapshot(workspace), args.join(' ')).toEqual(before)
      expect(await snapshot(tripwire), args.join(' ')).toEqual(markers)
    }
    await lease.dispose()
    expect(await snapshot(workspace)).toEqual(before)
    expect(await snapshot(tripwire)).toEqual(markers)
  })

  it('ignores Windows output redirection inherited by an authorized read', async () => {
    const { root, workspace, tripwire, mount } = await fixture()
    const decoy = join(root, 'decoy')
    await mkdir(decoy)
    execFileSync('git', ['init', '-q', decoy])
    await writeFile(join(decoy, 'DECOY_ONLY'), 'wrong workspace')
    const decoyBefore = await snapshot(decoy)
    const input = join(tripwire, 'input.txt')
    await writeFile(input, 'redirected input')
    const before = await snapshot(workspace)
    const markers = await snapshot(tripwire)
    onTestFinished(() => { vi.unstubAllEnvs() })
    const hostile = {
      GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy, GIT_COMMON_DIR: join(decoy, '.git'),
      GIT_INDEX_FILE: join(tripwire, 'index'), GIT_OBJECT_DIRECTORY: tripwire,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: tripwire,
      GIT_CONFIG_GLOBAL: input, GIT_CONFIG_SYSTEM: input,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: decoy,
      GIT_EXTERNAL_DIFF: 'invalid-helper', GIT_TRACE: join(tripwire, 'trace'),
      GIT_TRACE2_EVENT: join(tripwire, 'trace2'), GIT_EXEC_PATH: decoy,
      GIT_LITERAL_PATHSPECS: '1', GIT_GLOB_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '1',
      GIT_REDIRECT_STDIN: input, GIT_REDIRECT_STDOUT: join(tripwire, 'stdout.txt'),
      GIT_REDIRECT_STDERR: join(tripwire, 'stderr.txt'),
    }
    for (const [name, value] of Object.entries(hostile)) vi.stubEnv(name, value)
    const lease = await mount()
    const result = await lease.git.execute([...prefix, ...status], limits())
    expect(await snapshot(tripwire)).toEqual(markers)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('MM tracked.txt')
    expect(result.stdout).not.toContain('DECOY_ONLY')
    for (const args of [diff, [...diff, ':(literal)tracked.txt'], ['log', '--max-count=2', '--pretty=format:%H %s']]) {
      expect((await lease.git.execute([...prefix, ...args], limits())).exitCode).toBe(0)
      expect(await snapshot(workspace)).toEqual(before)
      expect(await snapshot(tripwire)).toEqual(markers)
      expect(await snapshot(decoy)).toEqual(decoyBefore)
    }
    await lease.dispose()
    expect(await snapshot(workspace)).toEqual(before)
  })

  it('rejects full enforcement before any native target starts', async () => {
    const { harness, mount } = await fixture()
    const spawn = vi.spyOn(harness.ctx.subprocess, 'spawn')
    const lease = await mount('require-full')
    await expect(lease.git.execute([...prefix, ...status], limits())).rejects.toThrow('full sandbox enforcement')
    expect(spawn).not.toHaveBeenCalled()
    await lease.dispose()
  })
})
