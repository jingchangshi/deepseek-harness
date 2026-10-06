#!/usr/bin/env node

await import('tsx/esm')
const { runCli } = await import('./src/cli.ts')

try {
  process.exitCode = await runCli(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
