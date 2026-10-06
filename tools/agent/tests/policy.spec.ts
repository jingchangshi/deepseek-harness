import { describe, expect, it } from 'vitest'
import { requiredVerificationGates, resolveVerificationPolicy, resolveVerificationRequirements } from '../src/policy.ts'
import { verificationInstanceId } from '../src/verification.ts'
import type { VerificationGate } from '../src/verification.ts'

const source: VerificationGate = { name: 'source', category: 'source', adapter: 'syntax', scope: {}, required: true, timeoutMs: 30000 }
const semantic: VerificationGate = { name: 'semantic', category: 'analysis', adapter: 'analysis', scope: { layer: 'IR' }, required: false, timeoutMs: 30000 }
const device: VerificationGate = { name: 'device', category: 'hardware', adapter: 'device', scope: { backend: 'fixture' }, required: false, timeoutMs: 30000 }
const gates = [source, semantic, device]
const declaration = {
  schemaVersion: 1, defaultTier: 'development', allowedTiers: ['development', 'presubmit', 'qualification'], alwaysRequired: [],
  tiers: { development: [], presubmit: [{ name: semantic.name, scope: semantic.scope }], qualification: [{ name: device.name, scope: device.scope }] },
  impactRules: [{ paths: ['compiler/**'], require: [{ name: semantic.name, scope: semantic.scope }] }],
}

describe('repository verification policy', () => {
  it('includes profile requirements without policy and leaves optional hardware optional', () => {
    const requirements = resolveVerificationRequirements(gates, resolveVerificationPolicy(undefined), [])
    expect(requiredVerificationGates(gates, requirements).map(gate => gate.required)).toEqual([true, false, false])
  })

  it.each(['compiler/analysis.cpp', 'compiler/deleted.cpp', 'compiler/nested/pass.cpp'])(
    'requires semantic analysis for observed path %s', path => {
      const requirements = resolveVerificationRequirements(gates, resolveVerificationPolicy(declaration), [path])
      expect(requirements.instances).toContainEqual({ id: verificationInstanceId(semantic), sources: ['impact:0'] })
    },
  )

  it('keeps required impact instances when a bounded fix removes the triggering path', () => {
    const policy = resolveVerificationPolicy(declaration)
    const first = resolveVerificationRequirements(gates, policy, ['compiler/pass.cpp'])
    expect(resolveVerificationRequirements(gates, policy, [], [], undefined, first)).toEqual(first)
  })

  it('includes all lower tiers at qualification', () => {
    const requirements = resolveVerificationRequirements(gates, resolveVerificationPolicy(declaration), [], [], 'qualification')
    expect(requiredVerificationGates(gates, requirements).every(gate => gate.required)).toBe(true)
  })

  it('unions model extras without removing profile requirements', () => {
    const requirements = resolveVerificationRequirements(gates, resolveVerificationPolicy(declaration), [], [{ name: device.name, scope: device.scope }])
    expect(requiredVerificationGates(gates, requirements).map(gate => gate.required)).toEqual([true, false, true])
  })

  it('rejects a borrowed name with a different scope', () => {
    expect(() => resolveVerificationRequirements(gates, resolveVerificationPolicy(declaration), [], [{ name: semantic.name, scope: {} }])).toThrow('undeclared instance')
  })

  it('rejects lowering a repository default or changing a frozen tier', () => {
    const policy = resolveVerificationPolicy({ ...declaration, defaultTier: 'presubmit' })
    expect(() => resolveVerificationRequirements(gates, policy, [], [], 'development')).toThrow('cannot be lowered')
    const previous = resolveVerificationRequirements(gates, policy, [])
    expect(() => resolveVerificationRequirements(gates, policy, [], [], 'qualification', previous)).toThrow('explicitly replan')
  })

  it.each(['/compiler/**', '../compiler/**', 'compiler\\**', 'compiler/./**', 'C:/compiler/**'])(
    'rejects non-relative or non-POSIX pattern %s', path => {
      expect(() => resolveVerificationPolicy({ ...declaration, impactRules: [{ paths: [path], require: [] }] })).toThrow('repository-relative POSIX patterns')
    },
  )

  it('validates declarations even when their tier or path does not apply', () => {
    const policy = resolveVerificationPolicy({ ...declaration, tiers: { ...declaration.tiers, qualification: [{ name: 'missing', scope: {} }] } })
    expect(() => resolveVerificationRequirements(gates, policy, [])).toThrow('undeclared instance')
  })
})
