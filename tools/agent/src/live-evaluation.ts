/** Bounded live-provider evaluation through the installed engineering profile. */

import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { dump, load } from 'js-yaml'
import { installEngineeringProfiles } from './installation.ts'
import { TaskRepository } from './repository.ts'
import type { TaskUsageReport } from './usage.ts'

/** Sanitized outcome of one bounded D adaptive live run. */
export interface LiveEngineeringEvaluationReport {
  mode: 'LIVE_PROVIDER'
  strategy: 'D_ADAPTIVE'
  comparisonStatus: 'UNKNOWN'
  status: 'ACCEPTED' | 'REJECTED' | 'BLOCKED' | 'BUDGET_EXHAUSTED'
  diagnostic: string | 'UNKNOWN'
  taskId: string | 'UNKNOWN'
  usageReport: TaskUsageReport | 'UNKNOWN'
  independentChecks: { answerIs42: boolean; originalFilePreserved: boolean }
  reportPath: string
}

/** Run a single capped task with the installed engineering-run profile and report durable usage.
 * @param options - source checkout, user deployment, optional environment and timeout.
 * @returns sanitized task result and the path to its JSON report.
 */
export async function runLiveEngineeringEvaluation(options: {
  checkout: string
  deploymentRoot?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}): Promise<LiveEngineeringEvaluationReport> {
  if (process.platform === 'win32') throw new Error('live engineering evaluation requires a POSIX host')
  const checkout = resolve(options.checkout)
  const deploymentRoot = resolve(options.deploymentRoot ?? checkout)
  const root = await mkdtemp(join(tmpdir(), 'dsh-live-evaluation-'))
  const repositoryRoot = join(root, 'repository')
  const dshHome = join(root, 'home')
  const binDirectory = join(root, 'bin')
  const reportPath = join(tmpdir(), `dsh-live-evaluation-${process.pid}-${Date.now()}.json`)
  let taskId: string | 'UNKNOWN' = 'UNKNOWN'
  let status: LiveEngineeringEvaluationReport['status'] = 'BLOCKED'
  let diagnostic: string | 'UNKNOWN' = 'UNKNOWN'
  let usageReport: TaskUsageReport | 'UNKNOWN' = 'UNKNOWN'
  let answerIs42 = false
  let originalFilePreserved = false
  try {
    await mkdir(repositoryRoot, { recursive: true })
    const deployment = join(dshHome, 'engineering')
    await mkdir(deployment, { recursive: true })
    await cp(join(deploymentRoot, '.agent'), join(deployment, '.agent'), { recursive: true })
    const modelFile = join(deployment, '.agent/config/models.yaml')
    const rolesFile = join(deployment, '.agent/config/roles.yaml')
    const models = load(await readFile(modelFile, 'utf8')) as { routes: Record<string, { costClass: string }> }
    const routeIds = Object.keys(models.routes)
    const cheapRoute = routeIds.find(id => models.routes[id]?.costClass === 'standard')
    if (cheapRoute === undefined) throw new Error('deployment has no configured standard-cost route')
    const roles = load(await readFile(rolesFile, 'utf8')) as { roles: Record<string, { route: string; fallbackRoutes?: string[]; escalationRoutes?: string[]; escalationFallbackRoutes?: string[] }> }
    for (const role of Object.values(roles.roles)) {
      role.route = cheapRoute
      if (role.fallbackRoutes !== undefined) role.fallbackRoutes = []
      if (role.escalationRoutes !== undefined) role.escalationRoutes = []
      if (role.escalationFallbackRoutes !== undefined) role.escalationFallbackRoutes = []
    }
    await writeFile(rolesFile, dump(roles))
    await installEngineeringProfiles({ checkout, home: dshHome, binDirectory, node: process.execPath })

    const repository = new TaskRepository(repositoryRoot, join(repositoryRoot, '.agent/schemas'), { templateRoot: join(checkout, '.agent') })
    await repository.init()
    await cp(join(deployment, '.agent/config'), join(repositoryRoot, '.agent/config'), { recursive: true, force: true })
    await writeFile(join(repositoryRoot, '.agent/config/project.yaml'), dump({
      schemaVersion: 1, profile: 'compiler', adapter: '.agent/adapters/evaluation.yaml', dataClass: 'public',
      maxSteps: 8, maxRoleCalls: 8, commandTimeoutMs: 20_000,
    }))
    await mkdir(join(repositoryRoot, '.agent/adapters'), { recursive: true })
    await mkdir(join(repositoryRoot, '.agent/profiles'), { recursive: true })
    await writeFile(join(repositoryRoot, '.agent/profiles/compiler.yaml'), dump({ schemaVersion: 1, id: 'compiler', checks: [
      { name: 'answer-42', category: 'source', adapter: 'answer', required: true, timeoutMs: 20_000 },
      { name: 'preserve-existing', category: 'source', adapter: 'preserve', required: true, timeoutMs: 20_000 },
    ] }))
    await writeFile(join(repositoryRoot, '.agent/adapters/evaluation.yaml'), dump({ adapters: {
      answer: { executable: process.execPath, args: ['-e', "if (require('node:fs').readFileSync('answer.txt','utf8') !== '42\\n') process.exit(2)"] },
      preserve: { executable: process.execPath, args: ['-e', "if (require('node:fs').readFileSync('existing.txt','utf8') !== 'preserve\\n') process.exit(2)"] },
    } }))
    await writeFile(join(repositoryRoot, 'answer.txt'), '0\n')
    await writeFile(join(repositoryRoot, 'existing.txt'), 'preserve\n')
    await writeFile(join(repositoryRoot, '.gitignore'), '.agent/\n.dsh/\n.agents/\n')
    await execa('git', ['init', '-q'], { cwd: repositoryRoot })
    await execa('git', ['add', 'answer.txt', 'existing.txt', '.gitignore'], { cwd: repositoryRoot })
    await execa('git', ['-c', 'user.name=EvaluationFixture', '-c', 'user.email=evaluation@example.invalid', 'commit', '-qm', 'Live evaluation seed'], { cwd: repositoryRoot })

    const env = {
      ...process.env,
      ...options.env,
      DSH_HOME: dshHome,
      DSH_AGENTS_HOME: join(repositoryRoot, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
    }
    const redact = (text: string): string => Object.entries(env)
      .filter(([name, value]) => /key|token|secret|credential|password/i.test(name) && value !== undefined && value.length >= 6)
      .reduce((result, [, value]) => result.replaceAll(value!, '[REDACTED]'), text)
    const run = await execa(join(binDirectory, 'dsh'), ['--profile', 'engineering-run', 'Create answer.txt containing exactly 42 and preserve existing.txt.'], {
      cwd: repositoryRoot, env, timeout: options.timeoutMs ?? 240_000, reject: false,
    })
    const logRoot = join(tmpdir(), 'dsh-goal-1008')
    await mkdir(logRoot, { recursive: true, mode: 0o700 })
    const logPrefix = `dsh-live-evaluation-${process.pid}-${Date.now()}`
    await writeFile(join(logRoot, `${logPrefix}.stdout.log`), redact(run.stdout), { mode: 0o600 })
    await writeFile(join(logRoot, `${logPrefix}.stderr.log`), redact(run.stderr), { mode: 0o600 })
    diagnostic = run.timedOut ? 'CLI_TIMEOUT' : run.exitCode === 0 ? 'CLI_EXITED' : `CLI_EXIT_${String(run.exitCode ?? 'UNKNOWN')}`
    const tasksRoot = join(repositoryRoot, '.agent/tasks')
    const tasks = await readdir(tasksRoot).catch(() => [])
    if (tasks.length === 1) {
      taskId = tasks[0]!
      const task = await readFile(join(tasksRoot, taskId, 'STATE.json'), 'utf8').then(JSON.parse) as { state?: string }
      status = task.state === 'ACCEPTED' ? 'ACCEPTED' : task.state === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXHAUSTED' : task.state === 'REJECTED' ? 'REJECTED' : 'BLOCKED'
      const lifecycle = await repository.lifecycle(taskId, 'development', {})
      usageReport = await lifecycle.usageReport()
    }
    answerIs42 = await readFile(join(repositoryRoot, 'answer.txt'), 'utf8').then(value => value === '42\n').catch(() => false)
    originalFilePreserved = await readFile(join(repositoryRoot, 'existing.txt'), 'utf8').then(value => value === 'preserve\n').catch(() => false)
    if (run.exitCode !== 0 && status === 'ACCEPTED') status = 'BLOCKED'
    const report: LiveEngineeringEvaluationReport = {
      mode: 'LIVE_PROVIDER', strategy: 'D_ADAPTIVE', comparisonStatus: 'UNKNOWN', status, diagnostic, taskId,
      usageReport, independentChecks: { answerIs42, originalFilePreserved }, reportPath,
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    if (run.timedOut) return report
    return report
  } catch (error) {
    diagnostic = error instanceof Error ? `SETUP_OR_COLLECTION_ERROR:${error.name}` : 'LIVE_EVALUATION_FAILED'
    const report: LiveEngineeringEvaluationReport = {
      mode: 'LIVE_PROVIDER', strategy: 'D_ADAPTIVE', comparisonStatus: 'UNKNOWN', status, diagnostic, taskId,
      usageReport, independentChecks: { answerIs42, originalFilePreserved }, reportPath,
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    return report
  } finally {
    // A timed-out CLI may still own descendants. Preserve its isolated tree for diagnosis.
    if (diagnostic !== 'CLI_TIMEOUT') await rm(root, { recursive: true, force: true })
  }
}
