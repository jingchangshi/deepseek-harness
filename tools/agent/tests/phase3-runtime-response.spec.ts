import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { dump } from 'js-yaml'
import Ajv from 'ajv'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subagents from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { describe, expect, it } from 'vitest'
import { getEngineeringStatus } from '../src/automatic.ts'
import * as Runtime from '../runtime/index.ts'

class CapabilityAdapter extends LlmAdapter {
  private calls = 0

  constructor(private readonly response: object) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) throw new Error('Scripted model request aborted')
    if (++this.calls > 20) throw new Error('Scripted capability responses exhausted')
    const id = ToolCallId(`capability-${this.calls}`)
    const argumentsJson = JSON.stringify(this.response)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: 'structured_output', argumentsDelta: argumentsJson }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'structured_output', arguments: argumentsJson } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

describe('runtime capability response schema', () => {
  it('advertises a strict success-or-escalation envelope and never completes investigation from escalation output', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-runtime-capability-response-')))
    const deploymentRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-runtime-capability-response-deployment-')))
    const ctx = new Context()
    const controller = new AbortController()
    let pending: Promise<unknown> | undefined
    const validations: Array<{ escalation: boolean; success: boolean; mixed: boolean }> = []
    const recorded: unknown[] = []
    const escalation = { response: { status: 'escalate', reason: 'TASK_COMPLEXITY', details: 'Ownership analysis needs a stronger read-only role', partial: { observations: [], unresolvedQuestions: ['Who owns the pending write?'] } } }
    try {
      await cp(resolve('.agent'), join(root, '.agent'), { recursive: true, filter: source => !source.includes(join('.agent', 'tasks')) && !source.includes(join('.agent', 'reviews')) })
      await writeFile(join(root, 'a.txt'), 'A\n')
      await writeFile(join(root, 'b.txt'), 'B\n')
      await writeFile(join(root, '.agent/config/project.yaml'), dump({ schemaVersion: 1, profile: 'small-feature', adapter: '.agent/adapters/test.yaml', dataClass: 'public', maxSteps: 40, maxRoleCalls: 30, commandTimeoutMs: 30_000, investigationUnits: [
        { id: 'a', role: 'scout-primary', question: 'Inspect A', allowedPaths: ['a.txt'] },
        { id: 'b', role: 'scout-secondary', question: 'Inspect B', allowedPaths: ['b.txt'] },
      ] }))
      await writeFile(join(root, '.agent/adapters/test.yaml'), dump({ adapters: Object.fromEntries(['unit', 'typecheck', 'build'].map(name => [name, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }])) }))
      const modelsPath = join(root, '.agent/config/models.yaml')
      await writeFile(modelsPath, (await readFile(modelsPath, 'utf8')).replaceAll('${DSH_MAGPIE_GATEWAY_URL}', 'https://fixture.invalid/v1'))
      await execa('git', ['init', '-q'], { cwd: root })
      await execa('git', ['add', 'a.txt', 'b.txt'], { cwd: root })
      await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root })
      await cp(join(root, '.agent'), join(deploymentRoot, '.agent'), { recursive: true })
      await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(Subagents)
      ctx.llm.registerAdapter(['magpie', 'magpie-responses', 'company'], new CapabilityAdapter(escalation))
      ctx.on('tools/result', (execution, result) => {
        if (execution.name === 'structured_output' && !result.isError) recorded.push(result.value)
      })
      ctx.subagents.registerProvider({ name: 'spawn', inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, async start(request) {
        if (request.outputSchema === undefined) throw new Error('Runtime omitted structured role schema')
        const validate = new Ajv({ strict: true, allErrors: true }).compile(request.outputSchema)
        const output = { findings: ['Inspected bounded source'], hypotheses: [{ statement: 'The source is bounded', evidence: ['a.txt'] }], unresolvedAssumptions: [] }
        validations.push({ escalation: validate(escalation), success: validate({ response: { status: 'success', output } }), mixed: validate({ response: { ...escalation.response, output } }) })
        return startInProcessRun(request, {})
      } })
      await ctx.plugin(Runtime, { deploymentRoot, roleTimeoutMs: 30_000 })
      const parent = await ctx.agentLoop.create(SessionId('runtime-response-coordinator'), {}, { cwd: root })
      pending = parent.ctx.tools.execute({ callId: ToolCallId('runtime-response-run'), name: 'engineering_run', arguments: { request: 'Inspect the bounded source' }, signal: controller.signal, agent: parent })
      const result = await pending
      expect(validations.length, JSON.stringify(result)).toBeGreaterThan(0)
      expect(validations).toEqual(validations.map(() => ({ escalation: true, success: true, mixed: false })))
      expect(recorded.length).toBeGreaterThan(0)
      expect(recorded).toEqual(recorded.map(() => ({ recorded: true })))
      const task = (await getEngineeringStatus(root)).tasks[0]
      if (task === undefined) throw new Error('Missing capability-limited task')
      expect(task.state.state).not.toBe('ACCEPTED')
      await expect(readFile(join(root, '.agent/tasks', task.task.id, 'INVESTIGATION.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(task.state.writer).toBeNull()
    } finally {
      controller.abort()
      if (pending !== undefined) await Promise.allSettled([pending])
      await ctx.fiber.dispose()
      await Promise.all([rm(root, { recursive: true, force: true }), rm(deploymentRoot, { recursive: true, force: true })])
    }
  }, 30_000)
})
