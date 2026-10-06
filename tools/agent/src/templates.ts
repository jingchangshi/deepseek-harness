/** Repository-owned scaffolds and independently identified compiler presets. */

import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative } from 'node:path'
import { load } from 'js-yaml'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { isRepositoryTemplatePath } from './config.ts'
import { validateVerificationProfileId } from './verification.ts'

/** SHA-256 identity belonging only to repository preset content. */
export type RepositoryPresetDigest = Branded<'RepositoryPresetDigest'>

/** Initial scaffold identity, distinct from the effective repository policy. */
export interface RepositoryPresetIdentity {
  schemaVersion: 1
  id: string
  version: string
  digest: RepositoryPresetDigest
}

/** Template content with explicit schema ownership. */
export interface RepositoryTemplateFile {
  path: string
  content: string
  runtimeManaged: boolean
}

/** Fully read preset admission result; loading performs no target writes. */
export interface RepositoryPreset {
  identity: RepositoryPresetIdentity
  files: RepositoryTemplateFile[]
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function regularFile(root: string, path: string): Promise<string> {
  let current = root
  for (const component of path.split('/')) {
    current = join(current, component)
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`preset symlink is forbidden: ${path}`)
  }
  if (!(await lstat(current)).isFile()) throw new Error(`preset file must be regular: ${path}`)
  return readFile(current, 'utf8')
}

/**
 * Admit all preset declarations and content before repository initialization.
 * @param root - explicit preset directory containing `preset.yaml`.
 * @param expectedId - optional selector that must match the declaration before target writes.
 * @returns scaffold files and a content-derived identity independent of core freeze.
 */
export async function loadRepositoryPreset(root: string, expectedId?: string): Promise<RepositoryPreset> {
  if (expectedId !== undefined) validateVerificationProfileId(expectedId)
  const source: unknown = load(await regularFile(root, 'preset.yaml'))
  if (typeof source !== 'object' || source === null || Array.isArray(source)) throw new Error('preset must be an object')
  const id = validateVerificationProfileId(Reflect.get(source, 'id'))
  if (expectedId !== undefined && id !== expectedId) throw new Error('preset ID does not match selected directory')
  const version = Reflect.get(source, 'version')
  const paths: unknown = Reflect.get(source, 'files')
  if (Reflect.get(source, 'schemaVersion') !== 1 || typeof version !== 'string' || version.trim().length === 0
    || !Array.isArray(paths) || paths.length === 0) throw new Error('invalid preset declaration')
  const files: RepositoryTemplateFile[] = []
  const seen = new Set<string>()
  for (const path of paths) {
    if (typeof path !== 'string' || path.includes('\\') || posix.normalize(path) !== path || path.split('/').some(component => component === '..' || component === '.')
      || !/^\.agent\/(?:config|adapters|profiles|scripts)\/[a-zA-Z0-9][a-zA-Z0-9./_-]*$/.test(path)
      || !isRepositoryTemplatePath(path.slice('.agent/'.length)) || seen.has(path.toLowerCase())) throw new Error(`invalid preset file: ${String(path)}`)
    seen.add(path.toLowerCase())
    files.push({ path, content: await regularFile(root, path), runtimeManaged: false })
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const digest = sha256(JSON.stringify({ id, version, files: files.map(file => [file.path, sha256(file.content)]) })) as RepositoryPresetDigest
  return { identity: { schemaVersion: 1, id, version, digest }, files }
}

/**
 * Read generic templates and overlay an optional explicitly selected preset.
 * @param templateRoot - source `.agent` directory.
 * @param presetRoot - optional repository preset directory.
 * @param expectedPresetId - optional selector that must match the preset declaration.
 * @returns fully read templates; only artifact schemas are runtime-managed.
 */
export async function repositoryTemplateFiles(templateRoot: string, presetRoot?: string, expectedPresetId?: string): Promise<RepositoryTemplateFile[]> {
  if (presetRoot === undefined && expectedPresetId !== undefined) throw new Error('preset selector requires a preset directory')
  const preset = presetRoot === undefined ? undefined : await loadRepositoryPreset(presetRoot, expectedPresetId)
  const files = new Map<string, RepositoryTemplateFile>()
  for (const directory of ['adapters', 'config', 'profiles', 'schemas']) {
    const sourceDirectory = join(templateRoot, directory)
    for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
      if (!isRepositoryTemplatePath(`${directory}/${entry.name}`)) continue
      if (!entry.isFile()) throw new Error(`project template contains unsupported entry: ${join(sourceDirectory, entry.name)}`)
      const path = `.agent/${directory}/${entry.name}`
      files.set(path, { path, content: await readFile(join(sourceDirectory, entry.name), 'utf8'), runtimeManaged: directory === 'schemas' })
    }
  }
  if (preset !== undefined) {
    for (const file of preset.files) files.set(file.path, file)
    files.set('.agent/preset.json', { path: '.agent/preset.json', content: JSON.stringify(preset.identity, null, 2) + '\n', runtimeManaged: false })
  }
  return [...files.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

/**
 * Validate existing destination directories and files before any initialization write.
 * @param root - target repository directory; an absent directory has no existing destinations.
 * @param files - repository-relative admitted template paths.
 */
export async function assertRepositoryTemplateDestinations(root: string, files: RepositoryTemplateFile[]): Promise<void> {
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const file of files) {
    const components = file.path.split('/')
    let current = canonicalRoot
    for (const [index, component] of components.entries()) {
      current = join(current, component)
      try {
        await lstat(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw error
      }
      const target = await realpath(current)
      const local = relative(canonicalRoot, target)
      if (isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) throw new Error(`template destination is outside the repository: ${file.path}`)
      const information = await stat(current)
      if (index === components.length - 1 ? !information.isFile() : !information.isDirectory()) throw new Error(`invalid repository template destination: ${file.path}`)
    }
  }
}

/**
 * Reject implicit replacement of an already selected repository preset.
 * @param root - target repository directory.
 * @param files - fully admitted templates including optional preset identity.
 */
export async function assertRepositoryPresetSelection(root: string, files: RepositoryTemplateFile[]): Promise<void> {
  const selected = files.find(file => file.path === '.agent/preset.json')
  if (selected === undefined) return
  let existing: string
  try {
    existing = await readFile(join(root, selected.path), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const current: unknown = JSON.parse(existing)
  const desired: RepositoryPresetIdentity = JSON.parse(selected.content)
  if (typeof current !== 'object' || current === null || Reflect.get(current, 'id') !== desired.id) throw new Error('repository preset selection differs; reconcile repository policy and preset identity explicitly')
}

/**
 * Create missing files without replacing existing repository-owned bytes.
 * @param root - target repository directory.
 * @param files - fully admitted files selected for missing-only initialization.
 */
export async function initializeMissingRepositoryFiles(root: string, files: RepositoryTemplateFile[]): Promise<void> {
  await assertRepositoryTemplateDestinations(root, files)
  await assertRepositoryPresetSelection(root, files)
  for (const file of files) {
    const destination = join(root, file.path)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    try {
      await writeFile(destination, file.content, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}
