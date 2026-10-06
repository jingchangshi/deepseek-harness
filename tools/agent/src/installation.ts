/** Local profile installation for the frozen source-checkout engineering harness. */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { cp, readFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { assertRepositoryPresetSelection, assertRepositoryTemplateDestinations, initializeMissingRepositoryFiles, repositoryTemplateFiles } from './templates.ts'
import { validateVerificationProfileId } from './verification.ts'
import { classifyPresetRows, suppressPresetRows, type PresetRowPlan } from './preset-rows.ts'

/**
 * Locate the Web bundle's shipped preset patch inside this checkout.
 *
 * The launcher already runs this checkout's `apps/cli`, so the same anchor
 * resolves the bundle the engineering profile composes. The source path is
 * the fallback for a checkout whose CLI dependencies are not installed yet.
 * @param checkout - the harness source checkout root.
 * @returns absolute path of the shipped `standard` preset patch.
 * @throws when neither the resolved bundle nor the source path exists.
 */
function shippedPresetPatch(checkout: string): string {
  const fallback = join(checkout, 'packages/bundle/web-app/presets/standard.patch.yml')
  let resolved: string
  try {
    resolved = createRequire(join(checkout, 'apps/cli/package.json')).resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml')
  } catch {
    if (existsSync(fallback)) return fallback
    throw new Error(`cannot locate the Web bundle preset patch from ${checkout}; run pnpm install in the checkout`)
  }
  return resolved
}

/** One row of the shipped Web preset that the engineering profile restates. */
interface ManagedPresetRow {
  id: string
  name: string
  config: Record<string, unknown>
}

/**
 * Read one shipped `@deepseek-ai/dsh-agent-preset` row from a bundle patch.
 * @param row - a parsed patch row; a non-insert row or another plugin is ignored.
 * @returns the preset identity, module, and declared config, or undefined.
 */
function presetDeclaration(row: Record<string, unknown>): ManagedPresetRow | undefined {
  const inserts = row['insert']
  if (!Array.isArray(inserts)) return undefined
  for (const candidate of inserts) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue
    const entry = candidate as Record<string, unknown>
    const config = entry['config']
    if (entry['name'] !== '@deepseek-ai/dsh-agent-preset' || typeof config !== 'object' || config === null || Array.isArray(config)) continue
    const declared = config as Record<string, unknown>
    if (typeof entry['id'] !== 'string' || typeof declared['id'] !== 'string') continue
    return { id: entry['id'], name: entry['name'], config: declared }
  }
  return undefined
}

/**
 * Resolve one `!!js` condition a shipped preset row may carry.
 *
 * The engineering profile installs only on POSIX, so the shipped preset's two
 * platform conditions have fixed values. An expression outside that set is
 * refused rather than evaluated: the profile patch is JSON, where a
 * round-tripped expression node would read as a plain object and silently
 * disable the row.
 * @param expression - the declared JavaScript expression text.
 * @returns the boolean the expression evaluates to on this profile.
 */
function presetCondition(expression: string): boolean {
  const trimmed = expression.trim()
  if (trimmed === "process.platform === 'win32'") return false
  if (trimmed === "process.platform !== 'win32'") return true
  throw new Error(`the shipped engineering preset uses an unsupported !!js condition ${JSON.stringify(expression)}; restate it as a literal`)
}

/**
 * Replace every `!!js` node in one preset value with its resolved boolean.
 * @param value - a parsed preset config or a value inside one.
 * @returns the same value with expression nodes resolved.
 */
function resolvePresetExpressions(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) return value.map(item => resolvePresetExpressions(item))
  const record = value as Record<string, unknown>
  const expression = record['__jsExpr']
  if (typeof expression === 'string' && Object.keys(record).length === 1) return presetCondition(expression)
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, resolvePresetExpressions(item)]))
}

/**
 * Build the profile patch row that restates one shipped preset without its
 * delegation group.
 *
 * A coordinator-only profile must not compose the standing `tool-subagent`
 * row: it installs itself into each Agent's own tool scope, where no scoped
 * restriction can mask it, so `engineering_run` alone cannot keep a
 * coordinator from delegating around the workflow. The row is id-keyed, so the
 * composed tree replaces the bundle's `standard` row with this config and the
 * profile layer need not restate the sibling declarations of the bundle layer.
 * @param declaration - parsed shipped preset row.
 * @returns `{ id, config }` with the delegation group and its children absent.
 */
export function engineeringPresetRow(declaration: ManagedPresetRow): Record<string, unknown> {
  const plugins = declaration.config['plugins']
  if (!Array.isArray(plugins)) {
    throw new Error(`shipped preset ${declaration.id} declares no plugins array to patch`)
  }
  const plan: PresetRowPlan[] = classifyPresetRows(plugins)
  const kept = suppressPresetRows(plugins, plan).map(row => resolvePresetExpressions(row))
  return { id: declaration.id, config: { ...declaration.config, plugins: kept } }
}

/**
 * Read every shipped preset declaration out of one bundle patch file.
 *
 * The engineering profiles are built on the Web bundle, whose shipped
 * `standard` preset carries the standing delegation row; this returns the
 * declarations to restate without it.
 * @param content - the patch file's text in the entry-list YAML dialect.
 * @param path - source path, for the parse diagnostic.
 * @returns one patch row per shipped preset declaration.
 */
export function shippedPresetRows(content: string, path: string): Record<string, unknown>[] {
  let parsed: unknown
  try {
    parsed = load(content, { schema: entryListSchema })
  } catch (error) {
    throw new Error(`cannot read the shipped bundle patch ${path}: ${String(error)}`)
  }
  if (!Array.isArray(parsed)) throw new Error(`shipped bundle patch ${path} is not an entry list`)
  const rows: Record<string, unknown>[] = []
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const inserts = (row as Record<string, unknown>)['insert']
    if (!Array.isArray(inserts)) continue
    for (const candidate of inserts) {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue
      const declaration = presetDeclaration({ insert: [candidate] })
      if (declaration !== undefined) rows.push(engineeringPresetRow(declaration))
    }
  }
  return rows
}

/** Explicit destinations for a checkout-owned installation. */
export interface InstallationOptions {
  checkout: string
  project: string
  home: string
  binDirectory: string
  node: string
  preset?: string
}

/** Runtime and user deployment destinations; no target repository is required. */
export type RuntimeInstallationOptions = Omit<InstallationOptions, 'project' | 'preset'>

interface InstallationFile {
  path: string
  content: string
  mode: number
  managedPatch?: boolean
  runtimeManaged?: boolean
}

interface InstallationRecord {
  committed: Record<string, string>
  pending: Record<string, string>
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function patchEntries(source: string, path: string): Record<string, unknown>[] {
  const entries: unknown = load(source)
  if (!Array.isArray(entries) || !entries.every(entry => typeof entry === 'object' && entry !== null && !Array.isArray(entry))) throw new Error(`installation refuses to replace a user-owned or edited file: ${path}`)
  return entries.map(entry => Object.fromEntries(Object.entries(entry)))
}

function managedEntries(entries: Record<string, unknown>[], desired: Record<string, unknown>[], path: string): Record<string, unknown>[] {
  return desired.map((item) => {
    const matches = item.id === undefined
      ? entries.filter(entry => Array.isArray(entry.insert) && entry.insert.some(plugin => typeof plugin === 'object' && plugin !== null && Reflect.get(plugin, 'id') === 'engineering-bootstrap'))
      : entries.filter(entry => entry.id === item.id)
    const match = matches[0]
    if (matches.length !== 1 || match === undefined) throw new Error(`installation refuses to replace a user-owned or edited file: ${path}`)
    if (item.id !== undefined) return match
    const insert = (match.insert as unknown[]).filter(plugin => typeof plugin === 'object' && plugin !== null && Reflect.get(plugin, 'id') === 'engineering-bootstrap')
    if (insert.length !== 1) throw new Error(`installation refuses to replace a user-owned or edited file: ${path}`)
    return { ...match, insert }
  })
}

function mergeManagedPatch(file: InstallationFile, existing: string, previous: InstallationRecord, key: string): InstallationFile {
  const desired = patchEntries(file.content, file.path)
  const entries = patchEntries(existing, file.path)
  const managed = managedEntries(entries, desired, file.path)
  const semantic = hash(canonical(managed))
  const serialized = hash(JSON.stringify(managed, null, 2) + '\n')
  if (canonical(managed) !== canonical(desired)
    && semantic !== previous.committed[`${key}#managed`] && semantic !== previous.pending[`${key}#managed`]
    && serialized !== previous.committed[key] && serialized !== previous.pending[key]) {
    throw new Error(`installation refuses to replace a user-owned or edited file: ${file.path}`)
  }
  const byId = new Map(desired.filter(entry => entry.id !== undefined).map(entry => [entry.id, entry]))
  const bootstrap = desired.find(entry => entry.id === undefined)?.insert
  const merged = entries.flatMap((entry) => {
    const replacement = byId.get(entry.id)
    if (replacement !== undefined) return [replacement]
    // A restated shipped-preset row is installer-generated, so a later
    // installation that stops declaring one must drop it rather than leave a
    // row the composition does not define.
    if (typeof entry.id === 'string' && entry.id.startsWith('preset-')) return []
    if (!Array.isArray(entry.insert)) return [entry]
    return [{ ...entry, insert: entry.insert.flatMap(plugin => typeof plugin === 'object' && plugin !== null && Reflect.get(plugin, 'id') === 'engineering-bootstrap' ? bootstrap as unknown[] : [plugin]) }]
  })
  return { ...file, content: JSON.stringify(merged, null, 2) + '\n' }
}

function fileDigests(files: InstallationFile[], key: (file: InstallationFile) => string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const file of files) {
    result[key(file)] = hash(file.content)
    if (file.managedPatch) {
      const entries = patchEntries(file.content, file.path)
      const desired: Record<string, unknown>[] = ['llm-pi-ai', 'agent-default-model', 'tool-subagent', 'tool-subagent-fork', 'session-title-llm', 'hmr'].map(id => ({ id }))
      desired.push({ insert: [{ id: 'engineering-bootstrap' }] })
      result[`${key(file)}#managed`] = hash(canonical(managedEntries(entries, desired, file.path)))
    }
  }
  return result
}

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function templateFiles(checkout: string, project: string, preset?: string): Promise<InstallationFile[]> {
  if (preset !== undefined) validateVerificationProfileId(preset)
  const files = await repositoryTemplateFiles(join(checkout, '.agent'), preset === undefined ? undefined : join(checkout, 'tools/agent/presets', preset), preset)
  await assertRepositoryTemplateDestinations(project, [...files, { path: '.agent/dsh-template-installation.json', content: '', runtimeManaged: true }])
  await assertRepositoryPresetSelection(project, files)
  return files.map(file => ({ ...file, path: join(project, file.path), mode: 0o600 }))
}

function digests(value: unknown, marker: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`invalid installation record: ${marker}`)
  const result: Record<string, string> = {}
  for (const [path, digest] of Object.entries(value)) {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`invalid installation hash: ${path}`)
    result[path] = digest
  }
  return result
}

async function installationRecord(marker: string): Promise<InstallationRecord> {
  const source = await optionalFile(marker)
  if (source === undefined) return { committed: {}, pending: {} }
  const value: unknown = JSON.parse(source)
  if (typeof value === 'object' && value !== null && Reflect.get(value, 'schemaVersion') === 1) {
    return { committed: digests(Reflect.get(value, 'committed'), marker), pending: digests(Reflect.get(value, 'pending'), marker) }
  }
  return { committed: digests(value, marker), pending: {} }
}

async function preflightOwnedFiles(marker: string, files: InstallationFile[], key: (file: InstallationFile) => string): Promise<{ current: Record<string, string>; files: InstallationFile[] }> {
  const previous = await installationRecord(marker)
  const current: Record<string, string> = {}
  const merged: InstallationFile[] = []
  for (const file of files) {
    const existing = await optionalFile(file.path)
    if (existing === undefined) { merged.push(file); continue }
    if (file.managedPatch) {
      merged.push(mergeManagedPatch(file, existing, previous, key(file)))
      Object.assign(current, fileDigests([{ ...file, content: existing }], key))
      continue
    }
    const digest = hash(existing)
    if (existing !== file.content && digest !== previous.committed[key(file)] && digest !== previous.pending[key(file)]) {
      throw new Error(`installation refuses to replace a user-owned or edited file: ${file.path}`)
    }
    current[key(file)] = digest
    merged.push(file)
  }
  return { current, files: merged }
}

async function installOwnedFiles(marker: string, files: InstallationFile[], key: (file: InstallationFile) => string): Promise<string[]> {
  await mkdir(dirname(marker), { recursive: true, mode: 0o700 })
  return withFileLock(marker, async () => {
    const prepared = await preflightOwnedFiles(marker, files, key)
    const committed = prepared.current
    const record = fileDigests(prepared.files, key)
    // The pending hashes admit files replaced before an interrupted multi-file upgrade completed.
    await writeFileAtomic(marker, JSON.stringify({ schemaVersion: 1, committed, pending: record }, null, 2) + '\n', { mode: 0o600 })
    for (const file of prepared.files) {
      await writeFileAtomic(file.path, file.content, { mode: file.mode, dirMode: 0o700 })
    }
    await writeFileAtomic(marker, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
    return files.map(file => file.path)
  })
}

/**
 * Render two persistent profiles and a launcher that preserves the caller's directory.
 * @param options - pinned checkout and user installation locations.
 * @returns files containing paths and environment references, never credential values.
 */
export function installationFiles(options: RuntimeInstallationOptions): InstallationFile[] {
  const checkout = resolve(options.checkout)
  const require = createRequire(join(checkout, 'package.json'))
  const loader = require.resolve('tsx/esm')
  // The Web-backed `engineering` profile composes the Web bundle, whose shipped
  // `standard` preset carries the standing delegation row. Restating that
  // declaration without the delegation group keeps the coordinator to the
  // engineering workflow tools. The headless-backed `engineering-run` profile
  // has no preset registry, so restating those rows there would patch an entry
  // the composition never defines.
  const webAppPatch = shippedPresetPatch(checkout)
  const presetRows = shippedPresetRows(readFileSync(webAppPatch, 'utf8'), webAppPatch)
  const files: InstallationFile[] = []
  for (const [profile, bundle] of [['engineering', 'web-app'], ['engineering-run', 'headless']] as const) {
    const profileRows = bundle === 'web-app' ? presetRows : []
    const directory = join(options.home, 'profiles', profile)
    files.push({
      path: join(directory, 'package.json'),
      content: JSON.stringify({
        name: `dsh-profile-${profile}`, private: true, dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', `@deepseek-ai/dsh-${bundle}`] } },
      }, null, 2) + '\n',
      mode: 0o600,
    })
    // JSON is a YAML subset; the profile Loader owns parsing and plugin activation.
    files.push({
      path: join(directory, 'cordis.patch.yml'),
      managedPatch: true,
      content: JSON.stringify([
        { id: 'llm-pi-ai', disabled: true },
        { id: 'agent-default-model', disabled: true },
        { id: 'tool-subagent', disabled: true },
        { id: 'tool-subagent-fork', disabled: true },
        { id: 'session-title-llm', disabled: true },
        { id: 'hmr', disabled: true },
        // Restated preset without the standing delegation group; the composed
        // tree replaces the bundle's row by id. `engineering-run` has no preset
        // registry, so it restates nothing.
        ...profileRows,
        { insert: [{
          id: 'engineering-bootstrap', name: join(checkout, 'tools/agent/runtime/bootstrap.ts'),
          config: { deploymentRoot: resolve(options.home, 'engineering'), roleTimeoutMs: 1_200_000 },
        }] },
      ], null, 2) + '\n',
      mode: 0o600,
    })
  }
  files.push({
    path: join(options.binDirectory, 'dsh'),
    content: [
      '#!/bin/sh',
      '# Launch the pinned DSH checkout without changing the selected workspace.',
      `export DSH_HOME=${quote(resolve(options.home))}`,
      `export TSX_TSCONFIG_PATH=${quote(join(checkout, 'tsconfig.json'))}`,
      'if [ "$#" -eq 0 ]; then set -- engineering; fi',
      `exec ${quote(options.node)} --import ${quote(loader)} ${quote(join(checkout, 'tools/agent/launch.mjs'))} "$@"`,
      '',
    ].join('\n'),
    mode: 0o755,
  })
  return files
}

/**
 * Refresh managed profiles and initialize missing user deployment files without replacing edits.
 * @param options - source checkout and explicit per-user destinations.
 * @returns managed profile paths; deployment configuration remains user-owned.
 */
export async function installEngineeringProfiles(options: RuntimeInstallationOptions): Promise<string[]> {
  if (process.platform === 'win32') throw new Error('the engineering source launcher requires a POSIX host')
  const marker = join(options.home, 'engineering-installation.json')
  const files = installationFiles(options)
  const installed = await installOwnedFiles(marker, files, file => file.path)
  const deployment = join(options.home, 'engineering', '.agent')
  for (const filename of ['models.yaml', 'roles.yaml', 'workflow.yaml', 'data-policy.yaml']) {
    await mkdir(join(deployment, 'config'), { recursive: true, mode: 0o700 })
    await cp(join(options.checkout, '.agent/config', filename), join(deployment, 'config', filename), { force: false, errorOnExist: false })
  }
  await cp(join(options.checkout, '.agent/roles'), join(deployment, 'roles'), { recursive: true, force: false, errorOnExist: false })
  return installed
}

/**
 * Refresh owned artifact schemas and initialize missing repository policy without touching task state.
 * @param options - source checkout, target repository, and optional preset selector.
 * @returns installed project-template paths.
 */
export async function installEngineeringProject(options: InstallationOptions): Promise<string[]> {
  const project = resolve(options.project)
  if (!(await stat(project)).isDirectory()) throw new Error(`project root is not a directory: ${project}`)
  const files = await templateFiles(resolve(options.checkout), project, options.preset)
  const marker = join(project, '.agent', 'dsh-template-installation.json')
  await installOwnedFiles(marker, files.filter(file => file.runtimeManaged), file => relative(project, file.path))
  await initializeMissingRepositoryFiles(project, files.filter(file => !file.runtimeManaged).map(file => ({ path: relative(project, file.path).replaceAll('\\', '/'), content: file.content, runtimeManaged: false })))
  return files.map(file => file.path)
}

/**
 * Validate both installation destinations before the command writes either group.
 * @param options - source checkout, project, and user destinations.
 * @returns resolves when managed content is owned and unedited; individual writes recheck ownership under their lock.
 */
export async function preflightEngineeringInstallation(options: InstallationOptions): Promise<void> {
  if (process.platform === 'win32') throw new Error('the engineering source launcher requires a POSIX host')
  const project = resolve(options.project)
  if (!(await stat(project)).isDirectory()) throw new Error(`project root is not a directory: ${project}`)
  const projectFiles = await templateFiles(resolve(options.checkout), project, options.preset)
  await preflightOwnedFiles(join(project, '.agent/dsh-template-installation.json'), projectFiles.filter(file => file.runtimeManaged), file => relative(project, file.path))
  await preflightOwnedFiles(join(options.home, 'engineering-installation.json'), installationFiles(options), file => file.path)
}

/**
 * Validate user-profile ownership without selecting or initializing a repository.
 * @param options - source checkout and user destinations.
 * @returns resolves when the managed profile files may be installed or refreshed.
 */
export async function preflightEngineeringProfiles(options: RuntimeInstallationOptions): Promise<void> {
  if (process.platform === 'win32') throw new Error('the engineering source launcher requires a POSIX host')
  await preflightOwnedFiles(join(options.home, 'engineering-installation.json'), installationFiles(options), file => file.path)
}
