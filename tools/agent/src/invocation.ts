/** Durable invocation claims, task bindings and results for engineering_run replay. */

import { createHash, randomBytes } from 'node:crypto'
import { link, mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import type { ValidateFunction } from 'ajv'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { EngineeringRunResult } from './automatic.ts'
import type { ReviewRunResult } from './review-only.ts'
import { isLiveWriterLockTimeout } from './run-lock.ts'

/** Runtime-owned receipt directory, excluded from repository source identity. */
export const ENGINEERING_INVOCATION_DIR = '.dsh/engineering/.runtime/invocations'

/** Durable identity of one engineering tool invocation, independent of request text. */
export type EngineeringRunInvocationId = Branded<'EngineeringRunInvocationId'>

interface InvocationIdentity {
  invocationId: EngineeringRunInvocationId
  sessionId: string
  callId: string
  repositoryIdentity: string
  loggedCallSeq?: SessionSeq
}

/** Persisted claim precedes task effects; a bound task never changes on replay. */
export type EngineeringInvocationReceipt = InvocationIdentity & (
  | { schemaVersion: 1; result: EngineeringRunResult }
  | { schemaVersion: 2; phase: 'CLAIMED'; taskId?: never; result?: never }
  | { schemaVersion: 2; phase: 'TASK_BOUND'; taskId: string; result?: never }
  | { schemaVersion: 2; phase: 'COMPLETED'; taskId: string; result: EngineeringRunResult }
  | { schemaVersion: 3; workflow: 'review-only'; phase: 'CLAIMED'; taskId?: never; result?: never }
  | { schemaVersion: 3; workflow: 'review-only'; phase: 'TASK_BOUND'; taskId: string; result?: never }
  | { schemaVersion: 3; workflow: 'review-only'; phase: 'COMPLETED'; taskId: string; result: ReviewRunResult }
)

const identityProperties = {
  invocationId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  sessionId: { type: 'string', minLength: 1 },
  callId: { type: 'string', minLength: 1 },
  repositoryIdentity: { type: 'string', minLength: 1 },
}
const taskIdSchema = { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }
const loggedCallSeqSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
let validator: Promise<ValidateFunction<EngineeringInvocationReceipt>> | undefined

async function validateReceipt(value: unknown, invocationId: EngineeringRunInvocationId): Promise<EngineeringInvocationReceipt> {
  validator ??= (async () => {
    const state = JSON.parse(await readFile(new URL('../../../.agent/schemas/state.schema.json', import.meta.url), 'utf8'))
    const result = {
      type: 'object', additionalProperties: false,
      required: ['status', 'taskId', 'summary', 'nextAction'],
      properties: {
        status: { enum: ['ACCEPTED', 'BLOCKED', 'BUDGET_EXHAUSTED', 'RUN_ALREADY_ACTIVE'] },
        taskId: { anyOf: [taskIdSchema, { const: '' }] },
        summary: { type: 'string', minLength: 1 },
        nextAction: { enum: ['NONE', 'RESUME', 'RECOVER', 'REPLAN_WITH_SCOPE', 'WAIT_FOR_CURRENT_RUN', 'INCREASE_BUDGET'] },
        requiresStopConfirmation: { type: 'boolean' }, state: { $ref: '#/definitions/state' },
      },
    }
    const reviewResult = JSON.parse(await readFile(new URL('../../../.agent/schemas/review-result.schema.json', import.meta.url), 'utf8'))
    delete reviewResult.$id
    const record = (properties: object, required: string[]) => ({
      type: 'object', additionalProperties: false,
      required: [...Object.keys(identityProperties), 'schemaVersion', ...required],
      properties: { ...identityProperties, ...properties },
    })
    return addFormats(new Ajv({ strict: true, allErrors: true })).compile<EngineeringInvocationReceipt>({
      definitions: { state },
      anyOf: [
        record({ schemaVersion: { const: 1 }, result }, ['result']),
        record({ schemaVersion: { const: 2 }, loggedCallSeq: loggedCallSeqSchema, phase: { const: 'CLAIMED' } }, ['phase']),
        record({ schemaVersion: { const: 2 }, loggedCallSeq: loggedCallSeqSchema, phase: { const: 'TASK_BOUND' }, taskId: taskIdSchema }, ['phase', 'taskId']),
        record({ schemaVersion: { const: 2 }, loggedCallSeq: loggedCallSeqSchema, phase: { const: 'COMPLETED' }, taskId: { anyOf: [taskIdSchema, { const: '' }] }, result }, ['phase', 'taskId', 'result']),
        ...['CLAIMED', 'TASK_BOUND', 'COMPLETED'].map(phase => record({
          schemaVersion: { const: 3 }, workflow: { const: 'review-only' }, loggedCallSeq: loggedCallSeqSchema,
          phase: { const: phase },
          ...phase === 'CLAIMED' ? {} : { taskId: taskIdSchema },
          ...phase === 'COMPLETED' ? { result: reviewResult } : {},
        }, ['workflow', 'phase', ...phase === 'CLAIMED' ? [] : ['taskId'], ...phase === 'COMPLETED' ? ['result'] : []])),
      ],
    })
  })()
  const validate = await validator
  if (!validate(value)) throw new Error(`Invalid engineering invocation receipt ${invocationId}: ${JSON.stringify(validate.errors)}`)
  const receipt = value
  if (receipt.invocationId !== invocationId || engineeringInvocationId(receipt.sessionId, receipt.callId, receipt.repositoryIdentity, receipt.loggedCallSeq, receipt.schemaVersion === 3 ? receipt.workflow : undefined) !== invocationId) {
    throw new Error(`Engineering invocation receipt identity mismatch: ${invocationId}`)
  }
  if (receipt.schemaVersion !== 1 && receipt.phase === 'COMPLETED' && receipt.taskId !== receipt.result.taskId) {
    throw new Error(`Engineering invocation receipt task mismatch: ${invocationId}`)
  }
  if (receipt.schemaVersion === 3 && receipt.phase === 'COMPLETED') {
    if (receipt.result.state.taskId !== receipt.taskId || receipt.result.state.state !== receipt.result.status
      || receipt.result.state.writer !== null) throw new Error(`Review invocation receipt result mismatch: ${invocationId}`)
  } else if (receipt.schemaVersion !== 3 && 'result' in receipt && receipt.result !== undefined) {
    const result = receipt.result
    if (result.state !== undefined && result.state.taskId !== result.taskId
      || result.status === 'ACCEPTED' && (result.nextAction !== 'NONE' || result.taskId === '' || result.state !== undefined && result.state.state !== 'ACCEPTED')
      || result.status === 'BLOCKED' && !['RESUME', 'RECOVER', 'REPLAN_WITH_SCOPE'].includes(result.nextAction)
      || result.status === 'BUDGET_EXHAUSTED' && (result.nextAction !== 'INCREASE_BUDGET' || result.state?.state !== 'BUDGET_EXHAUSTED')
      || result.status === 'RUN_ALREADY_ACTIVE' && result.nextAction !== 'WAIT_FOR_CURRENT_RUN') {
      throw new Error(`Engineering invocation receipt result mismatch: ${invocationId}`)
    }
  }
  return receipt
}

/**
 * Derive a replay identity from durable call identity, never request text.
 * @param sessionId - Session that issued the tool call.
 * @param callId - model-issued tool call identifier.
 * @param repositoryIdentity - canonical repository path.
 * @param loggedCallSeq - durable tool/call occurrence; omitted only by callers supplying their own stable call identity.
 * @param workflow - Review-only namespace; omission preserves Development invocation identities.
 * @returns SHA-256 hex identity.
 */
export function engineeringInvocationId(sessionId: string, callId: string, repositoryIdentity: string, loggedCallSeq?: SessionSeq, workflow?: 'review-only'): EngineeringRunInvocationId {
  if ([sessionId, callId, repositoryIdentity].some(value => value.length === 0 || value.includes('\0'))) throw new Error('Engineering invocation identity fields must be nonempty and contain no NUL')
  const hash = createHash('sha256').update(sessionId).update('\0').update(callId).update('\0').update(repositoryIdentity)
  if (loggedCallSeq !== undefined) hash.update('\0tool/call\0').update(String(loggedCallSeq))
  if (workflow !== undefined) hash.update('\0workflow\0').update(workflow)
  return brandString<EngineeringRunInvocationId>(hash.digest('hex'))
}

function receiptPath(root: string, invocationId: EngineeringRunInvocationId): string {
  if (!/^[a-f0-9]{64}$/.test(invocationId)) throw new Error('Invalid engineering invocation identity')
  return join(root, ENGINEERING_INVOCATION_DIR, `${invocationId}.json`)
}

/** One invocation lock outcome; contention is distinct from lock I/O failure. */
export type EngineeringInvocationLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; receipt?: EngineeringInvocationReceipt }

/**
 * Run one invocation while owning its cross-process lock without waiting.
 * @param root - canonical repository root.
 * @param invocationId - durable invocation identity.
 * @param operation - claim, run and receipt operation owned by the lock holder.
 * @returns the operation result, or an active-owner indication.
 */
export async function withEngineeringInvocationLock<T>(root: string, invocationId: EngineeringRunInvocationId, operation: () => Promise<T>): Promise<EngineeringInvocationLockResult<T>> {
  const filename = receiptPath(root, invocationId)
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  try {
    return { acquired: true, value: await withFileLock(filename, operation, { waitMs: 0 }) }
  } catch (error) {
    if (!await isLiveWriterLockTimeout(error, filename)) throw error
    const receipt = await readEngineeringInvocationReceipt(root, invocationId)
    return receipt === undefined ? { acquired: false } : { acquired: false, receipt }
  }
}

/**
 * Read one previously saved replay receipt.
 * @param root - repository root.
 * @param invocationId - replay identity.
 * @returns the validated claim, task binding or result; undefined only when the file is absent.
 */
export async function readEngineeringInvocationReceipt(root: string, invocationId: EngineeringRunInvocationId): Promise<EngineeringInvocationReceipt | undefined> {
  let text: string
  try {
    text = await readFile(receiptPath(root, invocationId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const source: unknown = JSON.parse(text)
  return validateReceipt(source, invocationId)
}

/**
 * Persist one replay receipt atomically.
 * @param root - repository root.
 * @param receipt - complete receipt.
 */
export async function writeEngineeringInvocationReceipt(root: string, receipt: EngineeringInvocationReceipt): Promise<void> {
  await validateReceipt(receipt, receipt.invocationId)
  const filename = receiptPath(root, receipt.invocationId)
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  await writeFileAtomic(filename, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Exclusively create the durable claim before any task effects. Existing claims are never replaced.
 * @param root - canonical repository root.
 * @param receipt - new invocation identity and unbound claim.
 * @returns true only for the caller that created the claim.
 */
export async function claimEngineeringInvocation(root: string, receipt: InvocationIdentity & ({ schemaVersion: 2; phase: 'CLAIMED' } | { schemaVersion: 3; workflow: 'review-only'; phase: 'CLAIMED' })): Promise<boolean> {
  await validateReceipt(receipt, receipt.invocationId)
  const filename = receiptPath(root, receipt.invocationId)
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${randomBytes(16).toString('hex')}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(temporary, filename)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    return true
  } finally {
    await rm(temporary, { force: true })
  }
}
