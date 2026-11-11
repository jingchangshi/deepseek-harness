import { describe, expect, it } from 'vitest'
import { replyToBinding, validateBindings } from '../src/bindings.ts'

describe('program binding validation', () => {
  it.each(['$name', '', 'while', 'lambda', 'console'])('rejects unusable global %s', (global) => {
    expect(() => validateBindings({ program: '', bindings: [{ global, functions: {} }] })).toThrow()
  })
  it('rejects duplicated globals and accepts arbitrary own member names', () => {
    const functions = Object.create(null) as Record<string, () => Promise<string>>
    functions.__proto__ = async () => 'own'
    expect(validateBindings({ program: '', bindings: [{ global: 'tools', functions }] }).get('tools')?.functions).toBe(functions)
    expect(() => validateBindings({ program: '', bindings: [{ global: 'tools', functions }, { global: 'tools', functions }] })).toThrow('duplicate')
  })
  it.each(['$name', 'while', 'console', 'tools'])('rejects invalid error class name %s', (name) => {
    expect(() => validateBindings({ program: '', bindings: [{ global: 'tools', functions: {}, errorClass: { name, memberNameProperty: 'member' } }] })).toThrow()
  })
  it.each(['', 'name', '__member__'])('rejects invalid error member %s', (memberNameProperty) => {
    expect(() => validateBindings({ program: '', bindings: [{ global: 'tools', functions: {}, errorClass: { name: 'ToolError', memberNameProperty } }] })).toThrow()
  })
  it('rejects two injected constructors with the same name', () => {
    expect(() => validateBindings({ program: '', bindings: ['first', 'second'].map(global => ({ global, functions: {}, errorClass: { name: 'ToolError', memberNameProperty: 'member' } })) })).toThrow('duplicate')
  })
})
describe('failed binding replies', () => {
  const fail = (error: unknown): (() => Promise<never>) => () => Promise.reject(error)

  it('forwards a rejection code so the program can branch on it', async () => {
    const coded = Object.assign(new Error('write scope rejected'), { code: 'TEAM_INVALID_WRITE_SCOPE' })
    await expect(replyToBinding(1, fail(coded), {})).resolves.toEqual({
      type: 'reply', id: 1, ok: false, message: 'write scope rejected', code: 'TEAM_INVALID_WRITE_SCOPE',
    })
  })

  it('sends NO code key when the rejection carries no structured identity', async () => {
    // Absence must stay distinguishable from a value: a tool that reports no
    // structured error rejects exactly as it did before this field existed.
    const reply = await replyToBinding(2, fail(new Error('denied')), {})
    expect(reply).toEqual({ type: 'reply', id: 2, ok: false, message: 'denied' })
    expect(Object.hasOwn(reply, 'code')).toBe(false)
  })

  it.each([
    ['a non-string code', Object.assign(new Error('x'), { code: 42 })],
    ['an empty code', Object.assign(new Error('x'), { code: '' })],
    ['an explicitly undefined code', Object.assign(new Error('x'), { code: undefined })],
    ['a non-object rejection', 'raw-string'],
  ])('drops %s rather than fabricating an identity', async (_label, value) => {
    const reply = await replyToBinding(3, fail(value), {})
    expect(reply.ok).toBe(false)
    expect(Object.hasOwn(reply, 'code')).toBe(false)
  })

  it('still answers when reading the code itself throws', async () => {
    const hostile = Object.defineProperty(new Error('hostile'), 'code', {
      get: () => { throw new Error('getter exploded') },
    })
    await expect(replyToBinding(4, fail(hostile), {})).resolves.toEqual({
      type: 'reply', id: 4, ok: false, message: 'hostile',
    })
  })
})
