import { resolve } from 'node:path'
import { join } from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { loadProjectVerificationConfig, loadVerificationProfile, resolveCommandAdapter, resolveVerificationCommand, runCommand, runVerificationProfile, validateVerificationProfileId, verificationEvidence, verificationInstanceId } from '../src/verification.ts'
import { identityDigest } from '../src/identity.ts'

const ROOT = resolve(import.meta.dirname, '../../..')

describe('verification profiles', () => {
  it('refuses identity-bearing execution without a repository preflight', async () => {
    const identity = {
      attempt: 1,
      sourceTreeDigest: identityDigest<'SourceTreeDigest'>('source'),
      verificationPolicyDigest: identityDigest<'VerificationPolicyDigest'>('policy'),
      repositoryProfileDigest: identityDigest<'RepositoryProfileDigest'>('profile'),
      requiredSetDigest: identityDigest<'RequiredSetDigest'>('required'),
    }
    await expect(runVerificationProfile(ROOT, 'scoped', { adapters: {} }, undefined, [], undefined, identity))
      .rejects.toThrow('identity-bearing verification requires repository preflight')
  })

  it('checks preflight before each dispatch and stops before a drifted second command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-preflight-'))
    try {
      const gates = ['first', 'second'].map(name => ({ name, category: 'unit', scope: {}, adapter: name, required: true, timeoutMs: 30000 }))
      const adapters = Object.fromEntries(gates.map(gate => [gate.name, {
        executable: process.execPath, args: ['-e', `require('node:fs').appendFileSync('executions',${JSON.stringify(`${gate.name}\n`)})`],
      }]))
      let preflights = 0
      await expect(runVerificationProfile(root, 'scoped', { adapters }, undefined, gates, undefined, undefined, async () => {
        preflights++
        if (preflights === 2) throw new Error('verification identity changed')
      })).rejects.toThrow('verification identity changed')
      expect(preflights).toBe(2)
      expect(await readFile(join(root, 'executions'), 'utf8')).toBe('first\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('starts no command when cancellation arrives during preflight', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-preflight-cancel-'))
    const controller = new AbortController()
    try {
      const gate = { name: 'unit', category: 'unit', scope: {}, adapter: 'unit', required: true, timeoutMs: 30000 }
      await expect(runVerificationProfile(root, 'scoped', { adapters: {
        unit: { executable: process.execPath, args: ['-e', "require('node:fs').writeFileSync('executions','started')"] },
      } }, controller.signal, [gate], undefined, undefined, async () => { controller.abort() })).rejects.toThrow()
      await expect(readFile(join(root, 'executions'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      controller.abort()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves a named container runner against the selected repository rather than the installation cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-runner-'))
    try {
      const filename = join(root, 'commands.yaml')
      await writeFile(filename, JSON.stringify({ runners: { build: { kind: 'docker', executable: '/usr/bin/docker', container: 'build-container', user: 'builder', home: '/home/builder', workingDirectory: '{{PROJECT_ROOT}}' } },
        commands: { build: { runner: 'build', executable: 'ninja', args: ['-j', '64'], env: { set: { USE_CUDA: 'OFF' }, inherit: [] } } } }))
      const project = await loadProjectVerificationConfig(filename)
      const command = project.adapters.build
      if (command === undefined) throw new Error('named command missing')
      const invocation = resolveVerificationCommand(root, command)
      expect(invocation).toMatchObject({ kind: 'docker', workingDirectory: root, executable: '/usr/bin/docker' })
      expect(invocation.args).toContain(root)
      expect(invocation.args).toContain('USE_CUDA=OFF')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('canonicalizes nested object keys while preserving scope array order', () => {
    expect(verificationInstanceId({ name: 'parse', scope: { options: { second: 2, first: 1 }, modes: ['a', 'b'] } }))
      .toBe(verificationInstanceId({ name: 'parse', scope: { modes: ['a', 'b'], options: { first: 1, second: 2 } } }))
    expect(verificationInstanceId({ name: 'parse', scope: { modes: ['a', 'b'] } }))
      .not.toBe(verificationInstanceId({ name: 'parse', scope: { modes: ['b', 'a'] } }))
  })

  it('projects resolved command evidence with fresh references for repeated executions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-evidence-'))
    try {
      await mkdir(join(root, '.agent/profiles'), { recursive: true })
      await writeFile(join(root, '.agent/profiles/scoped.yaml'), JSON.stringify({
        schemaVersion: 1, id: 'scoped', checks: [{ name: 'parse', category: 'source', required: true, timeoutMs: 30000, scope: { backend: 'one' } }],
      }))
      const configuration = { adapters: { parse: { executable: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', '{{PROJECT_ROOT}}'] } } }
      const first = await runVerificationProfile(root, 'scoped', configuration)
      const firstEvidence = verificationEvidence(root, first)
      const second = await runVerificationProfile(root, 'scoped', configuration)
      const secondEvidence = verificationEvidence(root, second)
      expect(firstEvidence[0]).toMatchObject({
        scope: { name: 'parse', category: 'source', verificationScope: { backend: 'one' }, stdout: root },
        command: { executable: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', root], cwd: root, exitCode: 0, timedOut: false },
      })
      expect(firstEvidence[0]?.id).not.toBe(secondEvidence[0]?.id)
      expect(first.verification.checks[0]?.evidenceIds).toEqual([firstEvidence[0]?.id])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('executes same-name scoped instances independently with separate adapter selectors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-scoped-'))
    try {
      await mkdir(join(root, '.agent/profiles'), { recursive: true })
      await writeFile(join(root, '.agent/profiles/scoped.yaml'), JSON.stringify({
        schemaVersion: 1, id: 'scoped', checks: ['first', 'second'].map(adapter => ({
          name: 'codegen', category: 'source', required: true, timeoutMs: 30000, adapter, scope: { backend: adapter },
        })),
      }))
      const result = await runVerificationProfile(root, 'scoped', { adapters: {
        first: { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
        second: { executable: process.execPath, args: ['-e', 'process.exit(7)'] },
      } })
      expect(result.verification.status).toBe('FAIL')
      expect(result.verification.checks).toEqual([
        expect.objectContaining({ name: 'codegen', category: 'source', scope: { backend: 'first' }, status: 'PASS' }),
        expect.objectContaining({ name: 'codegen', category: 'source', scope: { backend: 'second' }, status: 'FAIL' }),
      ])
      expect(result.results).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects canonical duplicate scopes and non-JSON scopes before execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-scoped-json-'))
    try {
      await mkdir(join(root, '.agent/profiles'), { recursive: true })
      const filename = join(root, '.agent/profiles/scoped.yaml')
      const check = { name: 'parse', category: 'source', required: true, timeoutMs: 30000 }
      await writeFile(filename, JSON.stringify({ schemaVersion: 1, id: 'scoped', checks: [
        { ...check, scope: { backend: 'one', modes: ['a', 'b'] } },
        { ...check, category: 'different', scope: { modes: ['a', 'b'], backend: 'one' } },
      ] }))
      await expect(loadVerificationProfile(root, 'scoped')).rejects.toThrow('duplicate')
      await writeFile(filename, 'schemaVersion: 1\nid: scoped\nchecks:\n  - name: parse\n    category: source\n    required: true\n    timeoutMs: 30000\n    scope:\n      timestamp: 2026-10-06\n')
      await expect(loadVerificationProfile(root, 'scoped')).rejects.toThrow('JSON')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['../outside', 'Uppercase', 'has_space', '', 'compiler\n', 'compiler\r', '-compiler', 42, null])(
    'rejects profile ID %j', profile => {
      expect(() => validateVerificationProfileId(profile)).toThrow('invalid verification profile ID')
    },
  )

  it('requires a matching declaration and valid gates in an arbitrary profile file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-profile-id-'))
    try {
      await mkdir(join(root, '.agent/profiles'), { recursive: true })
      const filename = join(root, '.agent/profiles/synthetic-compiler.yaml')
      await expect(loadVerificationProfile(root, 'synthetic-compiler')).rejects.toMatchObject({ code: 'ENOENT' })
      const check = { name: 'parse', category: 'source', required: true, timeoutMs: 1000 }
      await writeFile(filename, JSON.stringify({ schemaVersion: 1, id: 'different-compiler', checks: [check] }))
      await expect(loadVerificationProfile(root, 'synthetic-compiler')).rejects.toThrow('invalid synthetic-compiler profile')
      await writeFile(filename, JSON.stringify({ schemaVersion: 1, id: 'synthetic-compiler', checks: [{ ...check, required: 'yes' }] }))
      await expect(loadVerificationProfile(root, 'synthetic-compiler')).rejects.toThrow('required must be boolean')
      await writeFile(filename, JSON.stringify({ schemaVersion: 1, id: 'synthetic-compiler', checks: [check] }))
      await expect(loadVerificationProfile(root, 'synthetic-compiler')).resolves.toEqual([{ ...check, scope: {}, adapter: 'parse' }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves a standalone project-root argument without interpolating command text', () => {
    expect(resolveCommandAdapter('/target/project', {
      executable: 'docker', args: ['exec', '-w', '{{PROJECT_ROOT}}', 'container', 'command'],
    }).args).toEqual(['exec', '-w', resolve('/target/project'), 'container', 'command'])
    expect(() => resolveCommandAdapter('/target/project', {
      executable: 'docker', args: ['exec', 'prefix={{PROJECT_ROOT}}'],
    })).toThrow('must be a complete command argument')
  })

  it('loads compiler and webapp gates with explicit optional scope', async () => {
    expect((await loadVerificationProfile(ROOT, 'compiler')).map(check => check.name)).toContain('ir-verify')
    expect((await loadVerificationProfile(ROOT, 'webapp')).map(check => check.name)).toContain('database-migration')
  })

  it('distinguishes pass, process failure, timeout, and missing adapters', async () => {
    await expect(runCommand(ROOT, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }, 1000))
      .resolves.toMatchObject({ status: 'PASS', exitCode: 0, timedOut: false })
    await expect(runCommand(ROOT, { executable: process.execPath, args: ['-e', 'process.exit(7)'] }, 1000))
      .resolves.toMatchObject({ status: 'FAIL', exitCode: 7, timedOut: false })
    await expect(runCommand(ROOT, { executable: process.execPath, args: ['-e', 'setTimeout(()=>{}, 10000)'] }, 20))
      .resolves.toMatchObject({ status: 'FAIL', timedOut: true })

    const result = await runVerificationProfile(ROOT, 'small-feature', {
      adapters: { typecheck: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } },
    })
    expect(result.verification.status).toBe('NOT_RUN')
    expect(result.verification.checks).toContainEqual(expect.objectContaining({ name: 'build', status: 'NOT_RUN' }))
  })

  it('preserves target and mode matrices in compiler scope', async () => {
    const pass = { executable: process.execPath, args: ['-e', 'process.exit(0)'] }
    const result = await runVerificationProfile(ROOT, 'compiler', {
      adapters: { build: pass, unit: pass, 'ir-verify': pass, reference: pass },
      scope: { targets: { A5: 'PASS', A3: 'NOT_RUN' }, modes: { PureAIV: 'PASS', MixCV: 'NOT_RUN' } },
    })
    expect(result.verification).toMatchObject({ status: 'PASS', scope: { targets: { A3: 'NOT_RUN' } } })
  })

  it.skipIf(process.platform === 'win32')('cancels the local process group and waits for inherited output handles to close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-cancel-'))
    const controller = new AbortController()
    const command = runCommand(root, {
      executable: process.execPath,
      args: ['-e', "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});require('fs').writeFileSync('ready',String(process.pid));setInterval(()=>{},1000)"],
    }, 30000, controller.signal)
    try {
      await vi.waitFor(async () => { expect(await readFile(join(root, 'ready'), 'utf8')).toMatch(/^\d+$/) })
      controller.abort()
      await expect(command).resolves.toMatchObject({ status: 'INCOMPLETE', timedOut: false })
    } finally {
      controller.abort()
      await command
      await rm(root, { recursive: true, force: true })
    }
  })
})
