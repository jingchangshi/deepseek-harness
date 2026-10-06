/** Source inventories, declared policy inputs and repository-owned verification attempt identities. */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { load } from 'js-yaml'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { deepEqualJson, isJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { loadRepositoryKnowledge } from './knowledge.ts'
import { loadProjectVerificationConfig, loadVerificationProfile } from './verification.ts'
import type { ProjectVerificationConfig, VerificationGate } from './verification.ts'
import { resolveVerificationPolicy, resolveVerificationRequirements } from './policy.ts'
import type { AcceptanceTier, VerificationPolicy, VerificationReference, VerificationRequirements } from './policy.ts'
import type { RepositoryPresetIdentity } from './templates.ts'

const execute = promisify(execFile)

/** Immutable content-and-location digest of a source inventory. */
export type SourceTreeDigest = Branded<'SourceTreeDigest'>
/** Immutable digest of policy declarations and frozen selections. */
export type VerificationPolicyDigest = Branded<'VerificationPolicyDigest'>
/** Immutable digest of repository declarations, knowledge and preset identity. */
export type RepositoryProfileDigest = Branded<'RepositoryProfileDigest'>
/** Immutable digest of cumulative required instances for one attempt. */
export type RequiredSetDigest = Branded<'RequiredSetDigest'>
/** Immutable planning-field digest independent of the repository-owned source binding. */
export type PlanIntentDigest = Branded<'PlanIntentDigest'>

/** Captured source paths and content/location identities, excluding runtime-owned files. */
export interface SourceInventory {
  head: string | null
  files: Record<string, string>
  dirtyPaths: string[]
  sourceTreeDigest: SourceTreeDigest
}

/** Final verification authority shared by plan, result, review and decision. */
export interface VerificationIdentity {
  attempt: number
  sourceTreeDigest: SourceTreeDigest
  verificationPolicyDigest: VerificationPolicyDigest
  repositoryProfileDigest: RepositoryProfileDigest
  requiredSetDigest: RequiredSetDigest
}

/** Repository-owned mutable bindings beside immutable planning fields. */
export interface PlanBinding {
  baseline: SourceInventory
  verificationPolicyDigest: VerificationPolicyDigest
  repositoryProfileDigest: RepositoryProfileDigest
  requirements: VerificationRequirements
  extras: VerificationReference[]
  preset: RepositoryPresetIdentity | null
  attempt: number
  seal: VerificationIdentity | null
}

/** Validated current policy and repository input digests. */
export interface RepositoryVerificationContext {
  gates: VerificationGate[]
  policy: VerificationPolicy
  verificationPolicyDigest: VerificationPolicyDigest
  repositoryProfileDigest: RepositoryProfileDigest
  preset: RepositoryPresetIdentity | null
  verificationConfig: ProjectVerificationConfig | null
  tier: AcceptanceTier
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  return JSON.stringify(value)
}

/**
 * Hash lossless JSON with recursive object-key ordering and significant array order.
 * @param value - validated JSON data.
 * @returns a SHA-256 digest branded for the caller's identity domain.
 */
export function identityDigest<Name extends string>(value: JsonValue): Branded<Name> {
  return createHash('sha256').update(canonical(value)).digest('hex') as Branded<Name>
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`)
  return Object.fromEntries(Object.entries(value))
}

async function optionalFile(filename: string): Promise<string | undefined> {
  try { return await readFile(filename, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function fileIdentity(root: string, path: string): Promise<[string, string, string | null, string]> {
  const filename = resolve(root, path)
  const canonicalRoot = await realpath(root)
  const target = await realpath(filename)
  const inside = relative(canonicalRoot, target).replaceAll('\\', '/')
  if (isAbsolute(inside) || inside === '..' || inside.startsWith('../')) throw new Error('identity input must stay inside repository')
  const info = await lstat(filename)
  if (!(await lstat(target)).isFile()) throw new Error('identity input must be a file')
  return [path, inside, info.isSymbolicLink() ? await readlink(filename) : null, createHash('sha256').update(await readFile(target)).digest('hex')]
}

function repositoryPath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value) || value.includes('\\') || value.includes('\0')
    || value.split('/').some(component => component === '..' || component === '.' || component === '') || /^[a-z]:/i.test(value)) throw new Error(`${field} must be a repository-relative path`)
  return value
}

/**
 * Read and validate a repository's initial scaffold identity without selecting a compiler.
 * @param root - repository root.
 * @returns the recorded identity or an explicit no-preset value.
 */
export async function readRepositoryPresetIdentity(root: string): Promise<RepositoryPresetIdentity | null> {
  const source = await optionalFile(join(root, '.agent/preset.json'))
  if (source === undefined) return null
  const value = object(JSON.parse(source), 'preset identity')
  if (value.schemaVersion !== 1 || typeof value.id !== 'string' || typeof value.version !== 'string' || typeof value.digest !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.digest)) throw new Error('invalid preset identity')
  return { schemaVersion: 1, id: value.id, version: value.version, digest: value.digest as RepositoryPresetIdentity['digest'] }
}

/**
 * Load all declared policy inputs and hash their logical paths, resolved targets and bytes.
 * @param root - repository root.
 * @param profile - task-selected verification profile.
 * @param extras - frozen model-added instance references.
 * @param selectedTier - optional explicit user selection.
 * @returns validated requirements program and independent policy/profile identities.
 */
export async function loadRepositoryVerificationContext(root: string, profile: string, extras: readonly VerificationReference[] = [], selectedTier?: AcceptanceTier): Promise<RepositoryVerificationContext> {
  const capturedInputs = new Map<string, JsonValue>()
  const readInput = async (path: string): Promise<string> => {
    const before = await fileIdentity(root, path)
    const source = await readFile(resolve(root, path))
    const after = await fileIdentity(root, path)
    if (!deepEqualJson(before, after) || createHash('sha256').update(source).digest('hex') !== after[3]) throw new Error('verification input changed while loading; explicitly replan')
    capturedInputs.set(path, after)
    return source.toString('utf8')
  }
  const gates = await loadVerificationProfile(root, profile, await readInput(`.agent/profiles/${profile}.yaml`))
  const policyPaths = [`.agent/profiles/${profile}.yaml`]
  const profilePaths: string[] = []
  const projectSource = await optionalFile(join(root, '.agent/config/project.yaml')) === undefined
    ? undefined : await readInput('.agent/config/project.yaml')
  let policy = resolveVerificationPolicy(undefined)
  let verificationConfig: ProjectVerificationConfig | null = null
  let requestedTier = selectedTier
  if (projectSource !== undefined) {
    const project = object(load(projectSource), 'repository project')
    if (requestedTier === undefined && project.acceptanceTier !== undefined) {
      if (project.acceptanceTier !== 'development' && project.acceptanceTier !== 'presubmit' && project.acceptanceTier !== 'qualification') throw new Error('invalid project acceptanceTier')
      requestedTier = project.acceptanceTier
    }
    profilePaths.push('.agent/config/project.yaml')
    if (project.adapter !== undefined) {
      const path = repositoryPath(project.adapter, 'project adapter')
      policyPaths.push(path)
      verificationConfig = await loadProjectVerificationConfig(resolve(root, path), await readInput(path))
      policyPaths.push(...(verificationConfig.inputs ?? []).map(path => repositoryPath(path, 'command input')))
    }
    if (project.verificationPolicy !== undefined) {
      const path = repositoryPath(project.verificationPolicy, 'verification policy')
      policyPaths.push(path)
      policy = resolveVerificationPolicy(load(await readInput(path)))
    }
    if (project.knowledge !== undefined) {
      const path = repositoryPath(project.knowledge, 'repository knowledge')
      const knowledge = await loadRepositoryKnowledge(root, path)
      profilePaths.push(path, ...knowledge.instructionFiles, ...knowledge.skills.map(skill => skill.path))
    }
  }
  const preset = await readRepositoryPresetIdentity(root)
  if (preset !== null) profilePaths.push('.agent/preset.json')
  const tier = resolveVerificationRequirements(gates, policy, [], extras, requestedTier).tier
  const policyInputs = await Promise.all([...new Set(policyPaths)].sort().map(path => fileIdentity(root, path)))
  const profileInputs = await Promise.all([...new Set(profilePaths)].sort().map(path => fileIdentity(root, path)))
  for (const [path, identity] of capturedInputs) {
    if (!deepEqualJson(identity, await fileIdentity(root, path))) throw new Error('verification input changed while loading; explicitly replan')
  }
  return {
    gates, policy, preset, verificationConfig, tier,
    verificationPolicyDigest: identityDigest<'VerificationPolicyDigest'>({ inputs: policyInputs, tier, extras: extras.map(extra => ({ name: extra.name, scope: extra.scope })) }),
    repositoryProfileDigest: identityDigest<'RepositoryProfileDigest'>({ inputs: profileInputs, preset: preset === null ? null : { ...preset } }),
  }
}

/**
 * Capture Git-indexed and unignored source paths, or a plain directory inventory when Git is absent.
 * @param root - repository root.
 * @returns source identity including HEAD, deletions and resolved symlink targets.
 */
export async function captureSourceInventory(root: string): Promise<SourceInventory> {
  const paths: string[] = []
  const dirtyPaths: string[] = []
  let head: string | null = null
  if (await lstat(join(root, '.git')).then(() => true, (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  })) {
    const projectSource = await optionalFile(join(root, '.agent/config/project.yaml'))
    const timeout = projectSource === undefined ? undefined : object(load(projectSource), 'repository project').commandTimeoutMs
    if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1)) throw new Error('commandTimeoutMs must be a positive integer')
    const options = { cwd: root, maxBuffer: 64 * 1024 * 1024, ...timeout === undefined ? {} : { timeout: timeout as number } }
    head = (await execute('git', ['rev-parse', 'HEAD'], options)).stdout.trim()
    paths.push(...(await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], options)).stdout.split('\0').filter(Boolean))
    dirtyPaths.push(...(await execute('git', ['diff', '--no-renames', '--name-only', '-z', 'HEAD'], options)).stdout.split('\0').filter(Boolean),
      ...(await execute('git', ['ls-files', '--others', '--exclude-standard', '-z'], options)).stdout.split('\0').filter(Boolean))
  } else {
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
        const path = directory === '' ? entry.name : `${directory}/${entry.name}`
        if (entry.name === '.git' || entry.name === '.dsh' || entry.name === 'node_modules' || runtimePath(path)) continue
        if (entry.isDirectory()) await walk(path)
        else paths.push(path)
      }
    }
    await walk('')
  }
  const files: Record<string, string> = {}
  for (const path of [...new Set(paths)].sort()) {
    if (runtimePath(path)) continue
    try {
      const info = await lstat(resolve(root, path))
      if (info.isDirectory()) {
        const nested = await captureSourceInventory(resolve(root, path))
        files[path] = nested.sourceTreeDigest
        for (const [nestedPath, digest] of Object.entries(nested.files)) files[`${path}/${nestedPath}`] = digest
        dirtyPaths.push(...nested.dirtyPaths.map(nestedPath => `${path}/${nestedPath}`))
      } else files[path] = identityDigest<'SourceFileDigest'>(await fileIdentity(root, path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return { head, files, dirtyPaths: [...new Set(dirtyPaths)].filter(path => !runtimePath(path)).sort(), sourceTreeDigest: identityDigest<'SourceTreeDigest'>({ head, files }) }
}

function runtimePath(path: string): boolean {
  return path === '.agent/tasks' || path.startsWith('.agent/tasks/') || path === '.dsh' || path.startsWith('.dsh/')
    || path === '.agent/AUTO_RUN' || path.startsWith('.agent/AUTO_RUN.')
}

/**
 * Compare a fixed baseline with source files and reject a moved Git HEAD.
 * @param baseline - frozen source inventory.
 * @param current - current source inventory.
 * @returns old and new changed paths; deleted paths remain present.
 */
export function sourceImpactPaths(baseline: SourceInventory, current: SourceInventory): string[] {
  if (baseline.head !== current.head) throw new Error('repository HEAD changed; explicitly replan')
  return [...new Set([...baseline.dirtyPaths, ...current.dirtyPaths, ...[...new Set([...Object.keys(baseline.files), ...Object.keys(current.files)])]
    .filter(path => baseline.files[path] !== current.files[path])])].sort()
}

/**
 * Read frozen extra instance references at a model or durable JSON entry point.
 * @param value - optional JSON instance array.
 * @returns validated references, with absence resolved to no extras.
 */
export function resolveVerificationExtras(value: unknown): VerificationReference[] {
  if (value === undefined) return []
  if (!isJsonValue(value) || !Array.isArray(value)) throw new Error('verification extras must be JSON instances')
  return value.map(entry => {
    const reference = object(entry, 'verification extra')
    if (typeof reference.name !== 'string' || reference.name.length === 0) throw new Error('verification extra needs a name')
    return { name: reference.name, scope: object(reference.scope, 'verification extra scope') as Record<string, JsonValue> }
  })
}
