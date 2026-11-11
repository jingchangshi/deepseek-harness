import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'

/**
 * The sharp edge this suite guards.
 *
 * Every natural program reads `result.stdout.text`, because that is the shape
 * of the common FOREGROUND result. Before the union was made uniform, the
 * 'promoted' and 'background' members carried no `stdout` at all, so exactly
 * that program died with `TypeError: Cannot read properties of undefined
 * (reading 'text')` on the SLOWEST commands — the ones whose output matters
 * most — and the crash replaced the result the model needed. The rule under
 * test: a stream view exists on EVERY member and is never undefined.
 */

const testToolSignal = new AbortController().signal
const spillDir = mkdtempSync(join(tmpdir(), 'dsh-tool-bash-union-spec-'))

/** Job harness with a fast registry pump, so promotion and background are reachable. */
async function setup() {
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, { pumpPollMs: 25 })
  await ctx.plugin(ToolTasks)
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
  await ctx.plugin(ToolBash)
  return ctx
}

let callCounter = 0
function call(ctx: Context, args: Record<string, unknown>) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`union-call-${++callCounter}`),
    name: 'bash',
    arguments: args,
  })
}

/** The three union members as the model-facing value, with the stream views optional in the type on purpose. */
interface StreamView { readonly text: string; readonly truncated: boolean }
interface UnionValue {
  readonly kind: 'foreground' | 'promoted' | 'background'
  readonly exitCode?: number | null
  readonly output?: string
  readonly stdout?: StreamView
  readonly stderr?: StreamView
}

/** Kill a leftover job so a held process never outlives its test. */
function cleanup(ctx: Context): void {
  for (const job of ctx.jobs.list()) ctx.jobs.kill(job.id, undefined, 'test cleanup')
}

describe('uniform stream views across the bash result union', () => {
  it('exposes the sampled output as stdout.text on a promoted result', async () => {
    const ctx = await setup()
    const result = await call(ctx, {
      command: 'printf "promoted-line\\n"; sleep 30',
      description: 'test command',
      timeoutMs: 250,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a promoted result')
    const value = result.value as unknown as UnionValue
    expect(value.kind).toBe('promoted')
    // The accessor the trap broke: present, and carrying the output so far.
    expect(value.stdout).toBeDefined()
    expect(value.stdout?.text).toContain('promoted-line')
    expect(value.stderr).toEqual({ text: '', truncated: false })
    // The pre-existing field stays and carries the same text, so a caller that
    // already reads `output` keeps working unchanged.
    expect(value.output).toContain('promoted-line')
    cleanup(ctx)
  })

  it('reports an empty stdout.text rather than undefined when a promoted call produced no output', async () => {
    const ctx = await setup()
    const result = await call(ctx, { command: 'sleep 30', description: 'test command', timeoutMs: 200 })
    if (result.isError) throw new Error('expected a promoted result')
    const value = result.value as unknown as UnionValue
    expect(value.kind).toBe('promoted')
    // The promotion notice lives in `output`, so the sampled stream is empty —
    // but the field itself is still a readable view, not undefined.
    expect(value.stdout).toEqual({ text: '', truncated: false })
    expect(value.stderr).toEqual({ text: '', truncated: false })
    cleanup(ctx)
  })

  it('exposes empty-text stream views on a background ack', async () => {
    const ctx = await setup()
    const ack = await call(ctx, {
      command: 'printf "bg\\n"; sleep 1',
      description: 'test command',
      run_in_background: true,
    })
    if (ack.isError) throw new Error('expected a background ack')
    const value = ack.value as unknown as UnionValue
    expect(value.kind).toBe('background')
    // Nothing has been read from the job yet, so both views are present and
    // empty; collect real output with job_output.
    expect(value.stdout).toEqual({ text: '', truncated: false })
    expect(value.stderr).toEqual({ text: '', truncated: false })
    cleanup(ctx)
  })

  it('leaves the foreground result unchanged, including its real split streams', async () => {
    const ctx = await setup()
    const result = await call(ctx, { command: 'printf "out\\n"; printf "err\\n" >&2', description: 'test command' })
    if (result.isError) throw new Error('expected a foreground result')
    const value = result.value as unknown as UnionValue
    expect(value.kind).toBe('foreground')
    expect(value.exitCode).toBe(0)
    // The foreground member keeps its REAL split streams: the uniform accessor
    // must not have collapsed them into the single merged job ring.
    expect(value.stdout?.text).toBe('out\n')
    expect(value.stderr?.text).toBe('err\n')
  })

  it('declares stdout and stderr on every union member and states the rule in the description', async () => {
    const ctx = await setup()
    const tool = ctx.tools.get('bash')
    const declared = tool?.output?.schema as { oneOf: Array<{ properties: Record<string, unknown> }> }
    expect(declared.oneOf).toHaveLength(3)
    // Each of the three members declares both stream views, so the schema
    // cannot drift back into a union whose members disagree.
    for (const member of declared.oneOf) {
      expect(member.properties, 'every member declares stdout').toHaveProperty('stdout')
      expect(member.properties, 'every member declares stderr').toHaveProperty('stderr')
    }
    expect(tool?.description).toContain('Every result carries')
    expect(tool?.description).toContain('continue with job_output')
  })
})
