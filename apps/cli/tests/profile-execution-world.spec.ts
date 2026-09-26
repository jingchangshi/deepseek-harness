import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))

it.for(Object.keys(PROFILE_TEMPLATES))('composes execution identity only in base-backed %s', (name) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profile-world-'))
  try {
    const profile = loadProfile('dsh', name, installAnchor, home)
    const layers = [...profile.layers.map(layer => layer.patches), profile.patches]
    const rows = composeEntries(layers)
    const identities = rows.filter(row => row.name === '@deepseek-ai/dsh-execution-world')
    if (name === 'sdk-minimal') {
      expect(identities).toEqual([])
      return
    }
    expect(identities).toHaveLength(1)
    const identity = identities[0]
    expect(identity?.config).toEqual({
      mode: 'persisted-local',
      allocationLockPath: { __jsExpr: "dshHomePath('locks', 'execution-world-identity.lock')" },
    })
    expect(rows.indexOf(identity!)).toBeGreaterThan(rows.findIndex(row => row.id === 'fs-sandbox'))
    const expression = (identity?.config as { allocationLockPath: { __jsExpr: string } }).allocationLockPath.__jsExpr
    expect(evaluate({ dshHomePath: (...parts: string[]) => join(home, ...parts) }, expression)).toBe(join(home, 'locks', 'execution-world-identity.lock'))
    const deployment = { mode: 'deployment', deploymentId: '00000000-0000-4000-8000-000000000001', allocationLockPath: join(home, 'remote.lock') }
    const patched = composeEntries([...layers, [{ id: 'execution-world-identity', config: deployment }]])
    expect(patched.filter(row => row.name === '@deepseek-ai/dsh-execution-world')).toEqual([
      { id: 'execution-world-identity', name: '@deepseek-ai/dsh-execution-world', config: deployment },
    ])
  } finally { rmSync(home, { recursive: true, force: true }) }
})
