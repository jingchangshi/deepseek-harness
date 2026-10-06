/** One-time local installation; applications still launch exclusively through dsh profiles. */
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

await import('tsx/esm')
const { installEngineeringProfiles, installEngineeringProject, preflightEngineeringInstallation, preflightEngineeringProfiles } = await import('./src/installation.ts')
const { verifyFreeze } = await import('./src/freeze.ts')
const checkout = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
const flags = new Map()
try {
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!['--root', '--home', '--bin-dir', '--preset'].includes(key) || value === undefined || value.startsWith('--')) {
      throw new Error('usage: node tools/agent/install.mjs [--root <project>] [--preset <id>] [--home <dsh-home>] [--bin-dir <directory>]')
    }
    flags.set(key, value)
  }
  if (flags.has('--preset') && !flags.has('--root')) throw new Error('--preset requires --root')
  await verifyFreeze(checkout)
  const options = {
    checkout,
    home: resolve(flags.get('--home') ?? process.env.DSH_HOME ?? resolve(homedir(), '.dsh')),
    binDirectory: resolve(flags.get('--bin-dir') ?? resolve(homedir(), '.local/bin')),
    node: process.execPath,
  }
  let projectFiles = []
  if (flags.has('--root')) {
    const projectOptions = { ...options, project: resolve(flags.get('--root')), preset: flags.get('--preset') }
    await preflightEngineeringInstallation(projectOptions)
    projectFiles = await installEngineeringProject(projectOptions)
  } else {
    await preflightEngineeringProfiles(options)
  }
  const userFiles = await installEngineeringProfiles(options)
  process.stdout.write(JSON.stringify({ projectFiles, userFiles, interactive: 'dsh engineering', oneShot: 'dsh engineering-run "request"' }, null, 2) + '\n')
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
