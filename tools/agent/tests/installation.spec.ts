import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { dump } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { installEngineeringProfiles, installEngineeringProject, installationFiles, preflightEngineeringInstallation } from '../src/installation.ts'
import { TaskRepository } from '../src/repository.ts'
import { ArtifactValidationError } from '../src/schemas.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-engineering-install-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

describe('engineering profile installation', () => {
  it.skipIf(process.platform === 'win32')('rejects escaping target schema directories before writing policies or installation markers', async () => {
    const root = await temporaryRoot()
    const project = join(root, 'project')
    const outside = join(root, 'outside')
    await mkdir(join(project, '.agent'), { recursive: true })
    await mkdir(outside)
    await symlink(outside, join(project, '.agent/schemas'))
    const options = { checkout: resolve('.'), project, home: join(root, 'home'), binDirectory: join(root, 'bin'), node: process.execPath, preset: 'ascendnpu-ir' }
    await expect(preflightEngineeringInstallation(options)).rejects.toThrow(/outside.*repository/i)
    await expect(installEngineeringProject(options)).rejects.toThrow(/outside.*repository/i)
    expect(await readdir(outside)).toEqual([])
    await expect(readFile(join(project, '.agent/config/project.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(project, '.agent/dsh-template-installation.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('preserves repository policies after both current and legacy managed installations', async () => {
    const root = await temporaryRoot()
    const project = join(root, 'project')
    await mkdir(project)
    const options = { checkout: resolve('.'), project, home: join(root, 'home'), binDirectory: join(root, 'bin'), node: process.execPath }
    await installEngineeringProject(options)
    const files = ['config/project.yaml', 'profiles/compiler.yaml']
    const marker = join(project, '.agent/dsh-template-installation.json')
    const record: Record<string, string> = JSON.parse(await readFile(marker, 'utf8'))
    for (const filename of files) {
      record[`.agent/${filename}`] = createHash('sha256').update(await readFile(join(project, '.agent', filename))).digest('hex')
      await writeFile(join(project, '.agent', filename), 'repository-owned: edited\n')
    }
    await writeFile(marker, JSON.stringify(record) + '\n')
    await expect(preflightEngineeringInstallation(options)).resolves.toBeUndefined()
    await installEngineeringProject(options)
    for (const filename of files) expect(await readFile(join(project, '.agent', filename), 'utf8')).toBe('repository-owned: edited\n')
    const upgraded: Record<string, string> = JSON.parse(await readFile(marker, 'utf8'))
    for (const filename of files) expect(upgraded).not.toHaveProperty(`.agent/${filename}`)
  })

  it('selects the Ascend repository scaffold explicitly and preserves its command and hardware declarations', async () => {
    const root = await temporaryRoot()
    const project = join(root, 'project')
    await mkdir(project)
    const options = { checkout: resolve('.'), project, home: join(root, 'home'), binDirectory: join(root, 'bin'), node: process.execPath, preset: 'ascendnpu-ir' }
    await installEngineeringProject(options)
    expect(await readFile(join(project, '.agent/config/project.yaml'), 'utf8')).toContain('adapter: .agent/config/commands.yaml')
    const adapter = await readFile(join(project, '.agent/config/commands.yaml'), 'utf8')
    expect(adapter).toBe(await readFile(resolve('tools/agent/presets/ascendnpu-ir/.agent/config/commands.yaml'), 'utf8'))
    const script = await readFile(join(project, '.agent/scripts/ascend.sh'), 'utf8')
    for (const token of ['bishengir-opt', 'bishengir-compile', 'check-bishengir']) expect(script).toContain(token)
    expect(await readFile(join(project, '.agent/scripts/ascend-lit.py'), 'utf8')).toContain('lit')
    for (const token of ['kind: docker', 's00653124_build', 'A5: NOT_RUN', 'A3: NOT_RUN', 'PureAIV: NOT_RUN', 'MixCV: NOT_RUN']) expect(adapter).toContain(token)
    const identityPath = join(project, '.agent/preset.json')
    const identity = await readFile(identityPath, 'utf8')
    expect(JSON.parse(identity)).toMatchObject({ schemaVersion: 1, id: 'ascendnpu-ir', version: '2.0.0', digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    await writeFile(join(project, '.agent/config/commands.yaml'), 'repository-owned: local-container\n')
    await installEngineeringProject(options)
    expect(await readFile(join(project, '.agent/config/commands.yaml'), 'utf8')).toBe('repository-owned: local-container\n')
    expect(await readFile(identityPath, 'utf8')).toBe(identity)
  })

  it('rejects a missing preset before installing any repository files', async () => {
    const root = await temporaryRoot()
    const project = join(root, 'project')
    await mkdir(project)
    await expect(installEngineeringProject({ checkout: resolve('.'), project, home: join(root, 'home'), binDirectory: join(root, 'bin'), node: process.execPath, preset: 'missing-compiler' }))
      .rejects.toThrow()
    await expect(readFile(join(project, '.agent/config/project.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('initializes a TileLang-owned profile and knowledge declarations without any AscendNPU-IR adapter', async () => {
    const root = await temporaryRoot()
    const project = join(root, 'project')
    await mkdir(project)
    await installEngineeringProject({ checkout: resolve('.'), project, home: join(root, 'home'), binDirectory: join(root, 'bin'), node: process.execPath, preset: 'tilelang' })
    expect(await readFile(join(project, '.agent/config/project.yaml'), 'utf8')).toContain('profile: tilelang')
    expect(await readFile(join(project, '.agent/config/knowledge.yaml'), 'utf8')).toContain('.agents/skills')
    const adapter = await readFile(join(project, '.agent/config/commands.yaml'), 'utf8')
    const script = await readFile(join(project, '.agent/scripts/tilelang-check.py'), 'utf8')
    expect(script).toContain('testing/python/backend/test_tilelang_backend_module.py')
    expect(script).toContain('testing/python/transform/test_tilelang_transform_verify_parallel_loop.py')
    expect(adapter).toContain('kind: docker')
    expect(adapter).not.toContain('bishengir')
    expect(await readdir(join(project, '.agent/adapters'))).not.toContain('ascend-npu-ir.yaml')
    expect(JSON.parse(await readFile(join(project, '.agent/preset.json'), 'utf8'))).toMatchObject({ id: 'tilelang' })
  })
  it('upgrades an owned legacy profile enum without rewriting existing task metadata', async () => {
    const root = await temporaryRoot()
    const project = join(root, 'project')
    await mkdir(project)
    const options = { checkout: resolve('.'), project, home: join(root, 'dsh'), binDirectory: join(root, 'bin'), node: process.execPath }
    await installEngineeringProject(options)
    const schemaPath = join(project, '.agent/schemas/task.schema.json')
    const schema: { properties: Record<string, object> } = JSON.parse(await readFile(schemaPath, 'utf8'))
    const legacy = JSON.stringify({ ...schema, properties: { ...schema.properties, profile: { enum: ['compiler', 'webapp', 'small-feature'] } } }, null, 2) + '\n'
    await writeFile(schemaPath, legacy)
    const marker = join(project, '.agent/dsh-template-installation.json')
    const record: Record<string, string> = JSON.parse(await readFile(marker, 'utf8'))
    record['.agent/schemas/task.schema.json'] = createHash('sha256').update(legacy).digest('hex')
    await writeFile(marker, JSON.stringify(record) + '\n')
    const oldStore = new TaskRepository(project)
    const task = { schemaVersion: 1 as const, id: 'legacy-task', title: 'Existing task', profile: 'compiler', dataClass: 'public' as const, createdAt: '2026-10-04T00:00:00.000Z' }
    await oldStore.createTask(task)
    const metadataPath = join(project, '.agent/tasks/legacy-task/TASK.yaml')
    const metadata = await readFile(metadataPath, 'utf8')
    await writeFile(join(project, '.agent/profiles/synthetic-compiler.yaml'), JSON.stringify({
      schemaVersion: 1, id: 'synthetic-compiler', checks: [{ name: 'parse', category: 'source', required: true, timeoutMs: 1000 }],
    }) + '\n')
    await expect(oldStore.createTask({ ...task, id: 'synthetic-task', profile: 'synthetic-compiler' })).rejects.toBeInstanceOf(ArtifactValidationError)
    await installEngineeringProject(options)
    await expect(new TaskRepository(project).createTask({ ...task, id: 'synthetic-task', profile: 'synthetic-compiler' }))
      .resolves.toMatchObject({ state: 'NEW' })
    expect(await readFile(metadataPath, 'utf8')).toBe(metadata)
  })

  it('keeps deployment routing and personas out of newly initialized repositories', async () => {
    const root = await temporaryRoot()
    const project = join(root, 'project')
    await mkdir(project)
    await installEngineeringProject({ checkout: resolve('.'), project, home: join(root, 'dsh'), binDirectory: join(root, 'bin'), node: process.execPath })
    for (const filename of ['models.yaml', 'roles.yaml', 'workflow.yaml', 'data-policy.yaml']) {
      await expect(readFile(join(project, '.agent/config', filename), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await expect(readFile(join(project, '.agent/roles/coordinator.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('initializes a user deployment without a repository and preserves its editable routing', async () => {
    const root = await temporaryRoot()
    const options = { checkout: resolve('.'), home: join(root, 'dsh'), binDirectory: join(root, 'bin'), node: process.execPath }
    await installEngineeringProfiles(options)
    const models = join(options.home, 'engineering/.agent/config/models.yaml')
    expect(await readFile(models, 'utf8')).toContain('apiKeyEnv:')
    await writeFile(models, 'user-owned deployment\n')
    await installEngineeringProfiles(options)
    expect(await readFile(models, 'utf8')).toBe('user-owned deployment\n')
  })

  it('installs the complete project template while preserving task state', async () => {
    const root = await temporaryRoot()
    const project = join(root, 'project')
    await mkdir(join(project, '.agent/tasks/existing'), { recursive: true })
    await writeFile(join(project, '.agent/tasks/existing/STATE.json'), '{"preserve":true}\n')
    const options = { checkout: resolve('.'), project, home: join(root, 'dsh'), binDirectory: join(root, 'bin'), node: process.execPath }
    const installed = await installEngineeringProject(options)
    expect(installed).toContain(join(project, '.agent/config/project.yaml'))
    await expect(readFile(join(project, '.agent/config/models.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(project, '.agent/tasks/existing/STATE.json'), 'utf8')).resolves.toBe('{"preserve":true}\n')
    await expect(installEngineeringProject(options)).resolves.toEqual(installed)
  })

  it('refuses to overwrite an edited artifact schema', async () => {
    const root = await temporaryRoot()
    const project = join(root, 'project')
    await mkdir(project)
    const options = { checkout: resolve('.'), project, home: join(root, 'dsh'), binDirectory: join(root, 'bin'), node: process.execPath }
    await installEngineeringProject(options)
    const configuration = join(project, '.agent/schemas/task.schema.json')
    await writeFile(configuration, 'user-owned: true\n')
    await expect(installEngineeringProject(options)).rejects.toThrow(/refuses to replace/)
    await expect(readFile(configuration, 'utf8')).resolves.toBe('user-owned: true\n')
  })

  it('writes stable Web and headless profiles plus a cwd-preserving launcher', async () => {
    const root = await temporaryRoot()
    const options = {
      checkout: resolve('.'), project: join(root, 'project'), home: join(root, 'dsh'),
      binDirectory: join(root, 'bin'), node: process.execPath,
    }
    await mkdir(options.project)
    const installed = await installEngineeringProfiles(options)
    expect(installed).toHaveLength(5)
    const web = JSON.parse(await readFile(join(options.home, 'profiles/engineering/cordis.patch.yml'), 'utf8')) as object[]
    expect(web).toContainEqual({ id: 'llm-pi-ai', disabled: true })
    expect(web).toContainEqual({ id: 'agent-default-model', disabled: true })
    expect(JSON.stringify(web)).not.toContain(resolve(options.project))
    expect(JSON.stringify(web)).toContain(resolve(options.home, 'engineering'))
    const launcher = await readFile(join(options.binDirectory, 'dsh'), 'utf8')
    expect(launcher).toContain('if [ "$#" -eq 0 ]; then set -- engineering; fi')
    expect(launcher).toContain('tools/agent/launch.mjs')
    expect(launcher).toContain(`export DSH_HOME='${options.home}'`)
    expect(launcher).not.toContain('apps/cli/src/bin.ts')
    expect(launcher).not.toContain('cd ')
    await expect(installEngineeringProfiles(options)).resolves.toEqual(installed)
  })

  it('installs a profile preset with the delegation group removed', () => {
    const files = installationFiles({
      checkout: resolve('.'), home: '/dsh', binDirectory: '/bin', node: process.execPath,
    })
    const patch = files.find(file => file.path.endsWith('engineering/cordis.patch.yml'))
    if (patch === undefined) throw new Error('profile fixture missing')
    const rows = JSON.parse(patch.content) as Array<Record<string, unknown>>
    const preset = rows.find(row => row.id === 'preset-standard')
    expect(preset).toBeDefined()
    const plugins = (preset!.config as { plugins: Array<{ id?: string; group?: boolean; disabled?: unknown }> }).plugins
    expect(plugins.some(plugin => plugin.id === 'delegation')).toBe(false)
    // The preset's own platform conditions are resolved, not dropped: the
    // profile patch is JSON, where an expression node would read as a literal.
    expect(plugins.find(plugin => plugin.id === 'tool-bash')?.disabled).toBe(false)
    expect(plugins.find(plugin => plugin.id === 'tool-pwsh')?.disabled).toBe(true)
    expect(patch.content).not.toContain('__jsExpr')
    // The coordinator also keeps the goal tools the workflow lists.
    expect(plugins.some(plugin => plugin.id === 'tool-goal')).toBe(true)
  })

  it('omits shipped preset rows from the headless profile that has no preset registry', () => {
    const files = installationFiles({
      checkout: resolve('.'), home: '/dsh', binDirectory: '/bin', node: process.execPath,
    })
    const patch = files.find(file => file.path.endsWith('engineering-run/cordis.patch.yml'))
    if (patch === undefined) throw new Error('profile fixture missing')
    const rows = JSON.parse(patch.content) as Array<Record<string, unknown>>
    // The headless bundle mounts no preset registry, so a restated preset row
    // would patch an entry the composition never defines.
    expect(rows.some(row => typeof row.id === 'string' && row.id.startsWith('preset-'))).toBe(false)
    expect(rows).toContainEqual({ id: 'tool-subagent', disabled: true })
    expect(rows).toContainEqual({ id: 'tool-subagent-fork', disabled: true })
  })

  it('drops an installer-written preset row that a later installation no longer declares', async () => {
    const root = await temporaryRoot()
    const options = {
      checkout: resolve('.'), project: join(root, 'project'), home: join(root, 'dsh'),
      binDirectory: join(root, 'bin'), node: process.execPath,
    }
    await mkdir(options.project)
    await installEngineeringProfiles(options)
    // An earlier installation restated the Web preset here; the headless
    // composition has no such row, so reinstalling must remove it instead of
    // leaving a patch entry the loader warns about and never applies.
    const profile = join(options.home, 'profiles/engineering-run/cordis.patch.yml')
    const rows = JSON.parse(await readFile(profile, 'utf8')) as Array<Record<string, unknown>>
    rows.splice(rows.findIndex(row => row.id === 'hmr') + 1, 0, { id: 'preset-standard', config: { id: 'standard' } })
    const stale = JSON.stringify(rows, null, 2) + '\n'
    await writeFile(profile, stale)
    // The previous installation wrote that content, so its recorded digest
    // admits the refresh and leaves the stale row for the installer to remove.
    const marker = join(options.home, 'engineering-installation.json')
    const record = JSON.parse(await readFile(marker, 'utf8')) as Record<string, string>
    record[profile] = createHash('sha256').update(stale).digest('hex')
    await writeFile(marker, JSON.stringify(record, null, 2) + '\n')
    await expect(installEngineeringProfiles(options)).resolves.toHaveLength(5)
    const updated = JSON.parse(await readFile(profile, 'utf8')) as Array<Record<string, unknown>>
    expect(updated.some(row => row.id === 'preset-standard')).toBe(false)
  })

  it('refuses to replace a user edit after installation', async () => {
    const root = await temporaryRoot()
    const options = {
      checkout: resolve('.'), project: join(root, 'project'), home: join(root, 'dsh'),
      binDirectory: join(root, 'bin'), node: process.execPath,
    }
    await mkdir(options.project)
    await installEngineeringProfiles(options)
    const profile = join(options.home, 'profiles/engineering/cordis.patch.yml')
    await writeFile(profile, 'user-owned: true\n')
    await expect(installEngineeringProfiles(options)).rejects.toThrow(/refuses to replace/)
    await expect(readFile(profile, 'utf8')).resolves.toBe('user-owned: true\n')
  })

  it('renders no credential values into installation files', () => {
    const files = installationFiles({
      checkout: resolve('.'), home: '/dsh', binDirectory: '/bin', node: process.execPath,
    })
    const rendered = files.map(file => file.content).join('\n')
    expect(rendered).not.toMatch(/apiKey|SECRET|TOKEN|PASSWORD/)
  })

  it('resumes a partially written upgrade using its pending hashes and retains user-edit protection', async () => {
    const root = await temporaryRoot()
    const options = { checkout: resolve('.'), project: join(root, 'project'), home: join(root, 'dsh'), binDirectory: join(root, 'bin'), node: process.execPath }
    await mkdir(options.project)
    await installEngineeringProfiles(options)
    const marker = join(options.home, 'engineering-installation.json')
    const committed: Record<string, string> = JSON.parse(await readFile(marker, 'utf8'))
    const intermediate = installationFiles({ ...options, node: '/intermediate/node' })
    const pending = Object.fromEntries(intermediate.map(file => [file.path, createHash('sha256').update(file.content).digest('hex')]))
    await writeFile(marker, JSON.stringify({ schemaVersion: 1, committed, pending }))
    const changed = intermediate.find(file => file.path === join(options.binDirectory, 'dsh'))
    if (changed === undefined) throw new Error('launcher fixture missing')
    await writeFile(changed.path, changed.content)

    const newest = { ...options, node: '/newest/node' }
    await expect(preflightEngineeringInstallation(newest)).resolves.toBeUndefined()
    await installEngineeringProfiles(newest)
    expect(await readFile(changed.path, 'utf8')).toContain("exec '/newest/node'")
    expect(JSON.parse(await readFile(marker, 'utf8'))).not.toHaveProperty('pending')
    await writeFile(changed.path, '# user-owned launcher\n')
    await expect(installEngineeringProfiles(newest)).rejects.toThrow('user-owned or edited')
    expect(await readFile(changed.path, 'utf8')).toBe('# user-owned launcher\n')
  })

  it('preflights project and user destinations without writing project files on a user-profile conflict', async () => {
    const root = await temporaryRoot()
    const options = { checkout: resolve('.'), project: join(root, 'project'), home: join(root, 'dsh'), binDirectory: join(root, 'bin'), node: process.execPath }
    await mkdir(options.project)
    await installEngineeringProfiles(options)
    const profile = join(options.home, 'profiles/engineering/cordis.patch.yml')
    await writeFile(profile, 'user-owned: true\n')
    await expect(preflightEngineeringInstallation(options)).rejects.toThrow('user-owned or edited')
    await expect(readFile(join(options.project, '.agent/config/models.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(options.project, '.agent/dsh-template-installation.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(profile, 'utf8')).toBe('user-owned: true\n')
  })

  it('preserves UI-owned YAML entries across a managed profile upgrade', async () => {
    const root = await temporaryRoot()
    const options = { checkout: resolve('.'), project: join(root, 'project'), home: join(root, 'dsh'), binDirectory: join(root, 'bin'), node: process.execPath }
    await mkdir(options.project)
    await installEngineeringProfiles(options)
    const profile = join(options.home, 'profiles/engineering/cordis.patch.yml')
    const entries: object[] = JSON.parse(await readFile(profile, 'utf8'))
    const uiEntry = { id: 'ui-settings-general', config: { locale: 'zh-CN', theme: 'dark' } }
    entries.push(uiEntry)
    await writeFile(profile, dump(entries))
    const upgraded = { ...options, project: join(root, 'another-project') }
    await installEngineeringProfiles(upgraded)
    const updated = JSON.parse(await readFile(profile, 'utf8'))
    expect(updated).toContainEqual(uiEntry)
    expect(JSON.stringify(updated)).not.toContain(upgraded.project)
    expect(JSON.stringify(updated)).toContain(join(options.home, 'engineering'))
    await expect(installEngineeringProfiles(upgraded)).resolves.toHaveLength(5)
  })

  it('adopts an unmarked profile only when every managed entry matches and rejects later managed edits', async () => {
    const root = await temporaryRoot()
    const options = { checkout: resolve('.'), project: join(root, 'project'), home: join(root, 'dsh'), binDirectory: join(root, 'bin'), node: process.execPath }
    await mkdir(options.project)
    const profile = installationFiles(options).find(file => file.path.endsWith('engineering/cordis.patch.yml'))
    if (profile === undefined) throw new Error('profile fixture missing')
    await mkdir(join(options.home, 'profiles/engineering'), { recursive: true })
    const entries: Array<Record<string, unknown>> = JSON.parse(profile.content)
    const uiEntry = { id: 'ui-settings-general', config: { locale: 'zh-CN' } }
    entries.push(uiEntry)
    await writeFile(profile.path, dump(entries))
    await installEngineeringProfiles(options)
    expect(JSON.parse(await readFile(profile.path, 'utf8'))).toContainEqual(uiEntry)
    const managed = entries.find(entry => entry.id === 'hmr')
    if (managed === undefined) throw new Error('managed entry fixture missing')
    managed.disabled = false
    await writeFile(profile.path, dump(entries))
    await expect(installEngineeringProfiles(options)).rejects.toThrow('user-owned or edited')
    expect(await readFile(profile.path, 'utf8')).toBe(dump(entries))
    await rm(join(options.home, 'engineering-installation.json'))
    await expect(installEngineeringProfiles(options)).rejects.toThrow('user-owned or edited')
  })
})
