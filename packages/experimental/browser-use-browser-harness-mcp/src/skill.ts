/**
 * Publish Browser Harness' own usage skill through the DSH skill registry.
 *
 * `browser-harness skill` prints a complete `SKILL.md` — YAML frontmatter plus
 * body — that teaches the model when a browser is warranted and how to drive the
 * harness. This module registers ONE skill with the existing DSH skill registry,
 * so it reaches the model through the same catalog, ranking, and loader as every
 * filesystem or bundled skill. No second skill loader exists.
 *
 * The registry is passed in rather than read from `ctx` because `skills` is
 * optional for this provider: declaring it in `inject` would refuse activation
 * whenever a composition omits the skill service, while a bare `ctx.skills`
 * access is rejected for an undeclared service.
 *
 * The body is the upstream text verbatim. DSH parses the frontmatter and takes
 * the name, description, and optional metadata from it; rewriting the body would
 * fork upstream documentation.
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parse as parseYaml } from 'yaml'
import { isSkillName, type SkillCandidate, type SkillDefinition, type SkillLookupOptions, type SkillRegistry } from '@deepseek-ai/dsh-skill'

const run = promisify(execFile)

/** Rank below bundled providers so a user's own skill of the same name wins. */
const SKILL_RANK = 500

/** Bound the upstream command so a hung install cannot stall catalog discovery. */
const SKILL_TIMEOUT_MS = 30_000

/** Frontmatter the upstream skill must declare to be publishable. */
interface ParsedFrontmatter {
  name: string
  description: string
  whenToUse?: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * Split an upstream `SKILL.md` into its frontmatter fields and body.
 *
 * @param text - complete upstream skill document.
 * @returns the parsed fields and the remaining body, or undefined when the document is not a usable skill.
 */
export function parseSkillDocument(text: string): { frontmatter: ParsedFrontmatter; body: string } | undefined {
  const match = FRONTMATTER.exec(text)
  if (match === null) return undefined
  let parsed: unknown
  try {
    parsed = parseYaml(match[1] ?? '')
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const name = record.name
  const description = record.description
  if (typeof name !== 'string' || !isSkillName(name)) return undefined
  if (typeof description !== 'string' || description.trim() === '') return undefined
  return {
    frontmatter: {
      name,
      description,
      ...typeof record.when_to_use === 'string' ? { whenToUse: record.when_to_use } : {},
    },
    body: text.slice(match[0].length),
  }
}

/**
 * Run the upstream command that prints the skill document.
 *
 * A missing or failing executable yields undefined rather than throwing:
 * browser tooling is optional, and its absence must not break skill discovery
 * for every other provider.
 *
 * @param command - installed Browser Harness executable.
 * @param env - environment overrides carrying the configured home and daemon name.
 * @param signal - registration-scoped cancellation.
 * @returns the upstream document, or undefined when it could not be produced.
 */
async function readUpstreamSkill(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const { stdout } = await run(command, [...args, 'skill'], {
      env: { ...process.env, ...env },
      timeout: SKILL_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      signal,
    })
    return stdout
  } catch {
    return undefined
  }
}

/**
 * Register the Browser Harness usage skill on the existing skill registry.
 *
 * The document is read once per catalog discovery and cached by the registry,
 * so the upstream executable runs at most once per catalog generation.
 *
 * @param skills - the registry to publish on; passed in because the service is optional for this provider.
 * @param options - the installed command and any environment overrides.
 * @returns a disposer releasing the registration.
 */
export function registerBrowserHarnessSkill(
  skills: SkillRegistry,
  options: { command: string; args?: readonly string[]; env: Record<string, string> },
): () => void {
  const args = options.args ?? []
  return skills.registerProvider((control) => {
    /** Per-discovery cache; the registry may call `list` and `get` separately. */
    let cached: { candidate: SkillCandidate; body: string } | undefined
    let loaded = false

    /** Read the document once, remembering a definitive absence. */
    async function load(): Promise<{ candidate: SkillCandidate; body: string } | undefined> {
      if (!loaded) {
        loaded = true
        const text = await readUpstreamSkill(options.command, args, options.env, control.signal)
        if (text !== undefined) {
          const parsed = parseSkillDocument(text)
          if (parsed !== undefined) {
            cached = {
              candidate: {
                name: parsed.frontmatter.name,
                description: parsed.frontmatter.description,
                ...parsed.frontmatter.whenToUse === undefined ? {} : { whenToUse: parsed.frontmatter.whenToUse },
                invocation: { modelInvocable: true, userInvocable: true },
                source: 'custom',
                provider: 'browser-harness',
                rank: SKILL_RANK,
                locator: parsed.frontmatter.name,
              },
              body: parsed.body,
            }
          }
        }
      }
      return cached
    }

    return {
      name: 'browser-harness',
      list: async (_options: SkillLookupOptions) => {
        const entry = await load()
        return entry === undefined ? [] : [entry.candidate]
      },
      get: async (candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> => {
        const entry = await load()
        if (entry === undefined || entry.candidate.name !== candidate.name) return undefined
        return { ...entry.candidate, content: entry.body }
      },
    }
  })
}
