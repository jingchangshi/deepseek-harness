/** Resolve fixture-stable spill locators before the local spill reader opens them. */
export const name = 'query-spill-read-path'
export const inject = ['spillStore', 'fs']

/** Translate the snapshot's display locator back to the run's stored path. */
export function apply(ctx) {
  const store = ctx.spillStore
  const fs = ctx.fs
  const readText = store.readText
  ctx.effect(() => {
    store.readText = input => readText.call(store, {
      ...input,
      locator: fs.processPathFromHostPath(input.locator),
    })
    return () => { store.readText = readText }
  })
}
