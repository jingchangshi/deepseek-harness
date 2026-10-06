/** Regression tests for Markdown wrapping exclusions and corpus discovery. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isMdWrapExcluded, scanMdWrap } from './verify-md-wrap.ts'

describe('Markdown wrapping exemptions', () => {
  it.each(['arch-1006', 'goal-1006'])('exempts only the exact %s input with either separator', (stem) => {
    const file = `docs/software-engineering-harness/${stem}.md`
    expect(isMdWrapExcluded(file)).toBe(true)
    expect(isMdWrapExcluded(file.replaceAll('/', '\\'))).toBe(true)
    for (const suffix of ['.zh.md', '.i18n.yaml', '.md.backup']) {
      expect(isMdWrapExcluded(`docs/software-engineering-harness/${stem}${suffix}`)).toBe(false)
    }
    expect(isMdWrapExcluded(`docs/software-engineering-harness/nested/${stem}.md`)).toBe(false)
  })

  it.each([
    'docs/software-engineering-harness/architecture.md',
    'docs/software-engineering-harness/scoped-verification.md',
    'docs/software-engineering-harness/arch-10060.md',
    'docs/software-engineering-harness/goal-1006-extra.md',
    'docs/other/goal-1006.md',
    '.agents/notes/implemented/process/current.md',
  ])('keeps %s subject to wrapping checks', (file) => {
    expect(isMdWrapExcluded(file)).toBe(false)
  })

  it('keeps archived Agent Notes exempt with either separator', () => {
    const file = '.agents/notes/archived/process/history.md'
    expect(isMdWrapExcluded(file)).toBe(true)
    expect(isMdWrapExcluded(file.replaceAll('/', '\\'))).toBe(true)
  })

  it('reports hard-wrapped neighbors and every existing corpus class without reading exempt inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-md-wrap-'))
    try {
      const admitted = [
        'README.md', 'README.zh.md', 'AGENTS.md', 'packages/AGENTS.md', 'snapshots/AGENTS.md',
        'docs/software-engineering-harness/architecture.md',
        'docs/software-engineering-harness/arch-10060.md',
        'docs/software-engineering-harness/goal-1006-extra.md',
        'docs/software-engineering-harness/nested/goal-1006.md',
        '.agents/notes/implemented/process/current.md',
        'packages/example/README.md', 'packages/core/example/README.md',
        'snapshots/example/system-prompt.expected.md',
        'packages/core/example/tests/system-prompt.expected.md',
      ]
      const excluded = [
        'docs/software-engineering-harness/arch-1006.md',
        'docs/software-engineering-harness/goal-1006.md',
        '.agents/notes/archived/process/history.md',
      ]
      for (const file of [...admitted, ...excluded]) {
        const path = join(root, file)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, '# Guidance\n\nFirst prose line\nsecond prose line.\n')
      }
      const result = scanMdWrap(root)
      expect(result.checked).toBe(admitted.length)
      expect(result.violations).toHaveLength(admitted.length)
      expect(result.violations.map(violation => violation.file).sort()).toEqual([...admitted].sort())
      for (const violation of result.violations) {
        expect(violation.line).toBe(3)
        expect(violation.text).toBe('First prose line')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
