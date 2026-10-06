/** Reproducibility checks for the frozen harness manifest. */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const execute = promisify(execFile)

interface FreezeManifest {
  schemaVersion: 1
  harnessVersion: string
  runtime: { repository: string; tag: string; commitRef: string }
  toolchain: { node: string; pnpm: string }
  configurationSchemaVersion: number
  files: Record<string, string>
}

function manifest(value: unknown): FreezeManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('freeze manifest must be an object')
  const schemaVersion = Reflect.get(value, 'schemaVersion')
  const harnessVersion = Reflect.get(value, 'harnessVersion')
  const runtime = Reflect.get(value, 'runtime')
  const toolchain = Reflect.get(value, 'toolchain')
  const configurationSchemaVersion = Reflect.get(value, 'configurationSchemaVersion')
  const files = Reflect.get(value, 'files')
  if (schemaVersion !== 1 || typeof harnessVersion !== 'string' || configurationSchemaVersion !== 1) throw new Error('invalid freeze manifest version')
  if (typeof runtime !== 'object' || runtime === null || typeof toolchain !== 'object' || toolchain === null || typeof files !== 'object' || files === null || Array.isArray(files)) {
    throw new Error('invalid freeze manifest sections')
  }
  const repository = Reflect.get(runtime, 'repository')
  const tag = Reflect.get(runtime, 'tag')
  const commitRef = Reflect.get(runtime, 'commitRef')
  const node = Reflect.get(toolchain, 'node')
  const pnpm = Reflect.get(toolchain, 'pnpm')
  if ([repository, tag, commitRef, node, pnpm].some(item => typeof item !== 'string')) throw new Error('invalid freeze manifest values')
  const hashes: Record<string, string> = {}
  for (const [path, hash] of Object.entries(files)) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`invalid freeze hash for ${path}`)
    hashes[path] = hash
  }
  return {
    schemaVersion: 1,
    harnessVersion,
    runtime: { repository, tag, commitRef },
    toolchain: { node, pnpm },
    configurationSchemaVersion,
    files: hashes,
  }
}

/**
 * Verify runtime identity, tool versions, and committed configuration hashes.
 * @param root - frozen repository root.
 * @returns the validated manifest.
 */
export async function verifyFreeze(root: string): Promise<FreezeManifest> {
  const value = manifest(JSON.parse(await readFile(resolve(root, '.agent/FREEZE.json'), 'utf8')))
  await validateBaseline(root, value)
  for (const [path, expected] of Object.entries(value.files)) {
    const actual = createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')
    if (actual !== expected) throw new Error(`freeze hash mismatch for ${path}`)
  }
  return value
}

async function validateBaseline(root: string, value: FreezeManifest): Promise<void> {
  const [{ stdout: pnpm }, { stdout: taggedCommit }, { stdout: frozenCommit }] = await Promise.all([
    execute('pnpm', ['--version'], { cwd: root }),
    execute('git', ['rev-parse', `${value.runtime.tag}^{}`], { cwd: root }),
    execute('git', ['rev-parse', value.runtime.commitRef], { cwd: root }),
  ])
  if (taggedCommit.trim() !== frozenCommit.trim()) throw new Error('frozen DSH tag and commitRef differ')
  try {
    await execute('git', ['merge-base', '--is-ancestor', frozenCommit.trim(), 'HEAD'], { cwd: root })
  } catch {
    throw new Error('frozen DSH runtime is not an ancestor of this harness branch')
  }
  if (process.versions.node !== value.toolchain.node || pnpm.trim() !== value.toolchain.pnpm) throw new Error('toolchain does not match the freeze manifest')
}

/**
 * Regenerate core file hashes after reviewed source changes without changing the release or toolchain.
 * @param root - frozen source checkout, not an installed target repository.
 * @returns the updated manifest including every engineering source and runtime module.
 */
export async function updateFreeze(root: string): Promise<FreezeManifest> {
  const filename = resolve(root, '.agent/FREEZE.json')
  const value = manifest(JSON.parse(await readFile(filename, 'utf8')))
  await validateBaseline(root, value)
  const paths = new Set(Object.keys(value.files))
  for (const directory of ['tools/agent/src', 'tools/agent/runtime']) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.ts')) paths.add(`${directory}/${entry.name}`)
    }
  }
  const files: Record<string, string> = {}
  for (const path of [...paths].sort()) {
    files[path] = createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')
  }
  const updated = { ...value, files }
  await writeFileAtomic(filename, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 })
  return updated
}
