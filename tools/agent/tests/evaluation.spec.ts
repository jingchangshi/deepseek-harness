import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const fixtures = join(import.meta.dirname, 'fixtures/evaluation')
const strategies = ['A_STRONG', 'B_CHEAP', 'C_FIXED', 'D_ADAPTIVE'] as const
type Strategy = typeof strategies[number]
type Kind = 'compiler' | 'mlir' | 'review' | 'recovery'
type Receipt = { stage: 'SCOUT' | 'ARCHITECT' | 'CHALLENGER' | 'IMPLEMENTER' | 'VERIFICATION' | 'REVIEWER' | 'SINGLE'; startedAt: string; endedAt: string; outcome: 'SUCCESS' | 'FAILED' | 'UNKNOWN'; requestIds: string[] }

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const metadata = {
  compiler: { id: 'pebble-mul', allowedPaths: ['compiler/pebble.mjs'], request: 'Repair Pebble multiplication and keep stack and register output equivalent', criteria: 'Integer multiplication, both encodings, invalid SSA rejection' },
  mlir: { id: 'mlir-pass', allowedPaths: ['pass.mjs'], request: 'Rewrite add of a right-side zero to its input in MLIR while preserving nonzero additions', criteria: 'Exact identity rewrite, nonzero and idempotence regressions, MLIR grammar' },
  review: { id: 'review-overflow', allowedPaths: [], request: 'Review the pinned addition commit and report the introduced signed overflow', criteria: 'Finding refers to add.mjs line 2 and pinned SHA with concrete signed overflow trigger' },
  recovery: { id: 'recovery-latch', allowedPaths: ['answer.txt'], request: 'Write answer.txt containing exactly 42 after the first injected failure', criteria: 'First invocation fails before write, later source equals 42' },
} as const

async function files(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) result.push(...await files(root, path))
    else result.push(path)
  }
  return result.sort()
}

async function sourceDigest(root: string): Promise<string> {
  return sha((await Promise.all((await files(root)).map(async path => `${path}\0${sha(await readFile(join(root, path), 'utf8'))}`))).join('\n'))
}

async function seed(kind: Kind) {
  const root = await mkdtemp(join(tmpdir(), `dsh-evaluation-${kind}-`))
  roots.push(root)
  if (kind === 'compiler') {
    await cp(join(import.meta.dirname, 'fixtures/third-compiler/repository/compiler'), join(root, 'compiler'), { recursive: true })
    await cp(join(import.meta.dirname, 'fixtures/third-compiler/repository/programs'), join(root, 'programs'), { recursive: true })
  } else await cp(join(fixtures, kind === 'mlir' ? 'mlir' : kind === 'review' ? 'review' : 'recovery'), root, { recursive: true })
  const git = async (...args: string[]) => (await execa('git', ['-c', 'user.name=EvaluationFixture', '-c', 'user.email=evaluation@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, env: { GIT_AUTHOR_DATE: '2026-10-08T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-08T00:00:00Z', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })).stdout
  await git('init', '-q')
  await git('add', '.')
  await git('commit', '-qm', 'Immutable evaluation seed')
  return { root, git, seedSha: await git('rev-parse', 'HEAD'), sourceDigest: await sourceDigest(root), kind, ...metadata[kind], requestDigest: sha(metadata[kind].request), criteriaDigest: sha(metadata[kind].criteria), commandProfile: kind === 'compiler' ? 'pebble/check.mjs' : kind === 'mlir' ? 'mlir/check.mjs' : 'independent-source-oracle' }
}

async function implementationOracle(testCase: Awaited<ReturnType<typeof seed>>, cwd: string) {
  const changed = (await execa('git', ['status', '--porcelain', '--untracked-files=all'], { cwd })).stdout.split('\n').filter(Boolean).map(line => line.slice(3))
  if (changed.some(path => !(testCase.allowedPaths as readonly string[]).includes(path))) return { accepted: false, evidence: { reason: 'Out-of-scope source', changed } }
  if (testCase.kind === 'compiler' || testCase.kind === 'mlir') {
    const check = join(fixtures, testCase.kind === 'compiler' ? 'pebble' : 'mlir', 'check.mjs')
    const result = await execa(process.execPath, [check, cwd], { cwd, reject: false })
    return { accepted: result.exitCode === 0, evidence: { independentCommand: check, exitCode: result.exitCode, stdout: result.stdout } }
  }
  return { accepted: (await readFile(join(cwd, 'answer.txt'), 'utf8')) === '42\n', evidence: { source: 'answer.txt', expected: '42' } }
}

function reviewOracle(commit: string, output: { findings: Array<{ path: string; commit: string; startLine: number; endLine: number; failureCondition: string }> }, clean = false) {
  const accepted = clean ? output.findings.length === 0 : output.findings.some(finding => finding.path === 'add.mjs' && finding.commit === commit && finding.startLine === 2 && finding.endLine === 2 && finding.failureCondition.includes('2147483647') && finding.failureCondition.includes('1'))
  return { accepted, evidence: { targetCommit: commit, trigger: 'add(2147483647, 1) must return 2147483648', clean } }
}

async function repair(testCase: Awaited<ReturnType<typeof seed>>, cwd = testCase.root) {
  if (testCase.kind === 'compiler') {
    const path = join(cwd, 'compiler/pebble.mjs')
    await writeFile(path, (await readFile(path, 'utf8')).replace("operation === 'add' ? left + right : left + right", "operation === 'add' ? left + right : left * right"))
  } else if (testCase.kind === 'mlir') await writeFile(join(cwd, 'pass.mjs'), "export function rewrite(source) {\n  if (!source.includes('arith.constant 0 : i32')) return source\n  return source.replace('    %sum = arith.addi %arg0, %zero : i32\\n', '').replace('return %sum : i32', 'return %arg0 : i32')\n}\n")
  else if (testCase.kind === 'recovery') await writeFile(join(cwd, 'answer.txt'), '42\n')
}

async function benchmarkModule() {
  const path = resolve('tools/agent/src/benchmark.ts')
  await expect(readFile(path, 'utf8'), 'Phase4 benchmark API must exist before comparison behavior can be tested').resolves.toContain('runEngineeringBenchmark')
  return import(path)
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('independent evaluation inputs and oracles', () => {
  it.each(['compiler', 'mlir', 'review', 'recovery'] as const)('reproduces %s seed identity and immutable request criteria', async kind => {
    const first = await seed(kind)
    const second = await seed(kind)
    expect(second).toMatchObject({ seedSha: first.seedSha, sourceDigest: first.sourceDigest, requestDigest: first.requestDigest, criteriaDigest: first.criteriaDigest })
  })

  it.each(['compiler', 'mlir', 'recovery'] as const)('rejects corrupted %s output and protects oracle scope even after a valid repair', async kind => {
    const testCase = await seed(kind)
    expect((await implementationOracle(testCase, testCase.root)).accepted).toBe(false)
    await repair(testCase)
    expect((await implementationOracle(testCase, testCase.root)).accepted).toBe(true)
    await writeFile(join(testCase.root, 'unexpected.txt'), 'Fake accepted output')
    expect((await implementationOracle(testCase, testCase.root)).accepted).toBe(false)
  })

  it('rejects fabricated findings against a pinned bad commit and false positives against the clean control', async () => {
    const testCase = await seed('review')
    expect((await readFile(join(testCase.root, 'add.mjs'), 'utf8')).split('\n')[1]).toBe('  return (left + right) | 0')
    expect((await execa(process.execPath, ['--input-type=module', '-e', "import { add } from './add.mjs'; console.log(add(2147483647,1))"], { cwd: testCase.root })).stdout).toBe('-2147483648')
    const finding = { path: 'add.mjs', commit: testCase.seedSha, startLine: 2, endLine: 2, failureCondition: 'add(2147483647, 1) wraps to a negative signed integer' }
    expect(reviewOracle(testCase.seedSha, { findings: [finding] }).accepted).toBe(true)
    expect(reviewOracle(testCase.seedSha, { findings: [] }).accepted).toBe(false)
    expect(reviewOracle(testCase.seedSha, { findings: [{ ...finding, commit: 'f'.repeat(40) }] }).accepted).toBe(false)
    expect(reviewOracle(testCase.seedSha, { findings: [{ ...finding, startLine: 1 }] }).accepted).toBe(false)
    await writeFile(join(testCase.root, 'add.mjs'), 'export function add(left, right) {\n  return left + right\n}\n')
    await testCase.git('add', 'add.mjs')
    await testCase.git('commit', '-qm', 'Clean addition control')
    const clean = await testCase.git('rev-parse', 'HEAD')
    expect(reviewOracle(clean, { findings: [] }, true).accepted).toBe(true)
    expect(reviewOracle(clean, { findings: [{ ...finding, commit: clean }] }, true).accepted).toBe(false)
    expect((await execa(process.execPath, ['--input-type=module', '-e', "import { add } from './add.mjs'; if(add(2147483647,1)!==2147483648)process.exit(1)"], { cwd: testCase.root })).exitCode).toBe(0)
  })
})

describe('production benchmark dispatch and comparison', () => {
  it('runs every requested case and strategy through a shared independent oracle and labels scripted evidence offline', async () => {
    const { runEngineeringBenchmark } = await benchmarkModule()
    const testCase = await seed('compiler')
    const calls: Strategy[] = []
    const report = await runEngineeringBenchmark({ cases: [{ ...testCase, run: async (cwd: string) => { await cp(testCase.root, cwd, { recursive: true }) } }], strategies: strategies.map(id => ({ id })), mode: 'OFFLINE_SYNTHETIC', executor: { async run(id: Strategy, current: typeof testCase, cwd: string): Promise<Receipt[]> {
      calls.push(id)
      await repair(current, cwd)
      return [{ stage: 'SINGLE', startedAt: '2026-10-08T00:00:00.000Z', endedAt: '2026-10-08T00:00:00.100Z', outcome: 'SUCCESS', requestIds: [] }]
    } }, oracle: implementationOracle })
    expect(calls).toEqual(strategies)
    expect(report.mode).toBe('OFFLINE_SYNTHETIC')
    expect(report.results).toHaveLength(4)
    expect(report.results.every((result: { status: string }) => result.status === 'ACCEPTED')).toBe(true)
  })

  it('cannot accept model-claimed success when the independent compiler oracle fails', async () => {
    const { runEngineeringBenchmark } = await benchmarkModule()
    const testCase = await seed('compiler')
    const report = await runEngineeringBenchmark({ cases: [{ ...testCase, run: async (cwd: string) => { await cp(testCase.root, cwd, { recursive: true }) } }], strategies: strategies.map(id => ({ id })), mode: 'OFFLINE_SYNTHETIC', executor: { async run(): Promise<Receipt[]> { return [{ stage: 'SINGLE', startedAt: '2026-10-08T00:00:00.000Z', endedAt: '2026-10-08T00:00:00.100Z', outcome: 'SUCCESS', requestIds: [] }] } }, oracle: implementationOracle })
    expect(report.results).toHaveLength(4)
    expect(report.results.every((result: { status: string }) => result.status === 'REJECTED')).toBe(true)
    expect(report.aggregates.tokensPerSuccess).toBe('UNKNOWN')
    expect(report.aggregates.costPerSuccess).toBe('UNKNOWN')
  })

  it('reports an incomplete comparison when required strategies are missing', async () => {
    const { runEngineeringBenchmark } = await benchmarkModule()
    const testCase = await seed('recovery')
    const report = await runEngineeringBenchmark({ cases: [{ ...testCase, run: async (cwd: string) => { await mkdir(cwd, { recursive: true }); await cp(testCase.root, cwd, { recursive: true }) } }], strategies: [{ id: 'D_ADAPTIVE' }], mode: 'OFFLINE_SYNTHETIC', executor: { async run(): Promise<Receipt[]> { return [] } }, oracle: implementationOracle })
    expect(report.aggregates.comparisonStatus).toBe('UNKNOWN')
  })
})
