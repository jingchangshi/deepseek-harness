/** Cross-platform command entry point for deterministic repository task operations. */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TaskRepository } from './repository.ts'
import { assertDispatchAllowed, loadHarnessConfig } from './config.ts'
import type { SensitiveApproval, SensitiveInputKind } from './config.ts'
import { nextDispatches } from './orchestration.ts'
import { smokeModelRoutes } from './smoke.ts'
import { createPinnedHeadlessExecutor, runRealModelSmokes } from './smoke-real.ts'
import { runVerificationProfile, validateVerificationProfileId, verificationEvidence } from './verification.ts'
import type { TaskDocument } from './types.ts'
import { loadEngineeringProject } from './automatic.ts'
import { updateFreeze, verifyFreeze } from './freeze.ts'

const PROJECT_TEMPLATE_ROOT = resolve(import.meta.dirname, '../../../.agent')

interface ParsedArgs {
  command: string | undefined
  positionals: string[]
  flags: Map<string, string>
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv
  const positionals: string[] = []
  const flags = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value === undefined) continue
    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }
    const flagValue = rest[index + 1]
    if (flagValue === undefined || flagValue.startsWith('--')) throw new Error(`${value} requires a value`)
    flags.set(value.slice(2), flagValue)
    index += 1
  }
  return { command, positionals, flags }
}

function requiredFlag(args: ParsedArgs, name: string): string {
  const value = args.flags.get(name)
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required`)
  return value
}

function taskId(args: ParsedArgs): string {
  const value = args.positionals[0]
  if (value === undefined) throw new Error('task id is required')
  return value
}

function revision(args: ParsedArgs): number {
  const value = Number(requiredFlag(args, 'revision'))
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('--revision must be a non-negative integer')
  return value
}

async function inputDocument(args: ParsedArgs): Promise<object> {
  const value = JSON.parse(await readFile(resolve(requiredFlag(args, 'input')), 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('--input must contain a JSON object')
  }
  return value
}

function taskProfile(value: string): TaskDocument['profile'] {
  return validateVerificationProfileId(value)
}

function dataClass(value: string): TaskDocument['dataClass'] {
  if (value === 'public' || value === 'internal' || value === 'sensitive') return value
  throw new Error('--data-class must be public, internal, or sensitive')
}

function sensitiveInputKind(value: string | undefined): SensitiveInputKind | undefined {
  if (value === undefined) return undefined
  if (value === 'synthetic' || value === 'anonymized' || value === 'explicitly-approved') return value
  throw new Error('--sensitive-input-kind must be synthetic, anonymized, or explicitly-approved')
}

async function approvalDocument(filename: string): Promise<SensitiveApproval> {
  const value: unknown = JSON.parse(await readFile(resolve(filename), 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('--approval must contain a JSON object')
  const source = Reflect.get(value, 'source')
  const route = Reflect.get(value, 'route')
  const approver = Reflect.get(value, 'approver')
  const expiresAt = Reflect.get(value, 'expiresAt')
  if ([source, route, approver, expiresAt].some(item => typeof item !== 'string')) {
    throw new Error('--approval requires string source, route, approver, and expiresAt fields')
  }
  return { source, route, approver, expiresAt }
}

/**
 * Run one `agentctl` invocation.
 * @param argv - arguments after the executable name.
 * @param cwd - target repository root.
 * @returns process exit code.
 */
export async function runCli(argv: string[], cwd = process.cwd()): Promise<number> {
  const args = parseArgs(argv)
  const root = resolve(args.flags.get('root') ?? cwd)
  const preset = args.flags.get('preset')
  if (preset !== undefined) {
    validateVerificationProfileId(preset)
    if (args.command !== 'init') throw new Error('--preset is only supported by init')
  }
  const repository = new TaskRepository(root, undefined, {
    templateRoot: PROJECT_TEMPLATE_ROOT,
    ...preset === undefined ? {} : { presetRoot: resolve(PROJECT_TEMPLATE_ROOT, '../tools/agent/presets', preset), presetId: preset },
  })
  let result: object | undefined

  switch (args.command) {
    case 'freeze':
      result = args.flags.get('update') === 'true' ? await updateFreeze(root) : await verifyFreeze(root)
      break
    case 'init':
      await repository.init()
      result = { initialized: true }
      break
    case 'new': {
      await repository.init()
      const id = taskId(args)
      result = await repository.createTask({
        schemaVersion: 1,
        id,
        title: requiredFlag(args, 'title'),
        profile: taskProfile(requiredFlag(args, 'profile')),
        dataClass: dataClass(requiredFlag(args, 'data-class')),
        createdAt: new Date().toISOString(),
      })
      break
    }
    case 'status':
      result = await repository.readState(taskId(args))
      break
    case 'baseline':
      result = await repository.baseline(taskId(args), revision(args), await inputDocument(args))
      break
    case 'investigate':
      result = await repository.investigate(taskId(args), revision(args), await inputDocument(args))
      break
    case 'plan':
      result = await repository.freezePlan(taskId(args), revision(args), await inputDocument(args))
      break
    case 'implement':
      result = await repository.startImplementation(taskId(args), revision(args))
      break
    case 'verify':
      result = await repository.verify(
        taskId(args),
        revision(args),
        requiredFlag(args, 'writer-token'),
        await inputDocument(args),
      )
      break
    case 'review':
      result = await repository.review(taskId(args), revision(args), await inputDocument(args))
      break
    case 'accept':
      result = await repository.accept(taskId(args), revision(args))
      break
    case 'replan':
      result = await repository.replan(taskId(args), revision(args))
      break
    case 'run': {
      const state = await repository.readState(taskId(args))
      const task = await repository.readTask(taskId(args))
      const deploymentRoot = resolve(args.flags.get('deployment-root') ?? resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'engineering'))
      const config = await loadHarnessConfig(deploymentRoot)
      const dispatches = nextDispatches(config, state)
      const inputKind = sensitiveInputKind(args.flags.get('sensitive-input-kind'))
      const approval = args.flags.has('approval') ? await approvalDocument(requiredFlag(args, 'approval')) : undefined
      for (const dispatch of dispatches) assertDispatchAllowed(config, dispatch.role, task.dataClass, inputKind, approval)
      result = { state, dispatches }
      break
    }
    case 'smoke-models': {
      const real = args.flags.get('real') === 'true'
      const deploymentRoot = resolve(args.flags.get('deployment-root') ?? resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'engineering'))
      const config = await loadHarnessConfig(deploymentRoot, { requireDeployment: false })
      const timeoutMs = args.flags.has('timeout-ms') ? Number(requiredFlag(args, 'timeout-ms')) : 180_000
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('--timeout-ms must be a positive integer')
      result = {
        mode: real ? 'real' : 'mock',
        routes: real
          ? await runRealModelSmokes(config, process.env, createPinnedHeadlessExecutor(root, process.env, timeoutMs, config))
          : await smokeModelRoutes(config),
      }
      break
    }
    case 'verify-profile': {
      const id = taskId(args)
      const task = await repository.readTask(id)
      const declared = await loadEngineeringProject(root)
      const adapterPath = resolve(requiredFlag(args, 'project-config'))
      if (adapterPath !== resolve(declared.adapter)) throw new Error('verification adapter must match the repository project declaration')
      const state = await repository.beginVerification(id, revision(args), requiredFlag(args, 'writer-token'))
      const snapshot = await repository.verificationExecutionContext(id)
      const assertCurrent = async (): Promise<void> => repository.assertVerificationExecutionContext(id, snapshot)
      const execution = await runVerificationProfile(root, task.profile, snapshot.config, undefined, snapshot.gates, snapshot.arguments, snapshot.identity, assertCurrent)
      await assertCurrent()
      await repository.appendEvidence(id, state.workRevision, verificationEvidence(root, execution), state.revision)
      result = await repository.finishVerification(id, state.revision, execution.verification)
      break
    }
    default:
      throw new Error('usage: agentctl <init|new|status|baseline|investigate|plan|implement|verify|verify-profile|review|accept|replan|run|smoke-models|freeze> [task-id] [options]')
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  runCli(process.argv.slice(2)).then(
    code => { process.exitCode = code },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
