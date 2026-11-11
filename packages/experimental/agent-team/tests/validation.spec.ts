import { describe, expect, it } from 'vitest'
import { TeamError } from '../src/error.ts'
import { requiredText, writeScope } from '../src/validation.ts'

/**
 * The exact scope from session 757fa075, seq 587: an absolute path under a
 * sibling worktree that the Lead passed as a write scope. The whole batch of
 * four task creations was lost to this one value, so it is pinned here.
 */
const SESSION_ABSOLUTE_SCOPE = '/home/s00653124/workspace/TileFoundry_p3_02/targets/ascend/tilefoundry_ascend/plan/resolved_plan.py'

/** Capture the typed refusal so a test can assert code and message separately. */
function refusal(run: () => unknown): TeamError {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof TeamError) return error
    throw error
  }
  throw new Error('expected the write scope to be refused')
}

describe('writeScope', () => {
  it('normalizes an accepted session-relative prefix', () => {
    expect(writeScope('targets/ascend/tests/')).toBe('targets/ascend/tests')
    expect(writeScope('./src/feature.ts')).toBe('src/feature.ts')
    expect(writeScope('  src\\feature.ts  ')).toBe('src/feature.ts')
  })

  it('refuses the absolute path a real session supplied, and names the accepted form', () => {
    const error = refusal(() => writeScope(SESSION_ABSOLUTE_SCOPE))
    expect(error.code).toBe('TEAM_INVALID_WRITE_SCOPE')
    // The refusal must be actionable: the value, the reason, and the accepted form.
    expect(error.message).toContain(JSON.stringify(SESSION_ABSOLUTE_SCOPE))
    expect(error.message).toContain('an absolute path is not storable')
    expect(error.message).toContain('session-relative file or directory prefixes')
    expect(error.message).toContain('the Team tools convert an absolute path that lies inside the session workspace')
  })

  it('refuses a drive-letter path without claiming it is relative', () => {
    const error = refusal(() => writeScope('C:/work/src'))
    expect(error.code).toBe('TEAM_INVALID_WRITE_SCOPE')
    expect(error.message).toContain('an absolute path is not storable')
  })

  it('refuses traversal instead of silently resolving it', () => {
    const error = refusal(() => writeScope('../TileFoundry_p3_02/plan'))
    expect(error.code).toBe('TEAM_INVALID_WRITE_SCOPE')
    expect(error.message).toContain('an empty, "." or ".." segment')
    expect(error.message).toContain('e.g. "targets/ascend/plan"')
  })

  it('refuses an empty scope with a distinct reason', () => {
    const blank = refusal(() => writeScope('   '))
    const root = refusal(() => writeScope('/'))
    expect(blank.code).toBe('TEAM_INVALID_WRITE_SCOPE')
    expect(blank.message).toContain('it names no path')
    expect(root.code).toBe('TEAM_INVALID_WRITE_SCOPE')
  })

  it('reports every refusal under the same stable code', () => {
    for (const value of [SESSION_ABSOLUTE_SCOPE, '../x', '', '.', 'src//x']) {
      expect(refusal(() => writeScope(value)).code).toBe('TEAM_INVALID_WRITE_SCOPE')
    }
  })
})

describe('requiredText', () => {
  it('trims and rejects blank or over-long input with TEAM_INVALID_ARGUMENT', () => {
    expect(requiredText('  keep  ', 'subject', 10)).toBe('keep')
    expect(refusal(() => requiredText('   ', 'subject', 10)).code).toBe('TEAM_INVALID_ARGUMENT')
    expect(refusal(() => requiredText('toolongvalue', 'subject', 4)).code).toBe('TEAM_INVALID_ARGUMENT')
  })
})
