import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRepositoryPreset } from '../src/templates.ts'
import { TaskRepository } from '../src/repository.ts'

const roots: string[] = []

async function fixture(files = ['.agent/config/project.yaml']): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'engineering-preset-'))
  roots.push(root)
  await mkdir(join(root, '.agent/config'), { recursive: true })
  await writeFile(join(root, '.agent/config/project.yaml'), 'schemaVersion: 1\nprofile: compiler\n')
  await writeFile(join(root, 'preset.yaml'), JSON.stringify({ schemaVersion: 1, id: 'another-compiler', version: '1.0.0', files }) + '\n')
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('repository preset admission', () => {
  it('admits repository-owned executable helpers and preserves them across initialization', async () => {
    const path = '.agent/scripts/verify.mjs'
    const presetRoot = await fixture([path])
    await mkdir(join(presetRoot, '.agent/scripts'), { recursive: true })
    await writeFile(join(presetRoot, path), 'process.exit(0)\n')
    const preset = await loadRepositoryPreset(presetRoot)
    expect(preset.files.map(file => file.path)).toEqual([path])
    const root = await mkdtemp(join(tmpdir(), 'engineering-preset-script-target-'))
    roots.push(root)
    const repository = new TaskRepository(root, undefined, { templateRoot: resolve('.agent'), presetRoot })
    await repository.init()
    await writeFile(join(root, path), 'process.exit(7)\n')
    await repository.init()
    expect(await readFile(join(root, path), 'utf8')).toBe('process.exit(7)\n')
  })

  it.each([
    ['../outside'], ['/absolute'], ['.agent/roles/architect.md'], ['.agent/schemas/task.schema.json'],
    ['.agent/config/models.yaml'], ['.agent/config/roles.yaml'], ['.agent/config/workflow.yaml'], ['.agent/config/data-policy.yaml'],
    ['.agent/config/project.yaml', '.agent/config/project.yaml'], [],
  ])('rejects unsupported or duplicate preset file lists %j', async (...files) => {
    const root = await fixture(files)
    await expect(loadRepositoryPreset(root)).rejects.toThrow()
  })

  it('rejects a listed file that is absent', async () => {
    const root = await fixture(['.agent/config/missing.yaml'])
    await expect(loadRepositoryPreset(root)).rejects.toThrow()
  })

  it('rejects selector and declared ID mismatch before initializing the target', async () => {
    const presetRoot = await fixture()
    const root = await mkdtemp(join(tmpdir(), 'engineering-preset-target-'))
    roots.push(root)
    await expect(new TaskRepository(root, undefined, { templateRoot: resolve('.agent'), presetRoot, presetId: 'selected-compiler' }).init()).rejects.toThrow(/preset.*ID/i)
    expect(await readdir(root)).toEqual([])
  })

  it.each(['Models.yaml', 'Roles.yaml', 'Workflow.yaml', 'Data-Policy.yaml'])('rejects deployment file spelling %s on every host', async filename => {
    const root = await fixture([`.agent/config/${filename}`])
    await writeFile(join(root, '.agent/config', filename), 'deployment: forbidden\n')
    await expect(loadRepositoryPreset(root)).rejects.toThrow(/invalid preset file/)
  })

  it('rejects case-equivalent paths on every host', async () => {
    const root = await fixture(['.agent/config/project.yaml', '.agent/config/Project.yaml'])
    await expect(loadRepositoryPreset(root)).rejects.toThrow(/invalid preset file/)
  })

  it.skipIf(process.platform === 'win32')('does not initialize through an escaping target directory symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engineering-preset-target-'))
    const outside = await mkdtemp(join(tmpdir(), 'engineering-preset-outside-'))
    roots.push(root, outside)
    await symlink(outside, join(root, '.agent'))
    await expect(new TaskRepository(root, undefined, { templateRoot: resolve('.agent') }).init()).rejects.toThrow(/outside.*repository/i)
    expect(await readdir(outside)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink in a preset path', async () => {
    const root = await fixture(['.agent/config/link.yaml'])
    await symlink(join(root, '.agent/config/project.yaml'), join(root, '.agent/config/link.yaml'))
    await expect(loadRepositoryPreset(root)).rejects.toThrow(/symlink/i)
  })

  it('changes the independent preset digest when content or version changes', async () => {
    const root = await fixture()
    const initial = await loadRepositoryPreset(root)
    await writeFile(join(root, '.agent/config/project.yaml'), 'repository policy\n')
    const modified = await loadRepositoryPreset(root)
    expect(modified.identity.digest).not.toBe(initial.identity.digest)
    await writeFile(join(root, 'preset.yaml'), JSON.stringify({ schemaVersion: 1, id: 'another-compiler', version: '2.0.0', files: ['.agent/config/project.yaml'] }) + '\n')
    expect((await loadRepositoryPreset(root)).identity.digest).not.toBe(modified.identity.digest)
  })

  it('keeps repository policy and presets out of the core freeze', async () => {
    const manifest: { files: Record<string, string> } = JSON.parse(await readFile(resolve('.agent/FREEZE.json'), 'utf8'))
    expect(Object.keys(manifest.files).filter(path => path.startsWith('.agent/adapters/') || path.startsWith('.agent/profiles/') || path === '.agent/config/project.yaml' || path.startsWith('tools/agent/presets/'))).toEqual([])
  })

  it('initializes from an arbitrary preset directory without compiler-specific code', async () => {
    const presetRoot = await fixture()
    const root = await mkdtemp(join(tmpdir(), 'engineering-preset-target-'))
    roots.push(root)
    await new TaskRepository(root, undefined, { templateRoot: resolve('.agent'), presetRoot }).init()
    expect(await readFile(join(root, '.agent/config/project.yaml'), 'utf8')).toBe('schemaVersion: 1\nprofile: compiler\n')
    expect(JSON.parse(await readFile(join(root, '.agent/preset.json'), 'utf8'))).toMatchObject({ id: 'another-compiler' })
  })
})
