/** Structured role responses distinguish usable results from bounded capability requests. */
import Ajv from 'ajv'
import { assertObjectJsonSchema, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { CapabilityInsufficientError, RoleInvocationError } from './role-execution.ts'

const reasons = ['EVIDENCE_INSUFFICIENT', 'TASK_COMPLEXITY', 'REPAIR_FAILED', 'DESIGN_ERROR'] as const

/**
 * Wrap a role result schema in exclusive success and escalation responses.
 * @param output - complete successful result fields.
 * @returns object-rooted schema accepted by the structured-output tool.
 */
export function roleResponseSchema(output: ObjectJsonSchema): ObjectJsonSchema {
  const result = {
    type: 'object', additionalProperties: false, required: ['response'], properties: {
      response: { oneOf: [
        { type: 'object', additionalProperties: false, required: ['status', 'output'], properties: { status: { type: 'string', const: 'success' }, output } },
        { type: 'object', additionalProperties: false, required: ['status', 'reason', 'details', 'partial'], properties: {
          status: { type: 'string', const: 'escalate' }, reason: { type: 'string', enum: [...reasons] }, details: { type: 'string' },
          partial: { type: 'object', additionalProperties: false, required: ['observations', 'unresolvedQuestions'], properties: {
            observations: { type: 'array', items: { type: 'string' } }, unresolvedQuestions: { type: 'array', items: { type: 'string' } },
          } },
        } },
      ] },
    },
  }
  assertObjectJsonSchema(result)
  return result
}

/**
 * Validate envelopes without treating malformed envelopes as legacy successes.
 * @param value - executor response; direct raw successes are supported for injected executors.
 * @param successSchema - authoritative successful result validation.
 * @returns unwrapped successful fields; explicit escalation throws a typed failure.
 */
export function unwrapRoleResponse(value: unknown, successSchema: object): unknown {
  if (value === null || typeof value !== 'object' || !('response' in value)) return value
  const partialSchema = { type: 'object', additionalProperties: false, required: ['observations', 'unresolvedQuestions'], properties: {
    observations: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: 2000 } },
    unresolvedQuestions: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: 2000 } },
  } }
  const definitions = 'definitions' in successSchema ? successSchema.definitions : undefined
  const schema = { ...(definitions === undefined ? {} : { definitions }), type: 'object', additionalProperties: false, required: ['response'], properties: { response: { oneOf: [
    { type: 'object', additionalProperties: false, required: ['status', 'output'], properties: { status: { const: 'success' }, output: successSchema } },
    { type: 'object', additionalProperties: false, required: ['status', 'reason', 'details', 'partial'], properties: {
      status: { const: 'escalate' }, reason: { enum: reasons }, details: { type: 'string', minLength: 1, maxLength: 4000, pattern: '\\S' }, partial: partialSchema,
    } },
  ] } } }
  const validate = new Ajv({ strict: true, allErrors: true }).compile(schema)
  if (!validate(value)) throw new RoleInvocationError(`Invalid role response: ${JSON.stringify(validate.errors)}`, 'SCHEMA_INVALID', true)
  const response = value.response
  if (response === null || typeof response !== 'object') throw new Error('Invalid role response object')
  if ('status' in response && response.status === 'success' && 'output' in response) return response.output
  if (!('reason' in response) || !reasons.includes(response.reason as typeof reasons[number]) || !('details' in response) || typeof response.details !== 'string' || !('partial' in response)) throw new Error('Invalid capability response')
  const partial = response.partial
  if (partial === null || typeof partial !== 'object' || !('observations' in partial) || !Array.isArray(partial.observations) || !('unresolvedQuestions' in partial) || !Array.isArray(partial.unresolvedQuestions)) throw new Error('Invalid capability partial')
  throw new CapabilityInsufficientError(response.reason as typeof reasons[number], response.details, {
    observations: partial.observations.map(String), unresolvedQuestions: partial.unresolvedQuestions.map(String),
  })
}
