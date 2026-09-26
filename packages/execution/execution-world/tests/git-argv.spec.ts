import { describe, expect, it } from 'vitest'
import { validateGitArgv } from '../src/git-argv.ts'

const prefix = ['--no-optional-locks', '-c', 'core.fsmonitor=false'] as const
const valid = (...args: string[]) => { validateGitArgv([...prefix, ...args], '/dev/null'); return true }
const diff = (...args: string[]) => valid('diff', '--no-ext-diff', '--no-textconv', ...args)

describe('fixed Git argv validation', () => {
  it('accepts the consumer read-only commands', () => {
    expect(() => valid('rev-parse', '--verify', 'HEAD')).not.toThrow()
    expect(() => valid('status', '--porcelain=v1', '-z', '--untracked-files=all')).not.toThrow()
    expect(() => valid('rev-list', '--left-right', '--count', 'HEAD...@{u}')).not.toThrow()
    expect(() => valid('log', '--max-count=50', '--pretty=format:%H %s')).not.toThrow()
    expect(() => diff('HEAD', '--', ':(literal)src/file.ts')).not.toThrow()
    expect(() => diff(':(literal)src/file.ts')).not.toThrow()
    expect(() => diff('--cached')).not.toThrow()
    expect(() => diff('--no-index', '--', '/dev/null', 'src/new.ts')).not.toThrow()
  })

  it('rejects arbitrary commands and unsafe pathspecs', () => {
    expect(() => valid('diff', 'HEAD')).toThrow()
    expect(() => diff('--no-index', '--', '/dev/null', 'src/../../outside')).toThrow()
    expect(() => valid('show', 'HEAD')).toThrow()
    expect(() => diff('HEAD', '--', ':(top)src/file.ts')).toThrow('pathspec')
    expect(() => diff('HEAD', '--', ':(literal)../secret')).toThrow('pathspec')
    expect(() => diff('HEAD', '--', ':(literal)src/../secret')).toThrow('pathspec')
    expect(() => diff('HEAD', '--', ':(literal)C:/secret')).toThrow('pathspec')
    expect(() => valid('diff', 'HEAD', '--', ':(literal)src\\secret')).toThrow()
    expect(() => { validateGitArgv(['git', ...prefix, 'status', '--porcelain=v1', '-z'], '/dev/null') }).toThrow()
  })
})
