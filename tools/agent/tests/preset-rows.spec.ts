import { describe, expect, it } from 'vitest'
import { classifyPresetRows, suppressPresetRows } from '../src/preset-rows.ts'

const delegationGroup = {
  id: 'delegation',
  name: 'cordis:group',
  group: true,
  config: [
    { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
    { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent' },
    { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc' },
  ],
}

describe('engineering preset row suppression', () => {
  it('removes only the delegation group holding the standing subagent tool', () => {
    const rows = [
      { id: 'persona', name: '@deepseek-ai/dsh-persona' },
      delegationGroup,
      { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
    ]
    const kept = suppressPresetRows(rows, classifyPresetRows(rows))
    expect(kept.map(row => row['id'])).toEqual(['persona', 'tool-goal'])
  })

  it('keeps a group that carries no subagent tool', () => {
    const rows = [{ id: 'planning', name: 'cordis:group', group: true, config: [{ id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode' }] }]
    const kept = suppressPresetRows(rows, classifyPresetRows(rows))
    expect(kept).toHaveLength(1)
    expect((kept[0]!['config'] as unknown[]).map(row => (row as Record<string, unknown>)['id'])).toEqual(['plan-mode'])
  })

  it('keeps plugin fields this planner does not model', () => {
    const rows = [
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: false },
      delegationGroup,
    ]
    const kept = suppressPresetRows(rows, classifyPresetRows(rows))
    expect(kept[0]).toEqual({ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: false })
  })

  it('leaves a plugin whose config is an array untouched', () => {
    const rows = [{ id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools', config: ['a', 'b'] }]
    const kept = suppressPresetRows(rows, classifyPresetRows(rows))
    expect(kept[0]!['config']).toEqual(['a', 'b'])
  })
})
