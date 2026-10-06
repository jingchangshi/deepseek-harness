/**
 * Reject Markdown prose paragraphs spanning multiple physical lines. The GFM
 * AST distinguishes paragraphs—including those in lists and blockquotes—from
 * multiline structural nodes. The checker never rewrites; symlinked instruction
 * files are deduped. VitePress frontmatter and custom-container delimiters are
 * masked before parsing. The owning convention is in `docs/AGENTS.md`.
 */

import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Nodes } from 'mdast'
import { parseMarkdown, visitMarkdown } from './markdown.ts'
import { isArchivedAgentNotePath, uniqueRepoFiles } from './repo-files.ts'

const root = resolve(import.meta.dirname, '..')

/** Files to check: doc-typecheck's scope, system-prompt expected outputs, and the AGENTS.md pair. */
const PATTERNS = [
  'README.md',
  'README.zh.md',
  '.agents/notes/**/*.md',
  'docs/**/*.md',
  'packages/*/*.md',
  'packages/*/*/*.md',
  'snapshots/**/system-prompt.expected.md',
  'packages/**/system-prompt.expected.md',
  'AGENTS.md',
  'packages/AGENTS.md',
  'snapshots/AGENTS.md',
]

const TEMPORARY_GUIDANCE_PATHS = new Set([
  'docs/software-engineering-harness/arch-1006.md',
  'docs/software-engineering-harness/goal-1006.md',
])

/**
 * Exempt frozen Agent Notes and the two temporary guidance inputs from wrapping checks.
 * @param file - Repository-relative path; platform separators are accepted.
 * @returns Whether the file is exempt from wrapping checks.
 */
export function isMdWrapExcluded(file: string): boolean {
  const normalized = file.replaceAll('\\', '/')
  return isArchivedAgentNotePath(normalized) || TEMPORARY_GUIDANCE_PATHS.has(normalized)
}

/** A located hard-wrap: a prose paragraph spanning more than one source line. */
interface Violation {
  file: string
  /** 1-based line where the hard-wrapped paragraph starts. */
  line: number
  text: string
}

function maskVitePressStructure(source: string): string {
  const lines = source.split('\n')
  if (lines[0] === '---') {
    const closing = lines.indexOf('---', 1)
    if (closing !== -1) {
      for (let index = 0; index <= closing; index++) lines[index] = ''
    }
  }
  return lines.map(line => line.trimStart().startsWith(':::') ? '' : line).join('\n')
}

/** Find every hard-wrapped prose paragraph in one Markdown file via its AST. */
function findViolations(repoRoot: string, absPath: string): Violation[] {
  const file = relative(repoRoot, absPath).replaceAll('\\', '/')
  const source = readFileSync(absPath, 'utf8')
  const parsedSource = maskVitePressStructure(source)
  const tree = parseMarkdown(parsedSource)
  const out: Violation[] = []

  visitMarkdown(tree, (node: Nodes): boolean | void => {
    if (node.type === 'paragraph' && node.position) {
      const { start, end } = node.position
      if (end.line > start.line) {
        const firstLine = source.split('\n')[start.line - 1] ?? ''
        out.push({ file, line: start.line, text: firstLine.trim() })
      }
      // Paragraph children are inline, so no further paragraph can be nested.
      return false
    }
  })
  return out
}

/**
 * Scan the maintained Markdown corpus without rewriting files.
 * @param repoRoot - Absolute repository root.
 * @returns Checked file count and hard-wrapped prose locations after exclusions and symlink deduplication.
 */
export function scanMdWrap(repoRoot: string): { checked: number; violations: Violation[] } {
  const files = uniqueRepoFiles(repoRoot, PATTERNS, isMdWrapExcluded)
  return { checked: files.length, violations: files.flatMap(file => findViolations(repoRoot, file.abs)) }
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  const { checked, violations } = scanMdWrap(root)
  if (violations.length === 0) {
    console.log(`verify-md-wrap: ${checked} file(s) checked, no hard-wrapped prose paragraphs.`)
  } else {
    console.error('verify-md-wrap: hard-wrapped prose paragraphs found (write one physical line per paragraph):')
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line}  ${violation.text.slice(0, 80)}${violation.text.length > 80 ? '…' : ''}`)
    }
    process.exitCode = 1
  }
}
