/** Repository-defined tiers and monotonic scoped verification requirements. */

import { posix } from 'node:path'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { verificationInstanceId } from './verification.ts'
import type { VerificationGate, VerificationInstanceId } from './verification.ts'

/** Ordered acceptance levels; a higher level includes each lower level. */
export const ACCEPTANCE_TIERS = ['development', 'presubmit', 'qualification'] as const

/** One policy-selected acceptance level. */
export type AcceptanceTier = typeof ACCEPTANCE_TIERS[number]

/** Repository instance reference with an explicit JSON scope. */
export interface VerificationReference {
  name: string
  scope: Record<string, JsonValue>
}

/** Validated repository requirements, independent of compiler and execution provider. */
export interface VerificationPolicy {
  schemaVersion: 1
  defaultTier: AcceptanceTier
  allowedTiers: AcceptanceTier[]
  alwaysRequired: VerificationReference[]
  tiers: Record<AcceptanceTier, VerificationReference[]>
  impactRules: Array<{ paths: string[]; require: VerificationReference[] }>
}

/** Cumulative required instances and their deterministic or model requirement sources. */
export interface VerificationRequirements {
  tier: AcceptanceTier
  instances: Array<{ id: VerificationInstanceId; sources: string[] }>
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`)
  return Object.fromEntries(Object.entries(value))
}

function tier(value: unknown): AcceptanceTier {
  if (value !== 'development' && value !== 'presubmit' && value !== 'qualification') throw new Error('invalid acceptance tier')
  return value
}

function references(value: unknown, field: string): VerificationReference[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an instance array`)
  return value.map(entry => {
    const reference = object(entry, field)
    if (typeof reference.name !== 'string' || reference.name.length === 0) throw new Error(`${field} requires an instance name`)
    if (!isJsonValue(reference.scope)) throw new Error(`${field} scope must be lossless JSON`)
    return { name: reference.name, scope: object(reference.scope, `${field}.scope`) as Record<string, JsonValue> }
  })
}

/**
 * Parse policy declarations and reject unknown tiers, malformed scope data and escaping patterns.
 * @param value - parsed repository YAML; undefined selects development with profile requirements only.
 * @returns validated policy without model-selected reductions.
 */
export function resolveVerificationPolicy(value: unknown): VerificationPolicy {
  if (value === undefined) return {
    schemaVersion: 1, defaultTier: 'development', allowedTiers: ['development'], alwaysRequired: [],
    tiers: { development: [], presubmit: [], qualification: [] }, impactRules: [],
  }
  const source = object(value, 'verification policy')
  if (source.schemaVersion !== 1 || !Array.isArray(source.allowedTiers) || !Array.isArray(source.impactRules)) throw new Error('invalid verification policy')
  const defaultTier = tier(source.defaultTier)
  const allowedTiers = source.allowedTiers.map(tier)
  if (!allowedTiers.includes(defaultTier) || new Set(allowedTiers).size !== allowedTiers.length) throw new Error('invalid allowed acceptance tiers')
  const declarations = object(source.tiers, 'policy tiers')
  const tiers = {
    development: references(declarations.development, 'development requirements'),
    presubmit: references(declarations.presubmit, 'presubmit requirements'),
    qualification: references(declarations.qualification, 'qualification requirements'),
  }
  const impactRules = source.impactRules.map(entry => {
    const rule = object(entry, 'impact rule')
    if (!Array.isArray(rule.paths) || rule.paths.length === 0 || !rule.paths.every(path => typeof path === 'string'
      && path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
      && !path.split('/').some(component => component === '..' || component === '.' || component === '') && !/^[a-z]:/i.test(path))) {
      throw new Error('impact paths must be repository-relative POSIX patterns')
    }
    return { paths: rule.paths as string[], require: references(rule.require, 'impact requirements') }
  })
  return { schemaVersion: 1, defaultTier, allowedTiers, alwaysRequired: references(source.alwaysRequired, 'always required'), tiers, impactRules }
}

/**
 * Form the cumulative union of profile, tier, path-impact and model-extra requirements.
 * @param gates - validated profile instances.
 * @param policy - repository-owned requirements.
 * @param paths - observed baseline-to-current source paths, including deleted and renamed old paths.
 * @param extras - frozen model-proposed additional instances.
 * @param selectedTier - explicit user level; cannot lower the policy default.
 * @param previous - previous attempt's cumulative requirements, if present.
 * @returns required instances with sorted identities and requirement sources.
 */
export function resolveVerificationRequirements(
  gates: readonly VerificationGate[], policy: VerificationPolicy, paths: readonly string[],
  extras: readonly VerificationReference[] = [], selectedTier?: AcceptanceTier, previous?: VerificationRequirements,
): VerificationRequirements {
  const selected = selectedTier === undefined ? policy.defaultTier : tier(selectedTier)
  if (!policy.allowedTiers.includes(selected) || ACCEPTANCE_TIERS.indexOf(selected) < ACCEPTANCE_TIERS.indexOf(policy.defaultTier)) throw new Error('acceptance tier cannot be lowered or undeclared')
  if (previous !== undefined && previous.tier !== selected) throw new Error('acceptance tier changed; explicitly replan')
  const declared = new Set(gates.map(verificationInstanceId))
  const requirements = new Map<VerificationInstanceId, Set<string>>()
  const add = (reference: VerificationReference, reason: string): void => {
    const id = verificationInstanceId(reference)
    if (!declared.has(id)) throw new Error(`verification policy references an undeclared instance: ${reference.name}`)
    const sources = requirements.get(id) ?? new Set<string>()
    sources.add(reason)
    requirements.set(id, sources)
  }
  for (const reference of [...policy.alwaysRequired, ...Object.values(policy.tiers).flat(), ...policy.impactRules.flatMap(rule => rule.require), ...extras]) {
    if (!declared.has(verificationInstanceId(reference))) throw new Error(`verification policy references an undeclared instance: ${reference.name}`)
  }
  for (const instance of previous?.instances ?? []) {
    if (!declared.has(instance.id)) throw new Error('previous required instance disappeared; explicitly replan')
    requirements.set(instance.id, new Set(instance.sources))
  }
  for (const gate of gates.filter(gate => gate.required)) add(gate, 'profile')
  for (const reference of policy.alwaysRequired) add(reference, 'always-required')
  for (const level of ACCEPTANCE_TIERS.slice(0, ACCEPTANCE_TIERS.indexOf(selected) + 1)) {
    for (const reference of policy.tiers[level]) add(reference, `tier:${level}`)
  }
  for (const [index, rule] of policy.impactRules.entries()) {
    if (paths.some(path => rule.paths.some(pattern => posix.matchesGlob(path, pattern)))) {
      for (const reference of rule.require) add(reference, `impact:${String(index)}`)
    }
  }
  for (const reference of extras) add(reference, 'model-extra')
  return { tier: selected, instances: [...requirements].sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)
    .map(([id, sources]) => ({ id, sources: [...sources].sort() })) }
}

/**
 * Apply the frozen required set without removing any profile instance or its optional result.
 * @param gates - all declared profile instances.
 * @param requirements - cumulative required identities.
 * @returns profile instances with deterministic required flags.
 */
export function requiredVerificationGates(gates: readonly VerificationGate[], requirements: VerificationRequirements): VerificationGate[] {
  const required = new Set(requirements.instances.map(instance => instance.id))
  return gates.map(gate => ({ ...gate, required: required.has(verificationInstanceId(gate)) }))
}
