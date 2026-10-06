/** Private Git, workflow metadata, and distinct fake primary/fallback routes for Session replay. */
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { execa } from 'execa'
import { dump } from 'js-yaml'

const checkout = fileURLToPath(new URL('../../../', import.meta.url))

/** Create the target project and actual command adapters in a private snapshot cwd. */
export async function prepareEngineeringWorkspace(cwd) {
  // The deployment is user-owned state outside the Session repository, so the
  // fixture writes it to `.dsh/deployment` and points the runtime at it. The
  // repository keeps only its own `.agent/config` project declarations, which
  // is what lets the deployment guard reject a write into `.agent`.
  const deployment = join(cwd, '.dsh', 'deployment')
  await mkdir(join(deployment, '.agent'), { recursive: true })
  await cp(join(checkout, '.agent/config'), join(deployment, '.agent/config'), { recursive: true })
  await cp(join(checkout, '.agent/roles'), join(deployment, '.agent/roles'), { recursive: true })
  for (const directory of ['config', 'schemas', 'profiles']) {
    await cp(join(checkout, '.agent', directory), join(cwd, '.agent', directory), { recursive: true })
  }
  await mkdir(join(cwd, '.agent/adapters'), { recursive: true })
  const roles = ['coordinator', 'scout-primary', 'scout-secondary', 'architect', 'challenger', 'implementer', 'reviewer', 'arbiter']
  const { load } = await import('js-yaml')
  const { readFile } = await import('node:fs/promises')
  const roleConfig = load(await readFile(join(deployment, '.agent/config/roles.yaml'), 'utf8'))
  for (const [role, config] of Object.entries(roleConfig.roles)) {
    config.route = role
    if (config.fallbackRoutes !== undefined) config.fallbackRoutes = ['worker-fallback']
  }
  await writeFile(join(deployment, '.agent/config/roles.yaml'), dump(roleConfig))
  await writeFile(join(deployment, '.agent/config/models.yaml'), dump({
    schemaVersion: 1, runtimeTag: 'dsh-v0.2.1-alpha.1',
    providers: { fixture: { api: 'openai-completions', baseURL: 'http://fixture.invalid/v1', apiKeyEnv: 'DSH_FIXTURE_KEY' } },
    routes: Object.fromEntries([...roles, 'worker-fallback'].map(role => [role, {
      displayName: role, provider: 'fixture', model: role, reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'high' },
      maxDataClass: 'internal', externalRelay: false, costClass: 'standard',
    }])),
  }))
  await writeFile(join(cwd, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'compiler', adapter: '.agent/adapters/fixture.yaml', dataClass: 'public', maxSteps: 20, maxRoleCalls: 8, commandTimeoutMs: 30000 }))
  await writeFile(join(cwd, '.agent/adapters/fixture.yaml'), dump({ adapters: Object.fromEntries(['build', 'unit', 'ir-verify', 'reference'].map(name => [name, {
    executable: 'node', args: ['-e', `const fs=require('node:fs');if(fs.readFileSync('answer.txt','utf8')!=='42\\n')process.exit(2);fs.appendFileSync('checks.log','${name}\\n')`],
  }])) }))
  await writeFile(join(cwd, 'existing.txt'), 'preserve this exact content\n')
  await execa('git', ['init', '-q'], { cwd })
  await writeFile(join(cwd, '.git/info/exclude'), '.agent/\n.dsh/\n.agents/\n.snapshot-patches/\n')
  await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture baseline'], {
    cwd, env: { GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' },
  })
}
