import { join } from 'node:path'
import { open } from './harness.ts'

const root = process.argv[2]
if (root === undefined) throw new Error('Missing test storage root')
process.send?.({ kind: 'starting' })
const harness = await open(root)
try {
  const workspaceId = await harness.ctx.executionWorldIdentity.resolve(join(root, 'workspace'))
  process.stdout.write(JSON.stringify({ workspaceId, pid: process.pid }) + '\n')
  process.send?.({ kind: 'identity', workspaceId })
} finally {
  await harness.close()
}
