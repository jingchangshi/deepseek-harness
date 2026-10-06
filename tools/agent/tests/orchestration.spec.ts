import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadHarnessConfig } from '../src/config.ts'
import { nextDispatches } from '../src/orchestration.ts'
import { smokeModelRoutes } from '../src/smoke.ts'
import type { TaskStateRecord } from '../src/types.ts'

const ROOT = resolve(import.meta.dirname, '../../..')
const state = (value: TaskStateRecord['state']): TaskStateRecord => ({
  schemaVersion: 1, taskId: 'task', state: value, revision: 4, workRevision: 1, fixAttempts: 0, writer: null, updatedAt: '2026-10-04T00:00:00.000Z',
})

describe('orchestration', () => {
  it('uses workflow only for the two independent scouts', async () => {
    const config = await loadHarnessConfig(ROOT)
    expect(nextDispatches(config, state('BASELINED'))).toEqual([
      expect.objectContaining({ role: 'scout-primary', toolName: 'ask_scout_primary', mode: 'workflow-fanout' }),
      expect.objectContaining({ role: 'scout-secondary', toolName: 'ask_scout_secondary', mode: 'workflow-fanout' }),
    ])
    expect(nextDispatches(config, state('VERIFIED'))).toEqual([
      expect.objectContaining({ role: 'reviewer', toolName: 'ask_reviewer', mode: 'plain' }),
    ])
    expect(nextDispatches(config, state('ACCEPTED'))).toEqual([])
  })

  it('records mock route diagnostics and explicit real-provider omissions', async () => {
    const config = await loadHarnessConfig(ROOT)
    const mock = await smokeModelRoutes(config)
    expect(mock.every(result => result.status === 'PASS')).toBe(true)
    expect(mock.every(result => result.checks['structured-output'] === 'NOT_RUN')).toBe(true)
    const real = await smokeModelRoutes(config, true)
    expect(real.every(result => result.status === 'NOT_RUN')).toBe(true)
    expect(real[0]).toMatchObject({ reason: expect.stringContaining('credentials') })
  })
})
