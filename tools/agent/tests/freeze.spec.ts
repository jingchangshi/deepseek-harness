import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { updateFreeze, verifyFreeze } from '../src/freeze.ts'

const execute = promisify(execFile)

async function fixture(): Promise<{ root: string; base: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-freeze-'))
  await execute('git', ['init'], { cwd: root })
  await execute('git', ['config', 'user.email', 'freeze@example.invalid'], { cwd: root })
  await execute('git', ['config', 'user.name', 'Freeze Test'], { cwd: root })
  await writeFile(join(root, 'base.txt'), 'base\n')
  await execute('git', ['add', 'base.txt'], { cwd: root })
  await execute('git', ['commit', '-m', 'base'], { cwd: root })
  await execute('git', ['tag', 'frozen-base'], { cwd: root })
  const { stdout } = await execute('git', ['rev-parse', 'HEAD'], { cwd: root })
  return { root, base: stdout.trim() }
}

async function writeManifest(root: string, base: string): Promise<void> {
  await mkdir(join(root, '.agent'), { recursive: true })
  await writeFile(join(root, '.agent/FREEZE.json'), `${JSON.stringify({
    schemaVersion: 1,
    harnessVersion: 'test',
    runtime: { repository: 'test', tag: 'frozen-base', commitRef: base },
    toolchain: { node: process.versions.node, pnpm: '11.7.0' },
    configurationSchemaVersion: 1,
    files: {},
  })}\n`)
}

describe('freeze manifest', () => {
  it('regenerates source hashes and includes new runtime modules without changing the baseline', async () => {
    const { root, base } = await fixture()
    try {
      await writeManifest(root, base)
      await mkdir(join(root, 'tools/agent/src'), { recursive: true })
      await mkdir(join(root, 'tools/agent/runtime'), { recursive: true })
      await writeFile(join(root, 'tools/agent/src/invocation.ts'), 'export const version = 1\n')
      await writeFile(join(root, 'tools/agent/runtime/index.ts'), 'export const name = "test"\n')
      const updated = await updateFreeze(root)
      expect(Object.keys(updated.files)).toEqual(['tools/agent/runtime/index.ts', 'tools/agent/src/invocation.ts'])
      expect(updated.runtime.commitRef).toBe(base)
      await expect(verifyFreeze(root)).resolves.toEqual(updated)
      await writeFile(join(root, 'tools/agent/src/invocation.ts'), 'export const version = 2\n')
      await expect(verifyFreeze(root)).rejects.toThrow('freeze hash mismatch')
      const refreshed = await updateFreeze(root)
      expect(refreshed.files['tools/agent/src/invocation.ts']).not.toBe(updated.files['tools/agent/src/invocation.ts'])
      expect(JSON.parse(await readFile(join(root, '.agent/FREEZE.json'), 'utf8'))).toEqual(refreshed)
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
  it('matches the pinned checkout, toolchain, lockfile, and role configuration', async () => {
    await expect(verifyFreeze(resolve(import.meta.dirname, '../../..'))).resolves.toMatchObject({
      runtime: { tag: 'dsh-v0.2.1-alpha.1', commitRef: 'refs/tags/dsh-v0.2.1-alpha.1^{}' },
      toolchain: { node: '22.22.2', pnpm: '11.7.0' },
    })
  })

  it('accepts a descendant of the frozen release and rejects unrelated history', async () => {
    const { root, base } = await fixture()
    try {
      await writeFile(join(root, 'descendant.txt'), 'descendant\n')
      await execute('git', ['add', 'descendant.txt'], { cwd: root })
      await execute('git', ['commit', '-m', 'descendant'], { cwd: root })
      await writeManifest(root, base)
      await expect(verifyFreeze(root)).resolves.toMatchObject({ runtime: { tag: 'frozen-base' } })

      await execute('git', ['switch', '--orphan', 'unrelated'], { cwd: root })
      await writeFile(join(root, 'unrelated.txt'), 'unrelated\n')
      await execute('git', ['add', 'unrelated.txt'], { cwd: root })
      await execute('git', ['commit', '-m', 'unrelated'], { cwd: root })
      await writeManifest(root, base)
      await expect(verifyFreeze(root)).rejects.toThrow('not an ancestor')
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})
