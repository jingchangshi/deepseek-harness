/** IPC observer for real Browser Harness tools on Web-profile Sessions. */
export const inject = ['agents', 'tools']

export function apply(ctx) {
  let sequence = 0
  const receive = message => {
    if (message?.command !== 'probe') return
    void probe(message.url).then(result => process.send({ result }), error => process.send({ error: String(error.stack ?? error) }))
  }
  ctx.effect(() => {
    process.on('message', receive)
    return () => process.off('message', receive)
  })

  async function probe(url) {
    await ctx.loader.await()
    const reports = []
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const handle = await ctx.agents.create({ sessionId: `browser-harness-web-${process.pid}-${sequence++}`, cwd: process.cwd() })
      let ownedTab
      try {
        await handle.agent.whenIdle()
        const names = ctx.tools.schemas(handle.agent).map(tool => tool.name)
        const call = async (name, args) => {
          const result = await ctx.tools.execute({ name: `mcp__browser-harness__${name}`, arguments: args,
            agent: handle.agent, callId: `web-${attempt}-${name}`, signal: new AbortController().signal })
          if (result.isError) throw new Error(JSON.stringify(result.content))
          return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        }
        if (!names.includes('mcp__browser-harness__browser_page_info') || !names.includes('mcp__browser-harness__browser_list_tabs')) {
          throw new Error(`Session lacks Browser Harness tools: ${JSON.stringify(names)}`)
        }
        await call('browser_list_tabs', {})
        const created = JSON.parse((await call('browser_new_tab', { url })).split('\n', 1)[0])
        if (typeof created.targetId !== 'string') throw new Error(`Browser did not create a tab: ${JSON.stringify(created)}`)
        ownedTab = created.targetId
        await call('browser_wait_for_load', { timeout: 30 })
        const info = await call('browser_page_info', {})
        if (!info.includes('/probe')) throw new Error(`Browser did not open test-owned page: ${info}`)
        reports.push({ names, info })
      } finally {
        await handle.dispose()
        if (ownedTab) {
          const endpoint = process.env.BU_CDP_URL ?? 'http://127.0.0.1:9222'
          const closed = await fetch(`${endpoint}/json/close/${encodeURIComponent(ownedTab)}`)
          if (!closed.ok) throw new Error(`Could not close test-owned tab: ${closed.status}`)
        }
      }
    }
    return reports
  }
}
