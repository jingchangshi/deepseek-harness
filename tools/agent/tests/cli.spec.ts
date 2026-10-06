import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const temporaryRoots: string[] = []
const entry = resolve('tools/agent/agentctl.mjs')

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-cli-'))
  temporaryRoots.push(root)
  return root
}

async function run(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execute(process.execPath, [entry, ...args, '--root', root], {
    cwd: resolve('.'),
    env: process.env,
  })
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('agentctl process entry', () => {
  it('initializes a missing target directory with an explicit repository preset', async () => {
    const parent = await workspace()
    const root = join(parent, 'new-repository')
    await expect(run(root, ['init', '--preset', 'ascendnpu-ir'])).resolves.toMatchObject({ stderr: '' })
    expect(JSON.parse(await readFile(join(root, '.agent/preset.json'), 'utf8'))).toMatchObject({ id: 'ascendnpu-ir' })
    expect(await readFile(join(root, '.agent/config/project.yaml'), 'utf8')).toContain('.agent/config/commands.yaml')
  })

  it('initializes, creates, and reads a task through the public CLI', async () => {
    const root = await workspace()
    await expect(run(root, ['init'])).resolves.toMatchObject({ stderr: '' })
    await expect(readFile(join(root, '.agent/config/models.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, '.agent/profiles/compiler.yaml'), 'utf8')).resolves.toContain('id: compiler')
    await expect(readFile(join(root, '.agent/schemas/task.schema.json'), 'utf8')).resolves.toContain('createdAt')
    const created = await run(root, [
      'new',
      'cli-task',
      '--title',
      'CLI task',
      '--profile',
      'webapp',
      '--data-class',
      'internal',
    ])
    expect(JSON.parse(created.stdout)).toMatchObject({ taskId: 'cli-task', state: 'NEW', revision: 0 })
    const status = await run(root, ['status', 'cli-task'])
    expect(JSON.parse(status.stdout)).toMatchObject({ taskId: 'cli-task', state: 'NEW', revision: 0 })
  })

  it('does not replace project-owned configuration during initialization', async () => {
    const root = await workspace()
    const configPath = join(root, '.agent/config/models.yaml')
    await run(root, ['init'])
    await writeFile(configPath, 'project-owned: true\n')
    await run(root, ['init'])
    await expect(readFile(configPath, 'utf8')).resolves.toBe('project-owned: true\n')
  })

  it('returns a nonzero process result for an illegal invocation', async () => {
    const root = await workspace()
    await expect(run(root, ['unknown'])).rejects.toMatchObject({ code: 1 })
  })
})
