/** Typed Cordis plugin exports for the query-spill retrieval fixture. */
import type { Context } from '@deepseek-ai/cordis'

/** Scenario-local plugin identifier. */
export const name: 'query-spill-read-path'
/** Runtime services used to resolve stable spill locators. */
export const inject: string[]

/**
 * Translate the fixture locator before the local spill store reads it.
 * @param ctx - profile context with the spill store and filesystem providers.
 */
export function apply(ctx: Context): void
