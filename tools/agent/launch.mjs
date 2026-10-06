/** Verify the pinned checkout before entering the supported DSH CLI. */
import { fileURLToPath } from 'node:url'

const checkout = fileURLToPath(new URL('../../', import.meta.url))
const { verifyFreeze } = await import('./src/freeze.ts')
await verifyFreeze(checkout)
const { runCli } = await import('../../apps/cli/src/bin.ts')
await runCli()
