/** Scripted HTTP provider; all DSH agents, tools, persistence, and verification remain real. */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

interface Message {
  role: string
  content?: string | null
  tool_calls?: Array<{ function: { name: string } }>
}

/** Observed external model request, used to inspect actual child tool permissions. */
export interface AutomaticModelRequest {
  model: string
  messages: Message[]
  tools?: Array<{ function: { name: string } }>
}

/** Select the scripted external response for an observed role request. */
export function automaticResponse(request: AutomaticModelRequest): { content: string } | { tool_calls: object[] } {
  const called = request.messages.flatMap(message => message.tool_calls?.map(call => call.function.name) ?? [])
  const tool = (name: string, args: object): { tool_calls: object[] } => ({
    tool_calls: [{ index: 0, id: `automatic-${called.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  })
  const json = (value: object): { content: string } => ({ content: JSON.stringify(value) })
  const finish = (value: object): { content: string } | { tool_calls: object[] } => request.tools?.some(entry => entry.function.name === 'structured_output')
    ? tool('structured_output', { response: { status: 'success', output: value } })
    : json(value)
  switch (request.model) {
    case 'coordinator':
      return called.includes('engineering_run')
        ? { content: request.messages.filter(message => message.role === 'tool').map(message => message.content ?? '').join('\n') }
        : tool('engineering_run', { request: 'Create answer.txt containing 42 and preserve existing.txt.', taskId: '' })
    case 'scout-primary':
    case 'scout-secondary':
      return finish({ findings: ['The requested output is answer.txt.'], hypotheses: [{ statement: 'All required commands must inspect the written file.', evidence: ['User request'] }], unresolvedAssumptions: [] })
    case 'architect':
      return finish({
        problemStatement: 'Create answer.txt containing 42.', hypotheses: ['A new text file satisfies this request.'],
        selectedApproach: 'Write answer.txt and run all compiler-profile commands.', rejectedAlternatives: ['Accept without command execution.'],
        invariants: ['Preserve existing.txt.'], expectedComponents: ['answer.txt'], implementationScope: ['answer.txt'],
        falsificationTests: ['A mismatched answer fails a command.'], acceptanceGates: ['build', 'unit', 'ir-verify', 'reference'], unresolvedAssumptions: [],
      })
    case 'challenger':
      return finish({ decision: 'ACCEPT', summary: 'Command checks distinguish a wrong answer.', findings: [] })
    case 'implementer':
      if (!called.includes('read')) return tool('read', { file_path: 'answer.txt' })
      if (!called.includes('write')) return tool('write', { file_path: 'answer.txt', content: '42\n' })
      return finish({ summary: 'Wrote answer.txt. Required checks belong to the driver.' })
    case 'reviewer':
      if (!called.includes('read')) return tool('read', { file_path: 'answer.txt' })
      return finish({ decision: 'ACCEPT', summary: 'The independent read and verification evidence agree.', findings: [] })
    default:
      throw new Error(`Unexpected model: ${request.model}`)
  }
}

/**
 * Start a private OpenAI-compatible SSE endpoint on an atomically allocated port.
 * @returns captured requests, endpoint URL, and an awaited shutdown operation.
 */
export async function automaticProvider(): Promise<{
  url: string
  requests: AutomaticModelRequest[]
  close: () => Promise<void>
}> {
  const requests: AutomaticModelRequest[] = []
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as AutomaticModelRequest
      requests.push(request)
      const delta = automaticResponse(request)
      const streamChunk = (value: object): string => `data: ${JSON.stringify({ id: 'automatic-completion', object: 'chat.completion.chunk', created: 1, model: request.model, ...value })}\n\n`
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
      outgoing.write(streamChunk({ choices: [{ index: 0, delta, finish_reason: null }] }))
      outgoing.write(streamChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }))
      outgoing.end('data: [DONE]\n\n')
    })().catch((error: unknown) => {
      outgoing.writeHead(500, { 'content-type': 'application/json' })
      outgoing.end(JSON.stringify({ error: { message: String(error) } }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error === undefined ? resolve() : reject(error))
      server.closeAllConnections()
    }),
  }
}
