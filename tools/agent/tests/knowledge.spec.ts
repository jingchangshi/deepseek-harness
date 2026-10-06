import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRepositoryKnowledge } from '../src/knowledge.ts'

const roots: string[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'engineering-knowledge-'))
  roots.push(root)
  await mkdir(join(root, '.agents/skills/example'), { recursive: true })
  await writeFile(join(root, 'CONTRIBUTING.md'), 'INSTRUCTION BODY\n')
  await writeFile(join(root, '.agents/skills/example/SKILL.md'), '---\nname: example\ndescription: Use for compiler changes.\n---\nSKILL BODY\n')
  await writeFile(join(root, 'knowledge.yaml'), dump({ schemaVersion: 1, instructionFiles: ['CONTRIBUTING.md'], skillRoots: ['.agents/skills'] }))
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

describe('repository knowledge discovery', () => {
  it('returns only instruction paths and skill frontmatter metadata', async () => {
    const root = await fixture()
    await mkdir(join(root, '.agents/skills/support'))
    expect(await loadRepositoryKnowledge(root, 'knowledge.yaml')).toEqual({ instructionFiles: ['CONTRIBUTING.md'], skills: [{ name: 'example', description: 'Use for compiler changes.', path: '.agents/skills/example/SKILL.md' }] })
  })

  it.each(['../outside.md', '/absolute.md', 'C:\\outside.md', '.agents/../CONTRIBUTING.md', 'missing.md'])('rejects invalid or absent instruction %s', async path => {
    const root = await fixture()
    await writeFile(join(root, 'knowledge.yaml'), dump({ schemaVersion: 1, instructionFiles: [path], skillRoots: [] }))
    await expect(loadRepositoryKnowledge(root, 'knowledge.yaml')).rejects.toThrow()
  })

  it.each(['name: example', 'description: context', 'name: []\ndescription: context', 'name: example\ndescription: " "'])('rejects malformed discovered frontmatter %s', async frontmatter => {
    const root = await fixture()
    await writeFile(join(root, '.agents/skills/example/SKILL.md'), `---\n${frontmatter}\n---\nBody\n`)
    await expect(loadRepositoryKnowledge(root, 'knowledge.yaml')).rejects.toThrow(/skill/i)
  })

  it('rejects duplicate skill names in different roots', async () => {
    const root = await fixture()
    await mkdir(join(root, '.agents/other-skills/duplicate'), { recursive: true })
    await writeFile(join(root, '.agents/other-skills/duplicate/SKILL.md'), await readFile(join(root, '.agents/skills/example/SKILL.md'), 'utf8'))
    await writeFile(join(root, 'knowledge.yaml'), dump({ schemaVersion: 1, instructionFiles: [], skillRoots: ['.agents/skills', '.agents/other-skills'] }))
    await expect(loadRepositoryKnowledge(root, 'knowledge.yaml')).rejects.toThrow(/duplicate skill/i)
  })

  it.skipIf(process.platform === 'win32')('rejects a skill directory symlink outside the repository', async () => {
    const root = await fixture()
    const outside = await fixture()
    await symlink(join(outside, '.agents/skills/example'), join(root, '.agents/skills/external'))
    await expect(loadRepositoryKnowledge(root, 'knowledge.yaml')).rejects.toThrow(/inside.*repository/i)
  })

  it.each([
    { schemaVersion: 2, instructionFiles: [], skillRoots: [] },
    { schemaVersion: 1, instructionFiles: 'CONTRIBUTING.md', skillRoots: [] },
    { schemaVersion: 1, instructionFiles: [], skillRoots: ['missing'] },
    { schemaVersion: 1, instructionFiles: [], skillRoots: ['CONTRIBUTING.md'] },
  ])('rejects invalid configuration %j', async document => {
    const root = await fixture()
    await writeFile(join(root, 'knowledge.yaml'), dump(document))
    await expect(loadRepositoryKnowledge(root, 'knowledge.yaml')).rejects.toThrow()
  })
})
