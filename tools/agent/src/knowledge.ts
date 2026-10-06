/** Repository-local instruction and skill discovery without prompt body preloading. */

import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, posix, relative, resolve } from 'node:path'
import { load } from 'js-yaml'

/** Task-selectable repository skill; its body is read only on explicit role demand. */
export interface RepositorySkill {
  name: string
  description: string
  path: string
}

/** Model-visible repository-relative file references and skill metadata. */
export interface RepositoryKnowledge {
  instructionFiles: string[]
  skills: RepositorySkill[]
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be nonempty text`)
  return value
}

function paths(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  const result = value.map((entry, index) => text(entry, `${field}[${String(index)}]`))
  if (new Set(result).size !== result.length) throw new Error(`${field} contains duplicate paths`)
  return result
}

async function repositoryPath(root: string, path: string, kind: 'file' | 'directory'): Promise<string> {
  if (isAbsolute(path) || path.includes('\\') || posix.normalize(path) !== path || path.split('/').includes('..')) throw new Error(`knowledge path must be relative and inside the repository: ${path}`)
  const canonicalRoot = await realpath(root)
  const destination = await realpath(resolve(canonicalRoot, path))
  const local = relative(canonicalRoot, destination)
  if (isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) throw new Error(`knowledge path must stay inside the repository: ${path}`)
  const information = await stat(destination)
  if (kind === 'file' ? !information.isFile() : !information.isDirectory()) throw new Error(`knowledge ${kind} required: ${path}`)
  return destination
}

/**
 * Discover declared instructions and immediate child skills before role dispatch.
 * @param root - target repository directory.
 * @param configuration - repository-relative knowledge YAML declaration.
 * @returns instruction paths and sorted skill metadata, without Markdown bodies.
 */
export async function loadRepositoryKnowledge(root: string, configuration: string): Promise<RepositoryKnowledge> {
  const source: unknown = load(await readFile(await repositoryPath(root, configuration, 'file'), 'utf8'))
  if (typeof source !== 'object' || source === null || Array.isArray(source) || Reflect.get(source, 'schemaVersion') !== 1) throw new Error('invalid repository knowledge declaration')
  const instructionFiles = paths(Reflect.get(source, 'instructionFiles'), 'instructionFiles')
  const skillRoots = paths(Reflect.get(source, 'skillRoots'), 'skillRoots')
  for (const path of instructionFiles) await repositoryPath(root, path, 'file')
  const skills: RepositorySkill[] = []
  const names = new Set<string>()
  for (const skillRoot of skillRoots) {
    const directory = await repositoryPath(root, skillRoot, 'directory')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const child = posix.join(skillRoot, entry.name)
      await repositoryPath(root, child, 'directory')
      const path = posix.join(child, 'SKILL.md')
      let filename: string
      try {
        filename = await repositoryPath(root, path, 'file')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const content = await readFile(filename, 'utf8')
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1]
      const metadata: unknown = frontmatter === undefined ? undefined : load(frontmatter)
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) throw new Error(`invalid skill frontmatter: ${path}`)
      const name = text(Reflect.get(metadata, 'name'), `skill ${path} name`)
      const description = text(Reflect.get(metadata, 'description'), `skill ${path} description`)
      if (names.has(name)) throw new Error(`duplicate skill name: ${name}`)
      names.add(name)
      skills.push({ name, description, path })
    }
  }
  skills.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return { instructionFiles, skills }
}
