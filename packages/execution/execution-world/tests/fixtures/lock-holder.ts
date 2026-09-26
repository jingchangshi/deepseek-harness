import { withAllocationLock } from '../../src/allocation-lock.ts'

const path = process.argv[2]
if (path === undefined) throw new Error('Missing allocation lock path')
await withAllocationLock(path, 30_000, new AbortController().signal, async () => {
  process.send?.({ kind: 'held' })
  await new Promise<void>((resolve) => { process.once('message', () => { resolve() }) })
})
process.disconnect?.()
