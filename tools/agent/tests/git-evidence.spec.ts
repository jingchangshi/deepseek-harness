/** Immutable Git review evidence from private repositories and fixed commit IDs. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitSnapshot, GitEvidenceRepository } from '../src/git-evidence.ts'

const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execute('git', ['-c', `core.hooksPath=${join(root, '.disabled-hooks')}`, ...args], { cwd: root })
  return result.stdout.trim()
}

async function commit(root: string, subject: string): Promise<string> {
  await git(root, 'add', '--all')
  await git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', subject)
  return git(root, 'rev-parse', 'HEAD')
}

async function fixture(): Promise<{ root: string; base: string; defective: string; clean: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'git-evidence-')))
  roots.push(root)
  await git(root, 'init', '-q', '--initial-branch=main')
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/math.ts'), 'export const add = (a: number, b: number) => a + b\n')
  const base = await commit(root, 'Correct addition')
  await writeFile(join(root, 'src/math.ts'), 'export const add = (a: number, b: number) => a - b\n')
  const defective = await commit(root, 'Introduce subtraction defect')
  await writeFile(join(root, 'src/math.ts'), 'export const add = (a: number, b: number) => a + b\n')
  const clean = await commit(root, 'Restore addition')
  return { root, base, defective, clean }
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

describe('fixed Git review snapshots', () => {
  it('pins a commit and exposes the real defective source and change', async () => {
    const { root, base, defective } = await fixture()
    const snapshot = await createGitSnapshot(root, { kind: 'commit', target: defective })
    expect(snapshot).toMatchObject({ schemaVersion: 1, repositoryRoot: root, targetCommit: defective, baseCommit: base, objectFormat: 'sha1' })
    const evidence = new GitEvidenceRepository(snapshot)
    const shown = await evidence.show({ path: 'src/math.ts' })
    expect(shown).toMatchObject({ snapshotId: snapshot.id, commit: defective, path: 'src/math.ts', binary: false, startLine: 1, completeness: { complete: true } })
    expect(shown.text).toBe('export const add = (a: number, b: number) => a - b\n')
    expect(shown.contentHash).toBe(hash(shown.text))
    const diff = await evidence.diff({ path: 'src/math.ts' })
    expect(diff).toMatchObject({ snapshotId: snapshot.id, baseCommit: base, targetCommit: defective, binary: false, completeness: { complete: true } })
    expect(diff.text).toContain('+export const add = (a: number, b: number) => a - b')
    expect(diff.text).toContain('-export const add = (a: number, b: number) => a + b')
    expect(diff.contentHash).toBe(hash(diff.text))
  })

  it('records immutable receipts only for actual fixed-source queries', async () => {
    const { root, defective } = await fixture()
    const snapshot = await createGitSnapshot(root, { kind: 'commit', target: defective })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Reflect.set(snapshot, 'targetCommit', 'invented')).toBe(false)
    const evidence = new GitEvidenceRepository(snapshot)
    expect(evidence.observedEvidence()).toEqual([])
    await expect(evidence.show({ path: '../invented' })).rejects.toThrow()
    expect(evidence.observedEvidence()).toEqual([])
    const shown = await evidence.show({ path: 'src/math.ts' })
    const receipts = evidence.observedEvidence()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ snapshotId: snapshot.id, operation: 'show', path: 'src/math.ts',
      commit: defective, startLine: 1, endLine: 1, contentHash: shown.contentHash, complete: true, binary: false })
    expect(typeof receipts[0]!.id).toBe('string')
    expect(shown.evidenceId).toBe(receipts[0]!.id)
    expect(Object.isFrozen(receipts)).toBe(true)
    expect(Object.isFrozen(receipts[0])).toBe(true)
    expect(Reflect.set(receipts[0]!, 'path', 'invented')).toBe(false)
    expect(Reflect.set(receipts, '0', { id: 'fabricated' })).toBe(false)
    const files = await evidence.changedFiles({})
    const diff = await evidence.diff({ path: 'src/math.ts' })
    const history = await evidence.history({})
    expect([files.evidenceId, diff.evidenceId, history.evidenceId])
      .toEqual(evidence.observedEvidence().slice(1).map(receipt => receipt.id))
    expect(evidence.observedEvidence().map(receipt => receipt.operation)).toEqual(['show', 'changed-files', 'diff', 'history'])
    expect(new Set(evidence.observedEvidence().map(receipt => receipt.id)).size).toBe(4)
  })

  it('distinguishes a clean fix from the defective commit with a source oracle', async () => {
    const { root, defective, clean } = await fixture()
    const snapshot = await createGitSnapshot(root, { kind: 'range', target: `${defective}..${clean}` })
    expect(snapshot).toMatchObject({ baseCommit: defective, targetCommit: clean })
    const shown = await new GitEvidenceRepository(snapshot).show({ path: 'src/math.ts' })
    expect(shown.text).toContain('=> a + b')
    expect(shown.text).not.toContain('=> a - b')
  })

  it('keeps a branch snapshot fixed after its branch moves and worktree changes', async () => {
    const { root, defective, clean } = await fixture()
    await git(root, 'branch', 'review', defective)
    const snapshot = await createGitSnapshot(root, { kind: 'branch', target: 'review' })
    await git(root, 'branch', '-f', 'review', clean)
    await writeFile(join(root, 'src/math.ts'), 'uncommitted worktree\n')
    const shown = await new GitEvidenceRepository(snapshot).show({ path: 'src/math.ts' })
    expect(snapshot.targetCommit).toBe(defective)
    expect(shown.commit).toBe(defective)
    expect(shown.text).toContain('=> a - b')
    expect(shown.text).not.toContain('uncommitted')
  })

  it('resolves an available local PR ref without a network provider', async () => {
    const { root, base, defective } = await fixture()
    await git(root, 'update-ref', 'refs/pull/17/head', defective)
    const snapshot = await createGitSnapshot(root, { kind: 'pr', target: '17', base })
    expect(snapshot).toMatchObject({ targetCommit: defective, baseCommit: base })
    await expect(createGitSnapshot(root, { kind: 'pr', target: '18' })).rejects.toThrow()
  })

  it('uses the empty tree for a root commit', async () => {
    const { root, base } = await fixture()
    const snapshot = await createGitSnapshot(root, { kind: 'commit', target: base })
    expect(snapshot.baseCommit).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
    expect(await new GitEvidenceRepository(snapshot).changedFiles({})).toMatchObject({
      snapshotId: snapshot.id, files: [{ path: 'src/math.ts', status: 'A' }], completeness: { complete: true },
    })
  })

  it.each(['--output=owned', '-c', 'HEAD;touch owned', 'HEAD\0ignored'])('rejects option or shell ref injection %j', async target => {
    const { root } = await fixture()
    await expect(createGitSnapshot(root, { kind: 'commit', target })).rejects.toThrow()
    await expect(readFile(join(root, 'owned'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['../outside', '/absolute', 'C:\\absolute', 'src\\math.ts', 'src/math.ts\0ignored'])('rejects an unsafe evidence path %j', async path => {
    const { root, defective } = await fixture()
    const evidence = new GitEvidenceRepository(await createGitSnapshot(root, { kind: 'commit', target: defective }))
    await expect(evidence.show({ path })).rejects.toThrow()
    await expect(evidence.diff({ path })).rejects.toThrow()
  })

  it('ignores configured external diff and text conversion commands', async () => {
    const { root, defective } = await fixture()
    await writeFile(join(root, 'unsafe-hook.mjs'),
      "import { writeFileSync } from 'node:fs'; writeFileSync('owned', 'executed'); process.stdout.write('fabricated source');\n")
    await writeFile(join(root, '.gitattributes'), '*.ts diff=unsafe\n')
    await git(root, 'config', 'diff.external', 'node unsafe-hook.mjs')
    await git(root, 'config', 'diff.unsafe.textconv', 'node unsafe-hook.mjs')
    const evidence = new GitEvidenceRepository(await createGitSnapshot(root, { kind: 'commit', target: defective }))
    expect((await evidence.diff({ path: 'src/math.ts' })).text).toContain('=> a - b')
    expect((await evidence.show({ path: 'src/math.ts' })).text).toContain('=> a - b')
    await expect(readFile(join(root, 'owned'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reads actual pinned objects despite repository replacement refs', async () => {
    const { root, defective, clean } = await fixture()
    await git(root, 'replace', defective, clean)
    const snapshot = await createGitSnapshot(root, { kind: 'commit', target: defective })
    expect(snapshot.targetCommit).toBe(defective)
    expect((await new GitEvidenceRepository(snapshot).show({ path: 'src/math.ts' })).text).toContain('=> a - b')
  })

  it('rejects cancelled snapshot and evidence work without recording a query', async () => {
    const { root, defective } = await fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(createGitSnapshot(root, { kind: 'commit', target: defective }, controller.signal)).rejects.toThrow()
    const evidence = new GitEvidenceRepository(await createGitSnapshot(root, { kind: 'commit', target: defective }))
    await expect(evidence.show({ path: 'src/math.ts' }, controller.signal)).rejects.toThrow()
    expect(evidence.observedEvidence()).toEqual([])
  })

  it('treats wildcard filenames as literal diff paths', async () => {
    const { root, clean } = await fixture()
    await writeFile(join(root, 'literal[1].txt'), 'literal-only-change\n')
    await writeFile(join(root, 'literal1.txt'), 'neighbor-must-not-appear\n')
    const target = await commit(root, 'Add literal and neighboring filenames')
    const evidence = new GitEvidenceRepository(await createGitSnapshot(root, { kind: 'commit', target, base: clean }))
    const diff = await evidence.diff({ path: 'literal[1].txt' })
    expect(diff.text).toContain('+literal-only-change')
    expect(diff.text).not.toContain('neighbor-must-not-appear')
    expect(diff.text).not.toContain('diff --git a/literal1.txt')
  })

  it('rejects a missing promisor blob without executing remote helpers or changing repository files', async () => {
    const { root, defective } = await fixture()
    const snapshot = await createGitSnapshot(root, { kind: 'commit', target: defective })
    const blob = await git(root, 'rev-parse', `${defective}:src/math.ts`)
    const blobPath = join(root, '.git/objects', blob.slice(0, 2), blob.slice(2))
    const helper = join(root, '.git/unsafe-fetch.mjs')
    await writeFile(helper, "import { writeFileSync } from 'node:fs'; writeFileSync('.git/fetch-owned', 'executed'); process.exit(1);\n")
    const escapedHelper = helper.replaceAll('%', '%%').replaceAll(' ', '% ')
    await git(root, 'config', 'extensions.partialClone', 'unsafe')
    await git(root, 'config', 'remote.unsafe.promisor', 'true')
    await git(root, 'config', 'remote.unsafe.partialclonefilter', 'blob:none')
    await git(root, 'config', 'remote.unsafe.url', `ext::node ${escapedHelper}`)
    await git(root, 'config', 'protocol.ext.allow', 'always')
    await unlink(blobPath)
    async function repositoryFiles(directory: string): Promise<Record<string, string>> {
      const output: Record<string, string> = {}
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          output[path] = 'directory'
          Object.assign(output, await repositoryFiles(path))
        } else output[path] = createHash('sha256').update(await readFile(path)).digest('hex')
      }
      return output
    }
    const before = await repositoryFiles(root)
    const evidence = new GitEvidenceRepository(snapshot)
    await expect(evidence.show({ path: 'src/math.ts' })).rejects.toThrow()
    expect(evidence.observedEvidence()).toEqual([])
    await expect(readFile(join(root, '.git/fetch-owned'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await repositoryFiles(root)).toEqual(before)
    await expect(git(root, 'show', `${defective}:src/math.ts`)).rejects.toThrow()
    expect(await readFile(join(root, '.git/fetch-owned'), 'utf8')).toBe('executed')
  })

  it('reports binary content explicitly rather than decoding it as text', async () => {
    const { root, clean } = await fixture()
    await writeFile(join(root, 'image.bin'), Buffer.from([0, 255, 1, 254, 0]))
    const target = await commit(root, 'Add binary fixture')
    const evidence = new GitEvidenceRepository(await createGitSnapshot(root, { kind: 'commit', target, base: clean }))
    expect(await evidence.show({ path: 'image.bin' })).toMatchObject({ path: 'image.bin', binary: true, completeness: { complete: true } })
    expect(await evidence.diff({ path: 'image.bin' })).toMatchObject({ path: 'image.bin', binary: true, completeness: { complete: true } })
  })

  it('pages large diffs and source lines without dropping content', async () => {
    const { root, clean } = await fixture()
    const source = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
    await writeFile(join(root, 'large.txt'), source)
    const target = await commit(root, 'Add large fixture')
    const evidence = new GitEvidenceRepository(await createGitSnapshot(root, { kind: 'commit', target, base: clean }))
    let text = ''
    let offset = 0
    for (let pageCount = 0; pageCount < 100; pageCount++) {
      const page = await evidence.diff({ path: 'large.txt', offset, limit: 128 })
      expect(page.contentHash).toBe(hash(page.text))
      text += page.text
      if (page.completeness.complete) break
      expect(page.completeness.nextOffset).toBeGreaterThan(offset)
      offset = page.completeness.nextOffset!
      if (pageCount === 99) throw new Error('Diff did not finish within its content-derived page budget')
    }
    expect(text).toBe((await evidence.diff({ path: 'large.txt', limit: 100000 })).text)
    expect(text).toContain('+line 300')
    const first = await evidence.show({ path: 'large.txt', startLine: 1, lineCount: 150 })
    const second = await evidence.show({ path: 'large.txt', startLine: first.completeness.nextLine!, lineCount: 150 })
    expect(first).toMatchObject({ startLine: 1, completeness: { complete: false, nextLine: 151 } })
    expect(second).toMatchObject({ startLine: 151, completeness: { complete: true } })
    expect(first.text + second.text).toBe(source)
    expect(first.contentHash).toBe(hash(first.text))
    expect(second.contentHash).toBe(hash(second.text))
  })

  it('pages changed files and pinned history with explicit completeness', async () => {
    const { root, base, defective, clean } = await fixture()
    await writeFile(join(root, 'a.txt'), 'a\n')
    await writeFile(join(root, 'b.txt'), 'b\n')
    const target = await commit(root, 'Add two files')
    const snapshot = await createGitSnapshot(root, { kind: 'range', target: `${base}..${target}` })
    const evidence = new GitEvidenceRepository(snapshot)
    const first = await evidence.changedFiles({ offset: 0, limit: 1 })
    const second = await evidence.changedFiles({ offset: first.completeness.nextOffset!, limit: 1 })
    expect(first).toMatchObject({ snapshotId: snapshot.id, files: [{ path: 'a.txt', status: 'A' }], completeness: { complete: false, nextOffset: 1 } })
    expect(second).toMatchObject({ files: [{ path: 'b.txt', status: 'A' }], completeness: { complete: true } })
    const history = await evidence.history({ offset: 0, limit: 2 })
    const remainder = await evidence.history({ offset: history.completeness.nextOffset!, limit: 10 })
    expect(history).toMatchObject({ snapshotId: snapshot.id, commits: [{ commit: target, subject: 'Add two files' }, { commit: clean, subject: 'Restore addition' }], completeness: { complete: false, nextOffset: 2 } })
    expect(remainder.commits.map(entry => entry.commit)).toContain(defective)
    expect(remainder.completeness.complete).toBe(true)
  })
})
