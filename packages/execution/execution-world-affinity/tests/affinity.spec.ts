import { describe, expect, it, vi } from 'vitest'
import { createExecutionWorldAffinity, HOST_EXECUTION_WORLD_AFFINITY } from '../src/index.ts'

describe('execution namespace affinity', () => {
  it('allocates distinct immutable owner tokens without location fields', () => {
    const first = createExecutionWorldAffinity()
    const second = createExecutionWorldAffinity()
    expect(first).not.toBe(second)
    expect(typeof first).toBe('symbol')
    expect(first.description).toBeUndefined()
    expect(first).not.toBe(HOST_EXECUTION_WORLD_AFFINITY)
  })

  it('shares the Host token across independently evaluated module instances', async () => {
    vi.resetModules()
    const other = await import('../src/index.ts')
    expect(other.createExecutionWorldAffinity).not.toBe(createExecutionWorldAffinity)
    expect(other.HOST_EXECUTION_WORLD_AFFINITY).toBe(HOST_EXECUTION_WORLD_AFFINITY)
    expect(other.createExecutionWorldAffinity()).not.toBe(createExecutionWorldAffinity())
  })
})
