import { Context } from '@deepseek-ai/cordis'
import { LocalSpillStore } from '@deepseek-ai/dsh-spill-local'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SpillLocator } from '@deepseek-ai/dsh-spill'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import * as locators from './snapshot-spill-locators.ts'
import * as reads from '../snapshots/session/session-query-spill/resolve-spill-read.mjs'

it.skipIf(process.platform === 'win32')('resolves stable spill locators for reads and restores the store', async () => {
  const root = await mkdtemp(join(tmpdir(), "query-spill-'quoted-"))
  const ctx = new Context()
  const disposers: (() => Promise<void>)[] = []
  try {
    for (const fiber of [
      ctx.plugin(LocalSpillStore, { root, cleanupPeriodDays: 0 }),
      ctx.plugin(LocalFileSystem, { cwd: root }),
    ]) {
      disposers.push(() => fiber.dispose())
      await fiber
    }
    const logical = resolve('/tmp/dsh-acp-snap-query-verifier')
    const mapping = ctx.plugin(locators, { root, locatorRoot: logical })
    disposers.push(() => mapping.dispose())
    await mapping
    const saved = await ctx.spillStore.saveText({
      owner: { sessionId: SessionId('query-verifier') },
      source: { kind: 'tool', toolName: 'session_event_read', callId: ToolCallId('query'), label: 'result' },
      suggestedName: 'session_event_read.txt', content: 'request/header session_event_search',
    })
    const adapter = ctx.plugin(reads)
    disposers.push(() => adapter.dispose())
    await adapter
    const page = await ctx.spillStore.readText({ locator: saved.locator })
    expect(page.lines).toEqual([{ number: 1, text: 'request/header session_event_search' }])
    await adapter.dispose()
    await expect(ctx.spillStore.readText({ locator: saved.locator })).rejects.toThrow('outside the configured spill root')
    await expect(ctx.spillStore.readText({ locator: SpillLocator('/outside/session_event_read.txt') })).rejects.toThrow('outside the configured spill root')
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    await rm(root, { recursive: true, force: true })
  }
})
