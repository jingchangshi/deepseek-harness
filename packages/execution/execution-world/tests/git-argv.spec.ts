import { describe, expect, it } from 'vitest'
import { validateGitArgv } from '../src/git-argv.ts'

const prefix = ['--no-optional-locks', '-c', 'core.fsmonitor=false'] as const
const valid = (...args: string[]) => validateGitArgv([...prefix, ...args], '/dev/null')

describe('fixed Git argv validation', () => {
  it('accepts the consumer read-only commands', () => {
    expect(() => valid('rev-parse', '--verify', 'HEAD')).not.toThrow()
    expect(() => valid('status', '--porcelain=v1', '-z')).not.toThrow()
    expect(() => valid('rev-list', '--left-right', '--count', 'HEAD...@{u}')).not.toThrow()
    expect(() => valid('log', '--max-count=50', '--pretty=format:%H %s')).not.toThrow()
    expect(() => valid('diff', 'HEAD', '--', ':(literal)src/file.ts')).not.toThrow()
    expect(() => valid('diff', ':(literal)src/file.ts')).not.toThrow()
    expect(() => valid('diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', 'src/new.ts')).not.toThrow()
  })

  it('rejects arbitrary commands and unsafe pathspecs', () => {
    expect(() => valid('show', 'HEAD')).toThrow()
    expect(() => valid('diff', 'HEAD', '--', ':(top)src/file.ts')).toThrow()
    expect(() => valid('diff', 'HEAD', '--', ':(literal)../secret')).toThrow()
    expect(() => valid('diff', 'HEAD', '--', ':(literal)src/../secret')).toThrow()
    expect(() => valid('diff', 'HEAD', '--', ':(literal)C:/secret')).toThrow()
    expect(() => valid('diff', 'HEAD', '--', ':(literal)src\\secret')).toThrow()
    expect(() => validateGitArgv(['git', ...prefix, 'status', '--porcelain=v1', '-z'], '/dev/null')).toThrow()
  })
})
