/** Closed validation for the fixed Git argv emitted by DSHWithChatGPT. */
const PREFIX = ['--no-optional-locks', '-c', 'core.fsmonitor=false'] as const

const safeRef = /^(?:HEAD|@\{u\}|HEAD\.\.\.@\{u\}|[0-9a-f]{7,64})$/u

function isSafeRelativePath(value: string): boolean {
  if (value === '' || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return false
  const parts = value.split('/')
  return parts.every(part => part !== '' && part !== '.' && part !== '..' && !part.includes(':'))
}

function assertSafePath(value: string): void {
  if (!value.startsWith(':(literal)') || !isSafeRelativePath(value.slice(':(literal)'.length))) throw new Error('Git pathspec is not a safe literal workspace path')
}

function assertSafeRef(value: string): void {
  if (!safeRef.test(value)) throw new Error('Git ref is not in the fixed read-only grammar')
}

function assertSafePathspecs(values: readonly string[]): void {
  for (const value of values) assertSafePath(value)
}
/** Validate one complete consumer Git argv, excluding the executable name.
 * @param argv - fixed Git arguments from the collaboration consumer.
 * @param emptyFile - provider-platform empty-file operand for no-index diff.
 */
export function validateGitArgv(argv: readonly string[], emptyFile: 'NUL' | '/dev/null'): void {
  if (argv.length < PREFIX.length || PREFIX.some((value, index) => argv[index] !== value)) throw new Error('Git argv prefix is not authorized')
  const args = argv.slice(PREFIX.length)
  const command = args[0]
  if (command === 'rev-parse') {
    const allowed = [['--verify', 'HEAD'], ['--is-inside-work-tree'], ['--abbrev-ref', 'HEAD'], ['--abbrev-ref', '--symbolic-full-name', '@{u}'], ['--verify', '@{u}']] as const
    const operands = args.slice(1)
    if (!allowed.some(candidate => candidate.length === operands.length && candidate.every((value, index) => operands[index] === value))) throw new Error('Git rev-parse argv is not authorized')
    return
  }
  if (command === 'rev-list') {
    if (args.length !== 4 || args[1] !== '--left-right' || args[2] !== '--count' || args[3] !== 'HEAD...@{u}') throw new Error('Git rev-list argv is not authorized')
    return
  }
  if (command === 'status') {
    if (args.length !== 4 || args[1] !== '--porcelain=v1' || args[2] !== '-z' || args[3] !== '--untracked-files=all') throw new Error('Git status argv is not authorized')
    return
  }
  if (command === 'log') {
    if (args.length !== 3 || args[1] === undefined || !/^--max-count=(?:[1-9]|[1-4][0-9]|50)$/u.test(args[1]) || args[2] !== '--pretty=format:%H %s') throw new Error('Git log argv is not authorized')
    return
  }
  if (command !== 'diff') throw new Error('Git subcommand is not authorized')
  if (args[1] !== '--no-ext-diff' || args[2] !== '--no-textconv') throw new Error('Git diff must disable external drivers')
  const diffArgs = args.slice(3)
  if (diffArgs.length === 0 || (diffArgs.length === 1 && diffArgs[0] === '--cached')) return
  if (diffArgs[0] === '--no-index') {
    if (diffArgs.length !== 4 || diffArgs[1] !== '--' || diffArgs[2] !== emptyFile
      || diffArgs[3] === undefined || !isSafeRelativePath(diffArgs[3])) throw new Error('Git no-index argv is not authorized')
    return
  }
  if (diffArgs.length < 1 || diffArgs.length > 52) throw new Error('Git diff argv is not authorized')
  const refMode = diffArgs[0]
  if (refMode === undefined) throw new Error('Git diff argv is not authorized')
  const separator = diffArgs.indexOf('--')
  if (separator >= 0) {
    if (separator !== 1) throw new Error('Git diff separator is not authorized')
    assertSafeRef(refMode)
    assertSafePathspecs(diffArgs.slice(2))
  } else if (refMode.startsWith(':(literal)')) {
    assertSafePathspecs(diffArgs)
  } else {
    assertSafeRef(refMode)
    assertSafePathspecs(diffArgs.slice(1))
  }
}
