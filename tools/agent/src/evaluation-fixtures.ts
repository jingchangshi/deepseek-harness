/** Immutable synthetic engineering cases and supervisor-owned acceptance oracles. */

import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dump } from 'js-yaml'
import type { EngineeringBenchmarkCase, EngineeringOracleResult, EngineeringStageReceipt } from './benchmark.ts'
import type { GitReviewTarget } from './git-evidence.ts'
import { TaskRepository } from './repository.ts'

const here = fileURLToPath(new URL('../tests/fixtures/', import.meta.url))
const evaluation = join(here, 'evaluation')
const compilerFixture = join(here, 'third-compiler/repository')

interface FixtureManifest {
  id: string
  kind: EngineeringBenchmarkCase['kind']
  request: string
  criteria: string
  allowedPaths: string[]
  commandProfile: string
  copy(root: string): Promise<void>
  failureInjection?: unknown
}

const manifests: readonly FixtureManifest[] = [
  {
    id: 'pebble-mul', kind: 'compiler', request: 'Repair Pebble multiplication and keep stack and register output equivalent',
    criteria: 'Integer multiplication, both encodings, invalid SSA rejection', allowedPaths: ['compiler/pebble.mjs'], commandProfile: 'pebble/check.mjs',
    async copy(root) {
      await cp(join(compilerFixture, 'compiler'), join(root, 'compiler'), { recursive: true })
      await cp(join(compilerFixture, 'programs'), join(root, 'programs'), { recursive: true })
      await cp(join(compilerFixture, '.gitignore'), join(root, '.gitignore'))
      await cp(join(compilerFixture, 'COMPILER.md'), join(root, 'COMPILER.md'))
    },
  },
  {
    id: 'mlir-pass', kind: 'mlir', request: 'Rewrite add of a right-side zero to its input in MLIR while preserving nonzero additions',
    criteria: 'Exact identity rewrite, nonzero and idempotence regressions, pinned MLIR grammar verifier when configured', allowedPaths: ['pass.mjs'], commandProfile: 'mlir/check.mjs',
    async copy(root) { await cp(join(evaluation, 'mlir'), root, { recursive: true }) },
  },
  {
    id: 'review-overflow', kind: 'review', request: 'Review the pinned addition commit and report the introduced signed overflow',
    criteria: 'Finding identifies add.mjs line 2, target commit and signed overflow trigger', allowedPaths: [], commandProfile: 'pinned-git-review',
    async copy(root) {
      await writeFile(join(root, '.gitignore'), '.agent/\n')
      await writeFile(join(root, 'add.mjs'), 'export function add(left, right) {\n  return (left + right) | 0\n}\n')
    },
  },
  {
    id: 'recovery-latch', kind: 'recovery', request: 'Write answer.txt containing exactly 42 after the first injected failure',
    criteria: 'First invocation fails before write; later source equals 42', allowedPaths: ['answer.txt'], commandProfile: 'independent-source-oracle',
    failureInjection: { id: 'fail-first-implementer-before-write', role: 'implementer', invocation: 1, effect: 'throw-before-mutation' },
    async copy(root) { await cp(join(evaluation, 'recovery/answer.txt'), join(root, 'answer.txt')) },
  },
]

const mlirOpt = process.env.DSH_EVALUATION_MLIR_OPT

/** Create fresh, deterministic Git seeds for every registered case. */
export async function createEngineeringEvaluationCases(checkout: string): Promise<EngineeringBenchmarkCase[]> {
  const rootCheckout = resolve(checkout)
  const pinnedMlir = await readPinnedMlir()
  const cases: EngineeringBenchmarkCase[] = []
  for (const manifest of manifests) {
    const run = async (root: string): Promise<void> => {
      await mkdir(root, { recursive: true })
      await manifest.copy(root)
      await ensureAgentIgnored(root)
      if (manifest.kind === 'review') await makeReviewCommits(root)
      else {
        await git(root, ['init', '-q'])
        await git(root, ['add', '.'])
        await git(root, ['commit', '-qm', 'Immutable evaluation seed'])
      }
    }
    const temporary = await import('node:fs/promises').then(fs => fs.mkdtemp(join((process.env.TMPDIR ?? '/tmp'), 'dsh-evaluation-seed-')))
    try {
      await run(temporary)
      const seedSha = await git(temporary, ['rev-parse', 'HEAD'])
      const sourceDigest = await digestSource(temporary)
      cases.push({
        ...manifest, seedSha, sourceDigest,
        requestDigest: sha(manifest.request), criteriaDigest: sha(manifest.criteria),
        run,
        ...(manifest.id === 'review-overflow' ? { cleanControlSha: await git(temporary, ['rev-parse', 'HEAD^']) } : {}),
        ...(manifest.kind === 'mlir' ? { pinnedMlir: pinnedMlir ?? 'NOT_CONFIGURED' } : {}),
        checkout: rootCheckout,
      })
    } finally {
      await import('node:fs/promises').then(fs => fs.rm(temporary, { recursive: true, force: true }))
    }
  }
  return cases
}

/** Apply the fixed case oracle without trusting model claims or executor supplied acceptance. */
export async function engineeringEvaluationOracle(testCase: EngineeringBenchmarkCase, cwd: string, _receipts: readonly EngineeringStageReceipt[]): Promise<EngineeringOracleResult> {
  switch (testCase.id) {
    case 'pebble-mul': return runCommandOracle(testCase, cwd, join(evaluation, 'pebble/check.mjs'))
    case 'mlir-pass': return runMlirOracle(testCase, cwd)
    case 'review-overflow': return reviewResultOracle(testCase, cwd)
    case 'recovery-latch': return sourceOracle(testCase, cwd, 'answer.txt', '42\n')
    default: return { accepted: false, evidence: { reason: 'Unknown fixture ID' } }
  }
}

/** Verify the first implementation before any workflow repair stage runs. */
export async function engineeringFirstImplementationOracle(testCase: EngineeringBenchmarkCase, cwd: string): Promise<boolean> {
  if (testCase.kind === 'review') return reviewSourceVerification(testCase, cwd)
  return (await engineeringEvaluationOracle(testCase, cwd, [])).accepted
}

/** Resolve the immutable bad commit and its parent for the production Review-only workflow. */
export function evaluationReviewTarget(testCase: EngineeringBenchmarkCase): GitReviewTarget {
  if (testCase.id !== 'review-overflow' || typeof testCase.seedSha !== 'string') throw new Error(`case ${testCase.id} is not a pinned review fixture`)
  return { kind: 'commit', target: testCase.seedSha }
}

/** Initialize deterministic project verification files after the source seed identity is checked. */
export async function prepareEngineeringEvaluationRepository(testCase: EngineeringBenchmarkCase, cwd: string, checkout: string): Promise<void> {
  await ensureAgentIgnored(cwd)
  const repository = new TaskRepository(cwd, join(cwd, '.agent/schemas'), { templateRoot: join(resolve(checkout), '.agent') })
  await repository.init()
  const profile = `evaluation-${testCase.id}`
  await writeFile(join(cwd, '.agent/config/project.yaml'), dump({
    schemaVersion: 1, profile, adapter: '.agent/adapters/evaluation.yaml', dataClass: 'public', maxSteps: 12, maxRoleCalls: 12, commandTimeoutMs: 30_000,
    ...(testCase.kind === 'review' ? {} : { scheduling: {
      class: 'auto', scopePaths: [...testCase.allowedPaths as readonly string[]], acceptanceCriteria: [testCase.criteria],
      risks: [], needsInvestigation: false, needsChallenge: false,
    } }),
  }))
  await writeFile(join(cwd, `.agent/profiles/${profile}.yaml`), dump({ schemaVersion: 1, id: profile, checks: testCase.kind === 'review' ? [] : [
    { name: 'evaluation-oracle', category: 'source', scope: { case: testCase.id }, adapter: 'evaluation', required: true, timeoutMs: 30_000 },
  ] }))
  const executable = process.execPath
  const command = testCase.kind === 'compiler'
    ? { executable, args: [join(evaluation, 'pebble/check.mjs'), cwd] }
    : testCase.kind === 'mlir'
      ? { executable, args: [join(evaluation, 'mlir/check.mjs'), cwd] }
      : testCase.kind === 'recovery'
        ? { executable, args: ['-e', `import('node:fs').then(fs=>{if(fs.readFileSync(${JSON.stringify(join(cwd, 'answer.txt'))},'utf8')!=='42\\n')process.exit(2)})`] }
        : { executable, args: ['-e', 'process.exit(0)'] }
  await writeFile(join(cwd, '.agent/adapters/evaluation.yaml'), dump({
    adapters: { evaluation: {
      executable: command.executable,
      args: command.args,
      terminationTimeoutMs: 30_000,
    } },
  }))
}

async function runCommandOracle(testCase: EngineeringBenchmarkCase, cwd: string, command: string): Promise<EngineeringOracleResult> {
  const result = spawnSync(process.execPath, [command, cwd], { cwd, encoding: 'utf8' })
  const changed = await changedPaths(cwd, testCase.seedSha)
  const outOfScope = changed.filter(path => !(testCase.allowedPaths as readonly string[]).includes(path))
  return { accepted: result.status === 0 && outOfScope.length === 0, evidence: { command, exitCode: result.status, stderr: result.stderr, caseDigest: testCase.sourceDigest, changed, outOfScope } }
}

async function runMlirOracle(testCase: EngineeringBenchmarkCase, cwd: string): Promise<EngineeringOracleResult> {
  const result = await runCommandOracle(testCase, cwd, join(evaluation, 'mlir/check.mjs'))
  const pinnedMlir = await readPinnedMlir()
  if (!result.accepted || pinnedMlir === undefined) return { accepted: result.accepted, evidence: { ...result.evidence as object, verifier: pinnedMlir ?? 'NOT_RUN' } }
  const input = await readFile(join(cwd, 'input.mlir'), 'utf8')
  const expected = input.replace('    %sum = arith.addi %arg0, %zero : i32\n', '').replace('return %sum : i32', 'return %arg0 : i32')
  const verify = spawnSync(pinnedMlir.executable, ['--verify-each'], { input: expected, encoding: 'utf8' })
  return { accepted: verify.status === 0, evidence: { ...result.evidence as object, verifier: pinnedMlir, verifierExitCode: verify.status, verifierStderr: verify.stderr } }
}

async function sourceOracle(testCase: EngineeringBenchmarkCase, cwd: string, path: string, expected: string): Promise<EngineeringOracleResult> {
  const changed = await changedPaths(cwd, testCase.seedSha)
  const outOfScope = changed.filter(value => !(testCase.allowedPaths as readonly string[]).includes(value))
  const actual = await readFile(join(cwd, path), 'utf8').catch(() => '')
  return { accepted: outOfScope.length === 0 && actual === expected, evidence: { path, expected, changed, outOfScope } }
}

async function changedPaths(cwd: string, seedSha?: string): Promise<string[]> {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' })
  const working = status.split('\n').filter(Boolean).map(line => line.slice(3).trim())
  const fromSeed = seedSha === undefined ? '' : await git(cwd, ['diff', '--name-only', seedSha, 'HEAD'])
  return [...new Set([...working, ...fromSeed.split('\n').filter(Boolean)])].sort()
}

async function reviewSourceVerification(testCase: EngineeringBenchmarkCase, cwd: string): Promise<boolean> {
  const cleanSha = Reflect.get(testCase, 'cleanControlSha')
  if (typeof cleanSha !== 'string') return false
  const bad = execFileSync('git', ['show', `${testCase.seedSha}:add.mjs`], { cwd, encoding: 'utf8' })
  const clean = execFileSync('git', ['show', `${cleanSha}:add.mjs`], { cwd, encoding: 'utf8' })
  return await additionResult(bad, 2147483647, 1) === -2147483648 && await additionResult(clean, 2147483647, 1) === 2147483648
}

async function reviewResultOracle(testCase: EngineeringBenchmarkCase, cwd: string): Promise<EngineeringOracleResult> {
  const dirs = await readdir(join(cwd, '.agent/reviews')).catch(() => [])
  const reports = await Promise.all(dirs.map(async id => readFile(join(cwd, '.agent/reviews', id, 'RESULT.json'), 'utf8').then(JSON.parse).catch(() => undefined)))
  const report = reports.find(value => typeof value === 'object' && value !== null && Array.isArray(Reflect.get(value, 'findings')))
  if (report === undefined) return { accepted: false, evidence: { reason: 'No durable review result' } }
  if (Reflect.get(report, 'status') !== 'REVIEW_COMPLETE') return { accepted: false, evidence: { reason: 'Review is not durably complete' } }
  const targetCommit = testCase.seedSha
  const snapshot = Reflect.get(report, 'snapshot')
  const snapshotTarget = typeof snapshot === 'object' && snapshot !== null ? Reflect.get(snapshot, 'targetCommit') : undefined
  const cleanCommitSha = Reflect.get(testCase, 'cleanControlSha')
  let pinnedBugVerified = false
  let cleanControlVerified = false
  if (typeof cleanCommitSha === 'string') {
    const cleanFile = spawnSync('git', ['show', `${cleanCommitSha}:add.mjs`], { cwd, encoding: 'utf8' })
    const badFile = spawnSync('git', ['show', `${targetCommit}:add.mjs`], { cwd, encoding: 'utf8' })
    pinnedBugVerified = badFile.status === 0 && await additionResult(badFile.stdout, 2147483647, 1) === -2147483648
    cleanControlVerified = cleanFile.status === 0 && await additionResult(cleanFile.stdout, 2147483647, 1) === 2147483648
  }
  const findings: unknown[] = Reflect.get(report, 'findings')
  const evidence: unknown[] = Array.isArray(Reflect.get(report, 'evidence')) ? Reflect.get(report, 'evidence') : []
  const inspectedIds = Array.isArray(Reflect.get(report, 'inspectedEvidenceIds')) ? Reflect.get(report, 'inspectedEvidenceIds') as unknown[] : []
  const evidenceById = new Map(evidence.flatMap(item => {
    if (typeof item !== 'object' || item === null || typeof Reflect.get(item, 'id') !== 'string') return []
    return [[Reflect.get(item, 'id') as string, item] as const]
  }))
  const sourceShowCoversLine2 = evidence.some(receipt => typeof receipt === 'object' && receipt !== null && Reflect.get(receipt, 'operation') === 'show'
    && Reflect.get(receipt, 'path') === 'add.mjs' && Reflect.get(receipt, 'commit') === targetCommit
    && Number(Reflect.get(receipt, 'startLine')) <= 2 && Number(Reflect.get(receipt, 'endLine')) >= 2)
  const diffPresent = evidence.some(receipt => typeof receipt === 'object' && receipt !== null && Reflect.get(receipt, 'operation') === 'diff'
    && Reflect.get(receipt, 'path') === 'add.mjs' && Reflect.get(receipt, 'commit') === targetCommit)
  const findingChecks = findings.map((item, index) => {
    const finding = typeof item === 'object' && item !== null ? item : undefined
    const field = (name: string): unknown => finding === undefined ? undefined : Reflect.get(finding, name)
    const startLine = field('startLine')
    const endLine = field('endLine')
    const evidenceIds = field('evidenceIds')
    const checks = {
      index,
      pathMatchesTarget: field('path') === 'add.mjs',
      commitMatchesTarget: field('commit') === targetCommit,
      exactLine2: startLine === 2 && endLine === 2,
      validSpanContainsLine2: typeof startLine === 'number' && Number.isSafeInteger(startLine) && startLine >= 1
        && typeof endLine === 'number' && Number.isSafeInteger(endLine) && endLine >= startLine && startLine <= 2 && endLine >= 2,
      failureConditionIncludesLiteral2147483647: String(field('failureCondition')).includes('2147483647'),
      failureConditionIncludesLiteral1: String(field('failureCondition')).includes('1'),
      nonemptyCitations: Array.isArray(evidenceIds) && evidenceIds.length > 0,
      allCitationsObservedForTargetPath: Array.isArray(evidenceIds) && evidenceIds.every(id => {
        if (typeof id !== 'string') return false
        const receipt = evidenceById.get(id)
        return typeof receipt === 'object' && receipt !== null
          && Reflect.get(receipt, 'path') === 'add.mjs' && Reflect.get(receipt, 'commit') === targetCommit
          && inspectedIds.includes(id)
      }),
      sourceShowCoversLine2,
      diffPresent,
    }
    const accepted = checks.pathMatchesTarget && checks.commitMatchesTarget && checks.exactLine2
      && checks.failureConditionIncludesLiteral2147483647 && checks.failureConditionIncludesLiteral1
      && checks.nonemptyCitations && checks.allCitationsObservedForTargetPath && checks.sourceShowCoversLine2 && checks.diffPresent
    return { ...checks, accepted }
  })
  const reviewChecks = { durableComplete: true, snapshotMatchesTarget: snapshotTarget === targetCommit, pinnedBugVerified, cleanControlVerified }
  const accepted = reviewChecks.snapshotMatchesTarget && pinnedBugVerified && cleanControlVerified && findingChecks.some(check => check.accepted)
  return { accepted, evidence: { targetCommit, snapshotTarget, pinnedBugVerified, cleanControlVerified, trigger: 'add(2147483647, 1) must return 2147483648', findingCount: findings.length, evidenceCount: evidence.length, reviewChecks, findingChecks } }
}

async function additionResult(source: string, left: number, right: number): Promise<number | undefined> {
  const url = `data:text/javascript,${encodeURIComponent(source)}`
  const code = `const {add}=await import(${JSON.stringify(url)});process.stdout.write(String(add(${left},${right})))`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
  if (result.status !== 0 || !/^-?\d+$/u.test(result.stdout)) return undefined
  return Number(result.stdout)
}

async function makeReviewCommits(root: string): Promise<void> {
  await git(root, ['init', '-q'])
  await writeFile(join(root, 'add.mjs'), 'export function add(left, right) {\n  return left + right\n}\n')
  await git(root, ['add', '.'])
  await git(root, ['commit', '-qm', 'Clean addition control'])
  await writeFile(join(root, 'add.mjs'), 'export function add(left, right) {\n  return (left + right) | 0\n}\n')
  await git(root, ['add', 'add.mjs'])
  await git(root, ['commit', '-qm', 'Pinned signed overflow regression'])
}

async function git(root: string, args: string[]): Promise<string> {
  return execFileSync('git', ['-c', 'user.name=EvaluationFixture', '-c', 'user.email=evaluation@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-08T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-08T00:00:00Z', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim()
}

async function digestSource(root: string): Promise<string> {
  const paths: string[] = []
  const visit = async (directory: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.agent') continue
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(directory, path)
      else paths.push(path)
    }
  }
  await visit(root)
  const rows = await Promise.all(paths.sort().map(async path => `${path}\0${sha(await readFile(join(root, path), 'utf8'))}`))
  return sha(rows.join('\n'))
}

async function ensureAgentIgnored(root: string): Promise<void> {
  const path = join(root, '.gitignore')
  const content = await readFile(path, 'utf8').catch(() => '')
  const lines = new Set(content.split(/\r?\n/u))
  if (!lines.has('.agent/')) await writeFile(path, `${content}${content.endsWith('\n') || content.length === 0 ? '' : '\n'}.agent/\n`)
}

function sha(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }

async function readPinnedMlir(): Promise<{ executable: string; version: string; digest: string } | undefined> {
  if (mlirOpt === undefined) return undefined
  const executable = resolve(mlirOpt)
  const version = spawnSync(executable, ['--version'], { encoding: 'utf8' })
  if (version.status !== 0) throw new Error(`configured MLIR verifier failed --version: ${version.stderr}`)
  return { executable, version: version.stdout.trim(), digest: sha(await readFile(executable)) }
}
