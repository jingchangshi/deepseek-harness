import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectionHashForReadResult } from '../runtime/index.ts'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-inspection-'))
  roots.push(root)
  const path = join(root, 'source.ts')
  await writeFile(path, 'export const actual = true\n')
  return { root, path }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('runtime source inspection receipts', () => {
  it('records only lines returned by read that match the assigned local file', async () => {
    const { root, path } = await fixture()
    const bytes = await readFile(path)
    await expect(inspectionHashForReadResult(root, 'source.ts', {
      path,
      offset: 1,
      lines: [{ number: 1, text: 'export const actual = true' }],
      totalLines: 1,
    })).resolves.toEqual({ path, contentHash: createHash('sha256').update(bytes).digest('hex') })
  })

  it.each([
    ['stale content', 'source.ts', 'export const stale = true'],
    ['remote path', 'https://fixture.invalid/source.ts', 'export const actual = true'],
  ])('does not issue a receipt for %s', async (_label, returnedPath, text) => {
    const { root } = await fixture()
    await expect(inspectionHashForReadResult(root, 'source.ts', {
      path: returnedPath,
      offset: 1,
      lines: [{ number: 1, text }],
      totalLines: 1,
    })).resolves.toBeUndefined()
  })
})
