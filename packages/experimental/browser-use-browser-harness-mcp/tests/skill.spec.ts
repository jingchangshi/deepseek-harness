/**
 * Browser Harness skill bridge: the upstream `skill` document is published
 * through the existing `ctx.skills` registry, and its absence degrades quietly.
 */
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { parseSkillDocument, registerBrowserHarnessSkill } from '../src/skill.ts'

/** A genuine upstream document, shaped exactly like `browser-harness skill`. */
const UPSTREAM = `---
name: browser-harness
description: "Control a real browser via CDP: clicking, typing, navigation."
---

# browser-harness

Direct browser control via CDP.
`

/** Stand-in CLI: a real Node process running the fixture script. */
const fixtureScript = fileURLToPath(new URL('./fixtures/skill-command.mjs', import.meta.url))

const mounted: Context[] = []
afterEach(async () => {
  for (const ctx of mounted.splice(0)) await ctx.fiber.dispose()
})

/**
 * Mount the skill registry with the stand-in CLI.
 * @param env - fixture controls: `BH_SKILL_FIXTURE` document, or `BH_SKILL_FAIL=1`.
 * @param command - executable to run; defaults to the real Node binary.
 */
async function mountWith(env: Record<string, string>, command = process.execPath): Promise<Context> {
  const ctx = new Context()
  mounted.push(ctx)
  await ctx.plugin(SkillRegistry)
  registerBrowserHarnessSkill(ctx, { command, args: command === process.execPath ? [fixtureScript] : [], env })
  return ctx
}

describe('parseSkillDocument', () => {
  it('reads the upstream frontmatter and keeps the body verbatim', () => {
    const parsed = parseSkillDocument(UPSTREAM)
    expect(parsed?.frontmatter.name).toBe('browser-harness')
    expect(parsed?.frontmatter.description).toContain('Control a real browser')
    // The body is upstream documentation; it must survive unmodified.
    expect(parsed?.body).toContain('# browser-harness')
    expect(parsed?.body).toContain('Direct browser control via CDP.')
    expect(parsed?.body.startsWith('---')).toBe(false)
  })

  it('carries an optional when_to_use through to the candidate', () => {
    const parsed = parseSkillDocument(`---
name: browser-harness
description: "d"
when_to_use: "When a page needs interaction."
---
body
`)
    expect(parsed?.frontmatter.whenToUse).toBe('When a page needs interaction.')
  })

  it.each([
    ['no frontmatter', '# just a body'],
    ['unparseable yaml', '---\nname: [unclosed\n---\nbody'],
    ['missing name', '---\ndescription: "d"\n---\nbody'],
    ['non-kebab name', '---\nname: Browser Harness\ndescription: "d"\n---\nbody'],
    ['missing description', '---\nname: browser-harness\n---\nbody'],
    ['blank description', '---\nname: browser-harness\ndescription: "  "\n---\nbody'],
  ])('rejects a document with %s', (_label, text) => {
    expect(parseSkillDocument(text)).toBeUndefined()
  })
})

describe('registerBrowserHarnessSkill', () => {
  it('publishes the upstream skill through the existing registry', async () => {
    const ctx = await mountWith({ BH_SKILL_FIXTURE: UPSTREAM })
    const listed = await ctx.skills.list()
    const entry = listed.find(candidate => candidate.name === 'browser-harness')
    expect(entry).toBeDefined()
    expect(entry?.description).toContain('Control a real browser')
    expect(entry?.source).toBe('custom')
    expect(entry?.invocation).toEqual({ modelInvocable: true, userInvocable: true })

    // The body loads through the same path every other skill uses.
    const definition = await ctx.skills.get('browser-harness')
    expect(definition?.content).toContain('Direct browser control via CDP.')
  })

  it('yields no candidate when the executable is missing', async () => {
    const ctx = await mountWith({ BH_SKILL_FIXTURE: UPSTREAM }, 'definitely-not-installed-browser-harness')
    const listed = await ctx.skills.list()
    expect(listed.some(candidate => candidate.name === 'browser-harness')).toBe(false)
  })

  it('yields no candidate when the command fails', async () => {
    const ctx = await mountWith({ BH_SKILL_FAIL: '1' })
    const listed = await ctx.skills.list()
    expect(listed.some(candidate => candidate.name === 'browser-harness')).toBe(false)
  })

  it('yields no candidate when the executable prints nothing', async () => {
    const ctx = await mountWith({})
    const listed = await ctx.skills.list()
    expect(listed.some(candidate => candidate.name === 'browser-harness')).toBe(false)
  })

  it('yields no candidate when the document is unusable', async () => {
    const ctx = await mountWith({ BH_SKILL_FIXTURE: 'not a skill document' })
    const listed = await ctx.skills.list()
    expect(listed.some(candidate => candidate.name === 'browser-harness')).toBe(false)
  })

  it('drops the skill again when the registration is disposed', async () => {
    const ctx = new Context()
    mounted.push(ctx)
    await ctx.plugin(SkillRegistry)
    const dispose = registerBrowserHarnessSkill(ctx, {
      command: process.execPath,
      args: [fixtureScript],
      env: { BH_SKILL_FIXTURE: UPSTREAM },
    })
    expect((await ctx.skills.list()).some(c => c.name === 'browser-harness')).toBe(true)
    dispose()
    expect((await ctx.skills.list()).some(c => c.name === 'browser-harness')).toBe(false)
  })
})
