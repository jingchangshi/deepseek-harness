import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { dump, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { installEngineeringProfiles } from '../src/installation.ts'
import { TaskRepository } from '../src/repository.ts'
import { automaticProvider } from './fixtures/automatic-provider.ts'

const CHECKOUT = resolve(import.meta.dirname, '../../..')
const required = ['build', 'unit', 'ir-verify', 'reference']
const roles = ['coordinator', 'scout-primary', 'scout-secondary', 'architect', 'challenger', 'implementer', 'reviewer']

async function prepare(root: string, url: string, failReference: boolean, install = true): Promise<void> {
  await new TaskRepository(root, join(root, '.agent/schemas'), { templateRoot: join(CHECKOUT, '.agent') }).init()
  const roleConfig = load(await readFile(join(CHECKOUT, '.agent/config/roles.yaml'), 'utf8')) as {
    schemaVersion: number
    roles: Record<string, { route: string; fallbackRoutes?: string[] }>
  }
  for (const [role, config] of Object.entries(roleConfig.roles)) {
    config.route = role
    if (config.fallbackRoutes !== undefined) config.fallbackRoutes = []
  }
  await writeFile(join(root, '.agent/config/roles.yaml'), dump(roleConfig))
  await writeFile(join(root, '.agent/config/models.yaml'), dump({
    schemaVersion: 1, runtimeTag: 'dsh-v0.2.1-alpha.1',
    providers: { fixture: { api: 'openai-completions', baseURL: url, apiKeyEnv: 'DSH_AUTOMATIC_FIXTURE_KEY' } },
    routes: Object.fromEntries([...roles, 'arbiter'].map(role => [role, {
      displayName: role, provider: 'fixture', model: role,
      reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'high' },
      maxDataClass: 'internal', externalRelay: false, costClass: 'standard',
    }])),
  }))
  await writeFile(join(root, '.agent/config/project.yaml'), dump({
    schemaVersion: 1, profile: 'compiler', adapter: '.agent/adapters/fixture.yaml', dataClass: 'public',
    knowledge: '.agent/config/knowledge.yaml',
    maxSteps: 20, maxRoleCalls: 8, commandTimeoutMs: 30_000,
  }))
  await mkdir(join(root, '.agents/skills/example'), { recursive: true })
  await writeFile(join(root, 'CONTRIBUTING.md'), 'PRIVATE INSTRUCTION BODY\n')
  await writeFile(join(root, '.agents/skills/example/SKILL.md'), '---\nname: example\ndescription: Use repository guidance.\n---\nPRIVATE SKILL BODY\n')
  await writeFile(join(root, '.agent/config/knowledge.yaml'), dump({ schemaVersion: 1, instructionFiles: ['CONTRIBUTING.md'], skillRoots: ['.agents/skills'] }))
  const adapters = Object.fromEntries(required.map(name => [name, {
    executable: process.execPath,
    args: ['-e', `const fs = require('node:fs'); if (fs.readFileSync('answer.txt', 'utf8') !== '42\\n') process.exit(2); fs.appendFileSync('checks.log', '${name}\\n'); ${failReference && name === 'reference' ? 'process.exit(3)' : ''}`],
  }]))
  await writeFile(join(root, '.agent/adapters/fixture.yaml'), dump({ adapters }))
  await writeFile(join(root, 'existing.txt'), 'preserve this exact content\n')
  await writeFile(join(root, '.gitignore'), '.agent/\n.dsh/\n.agents/\nchecks.log\n')
  await execa('git', ['init', '-q'], { cwd: root })
  await execa('git', ['add', 'existing.txt', '.gitignore'], { cwd: root })
  await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture baseline'], { cwd: root })
  if (install) {
    await installEngineeringProfiles({ checkout: CHECKOUT, home: join(root, '.dsh'), binDirectory: join(root, 'bin'), node: process.execPath })
    await cp(join(root, '.agent/config'), join(root, '.dsh/engineering/.agent/config'), { recursive: true })
  }
  await writeFile(join(root, 'recording.patch.yml'), dump([{ id: 'session-persistence-jsonl', config: { root: join(root, '.dsh/sessions'), compression: 'none' } }]))
}

async function launch(root: string, home = join(root, '.dsh'), launcher?: string): Promise<{ stdout: string; stderr: string }> {
  const configArgs = ['--profile', 'engineering-run', '--patch', join(root, 'recording.patch.yml'), 'Create answer.txt containing 42 and preserve existing.txt.']
  const launch = resolveExampleLaunch({
    srcBin: join(CHECKOUT, 'apps/cli/src/bin.ts'),
    configArgs,
    // This integration is distributed as a local source-checkout plugin; source resolution is its supported launch path.
    mode: 'src', sourceImport: 'tsx/esm', tsconfigPath: join(CHECKOUT, 'tsconfig.json'),
    env: { DSH_HOME: home, DSH_AGENTS_HOME: join(root, '.agents'), DSH_TELEMETRY_DISABLED: '1', DSH_AUTOMATIC_FIXTURE_KEY: 'fixture-key' },
  })
  const result = await execa(launcher ?? launch.command, launcher === undefined ? launch.args : configArgs, { cwd: root, env: launch.env, input: '', timeout: 90_000, killSignal: 'SIGKILL', reject: false })
  expect(result.timedOut, `Deadline ended DSH: ${result.stderr}`).toBe(false)
  expect(result.signal, result.stderr).toBeUndefined()
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0)
  return result
}

async function taskDirectory(root: string): Promise<string> {
  const tasks = await readdir(join(root, '.agent/tasks'))
  expect(tasks).toHaveLength(1)
  return join(root, '.agent/tasks', tasks[0]!)
}

describe('installed engineering source profile', () => {
  it('uses one installed deployment from two Session repositories without reinstalling', async () => {
    const first = await mkdtemp(join(tmpdir(), 'dsh-shared-deployment-a-'))
    const second = await mkdtemp(join(tmpdir(), 'dsh-shared-deployment-b-'))
    const provider = await automaticProvider()
    try {
      await prepare(first, provider.url, false)
      const home = join(first, '.dsh')
      const profile = join(home, 'profiles/engineering-run/cordis.patch.yml')
      const launcher = join(first, 'bin/dsh')
      const installed = await readFile(profile, 'utf8')
      await launch(first, home, launcher)
      await prepare(second, provider.url, false, false)
      for (const name of ['models.yaml', 'roles.yaml', 'workflow.yaml', 'data-policy.yaml']) {
        await rm(join(second, '.agent/config', name), { force: true })
      }
      await rm(join(second, '.agent/roles'), { recursive: true, force: true })
      await launch(second, home, launcher)
      expect(await readFile(profile, 'utf8')).toBe(installed)
      expect(installed).not.toContain(second)
      for (const root of [first, second]) {
        expect(await readFile(join(root, 'answer.txt'), 'utf8')).toBe('42\n')
        expect(JSON.parse(await readFile(join(await taskDirectory(root), 'STATE.json'), 'utf8'))).toMatchObject({ state: 'ACCEPTED' })
        expect((await readFile(join(root, 'checks.log'), 'utf8')).trim().split('\n')).toEqual(required)
      }
    } finally {
      await provider.close()
      await rm(first, { recursive: true, force: true })
      await rm(second, { recursive: true, force: true })
    }
  }, 210_000)

  it('records same-name scoped checks through an installed profile and real child agents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-scoped-profile-'))
    const provider = await automaticProvider()
    try {
      await prepare(root, provider.url, false)
      await writeFile(join(root, '.agent/profiles/compiler.yaml'), dump({
        schemaVersion: 1, id: 'compiler', checks: ['build', 'unit'].map(adapter => ({
          name: 'source-codegen', category: 'source', adapter, scope: { targetBackend: adapter }, required: true, timeoutMs: 30000,
        })),
      }))
      await launch(root)
      const task = await taskDirectory(root)
      expect(JSON.parse(await readFile(join(task, 'STATE.json'), 'utf8'))).toMatchObject({ state: 'ACCEPTED' })
      const verification = JSON.parse(await readFile(join(task, 'VERIFY.json'), 'utf8')) as { schemaVersion: number; checks: Array<{ name: string; category: string; scope: object; required: boolean; status: string; evidenceIds: string[] }> }
      expect(verification.schemaVersion).toBe(3)
      expect(verification.checks.map(({ evidenceIds, ...check }) => ({ ...check, evidenceCount: evidenceIds.length }))).toMatchInlineSnapshot(`
        [
          {
            "category": "source",
            "evidenceCount": 1,
            "name": "source-codegen",
            "required": true,
            "scope": {
              "targetBackend": "build",
            },
            "status": "PASS",
          },
          {
            "category": "source",
            "evidenceCount": 1,
            "name": "source-codegen",
            "required": true,
            "scope": {
              "targetBackend": "unit",
            },
            "status": "PASS",
          },
        ]
      `)
      expect(new Set(verification.checks.flatMap(check => check.evidenceIds)).size).toBe(2)
      const evidence = (await readFile(join(task, 'EVIDENCE.jsonl'), 'utf8')).trim().split('\n').map((line): unknown => JSON.parse(line))
      expect(evidence).toEqual(expect.arrayContaining(['build', 'unit'].map(targetBackend => expect.objectContaining({
        status: 'PASS', scope: expect.objectContaining({ name: 'source-codegen', category: 'source', verificationScope: { targetBackend } }),
        command: expect.objectContaining({ cwd: root, exitCode: 0, timedOut: false }),
      }))))
    } finally {
      await provider.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 105_000)

  it('turns one request into real child agents, a file change, four command results, review, and acceptance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-automatic-profile-'))
    const provider = await automaticProvider()
    try {
      await prepare(root, provider.url, false)
      await launch(root)
      expect(await readFile(join(root, 'answer.txt'), 'utf8')).toBe('42\n')
      expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('preserve this exact content\n')
      expect((await readFile(join(root, 'checks.log'), 'utf8')).trim().split('\n')).toEqual(required)
      const task = await taskDirectory(root)
      expect(JSON.parse(await readFile(join(task, 'STATE.json'), 'utf8'))).toMatchObject({ state: 'ACCEPTED', writer: null })
      expect(JSON.parse(await readFile(join(task, 'DECISION.json'), 'utf8'))).toMatchObject({ decision: 'ACCEPTED', verificationStatus: 'PASS', reviewDecision: 'ACCEPT' })
      const evidence = (await readFile(join(task, 'EVIDENCE.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { status: string; command?: { exitCode: number } })
      expect(evidence.filter(record => record.command !== undefined)).toHaveLength(4)
      expect(evidence.filter(record => record.command !== undefined).every(record => record.status === 'PASS' && record.command?.exitCode === 0)).toBe(true)
      expect(new Set(provider.requests.map(request => request.model))).toEqual(new Set(roles))
      for (const request of provider.requests) {
        const tools = request.tools?.map(tool => tool.function.name) ?? []
        if (request.model === 'coordinator') expect(tools).toEqual(expect.arrayContaining(['engineering_run', 'engineering_status']))
        if (request.model !== 'implementer') expect(tools).not.toEqual(expect.arrayContaining(['write']))
        if (request.model !== 'coordinator') expect(tools).not.toContain('engineering_run')
        if (request.model !== 'coordinator') expect(tools).toContain('structured_output')
        if (request.model === 'reviewer') expect(request.messages.flatMap(message => message.tool_calls ?? []).some(call => call.function.name === 'write')).toBe(false)
      }
      const sessionRoot = join(root, '.dsh/sessions')
      const files = (await readdir(sessionRoot, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      expect(files).toHaveLength(7)
      const logs = await Promise.all(files.map(file => readFile(join(sessionRoot, file), 'utf8')))
      expect(logs.filter(log => log.includes('"subagent/descriptor"'))).toHaveLength(6)
      expect(logs.filter(log => log.includes('repositoryKnowledge'))).toHaveLength(6)
      expect(logs.join('\n')).not.toContain('PRIVATE SKILL BODY')
      expect(logs.join('\n')).not.toContain('PRIVATE INSTRUCTION BODY')
      const roleRequest = provider.requests.find(request => request.model === 'scout-primary')
      const input = roleRequest?.messages.find(message => message.role === 'user' && message.content?.includes('repositoryKnowledge'))?.content
      if (input === undefined || input === null) throw new Error('recorded Scout input missing repository knowledge')
      expect(logs.some(log => log.includes(JSON.stringify(input).slice(1, -1)))).toBe(true)
      expect(JSON.parse(input).context.repositoryKnowledge).toMatchInlineSnapshot(`
        {
          "instructionFiles": [
            "CONTRIBUTING.md",
          ],
          "skills": [
            {
              "description": "Use repository guidance.",
              "name": "example",
              "path": ".agents/skills/example/SKILL.md",
            },
          ],
        }
      `)
    } finally {
      await provider.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 105_000)

  it('does not accept a failing required command even when every model reports success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-automatic-failure-'))
    const provider = await automaticProvider()
    try {
      await prepare(root, provider.url, true)
      await launch(root)
      const task = await taskDirectory(root)
      expect(JSON.parse(await readFile(join(task, 'STATE.json'), 'utf8'))).not.toMatchObject({ state: 'ACCEPTED' })
      await expect(readFile(join(task, 'DECISION.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(JSON.parse(await readFile(join(task, 'VERIFY.json'), 'utf8'))).toMatchObject({ status: 'FAIL', checks: expect.arrayContaining([expect.objectContaining({ name: 'reference', category: expect.any(String), scope: {}, required: true, status: 'FAIL', evidenceIds: expect.any(Array) })]) })
      expect(provider.requests.some(request => request.model === 'reviewer')).toBe(false)
      expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('preserve this exact content\n')
    } finally {
      await provider.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 105_000)
})
