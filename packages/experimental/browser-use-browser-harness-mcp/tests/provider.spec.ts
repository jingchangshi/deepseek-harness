import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import * as Provider from '../src/index.ts'

vi.mock('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp')>(),
  mountSessionMcp: vi.fn(),
}))
afterEach(() => vi.clearAllMocks())

/** Options handed to the shared runtime by the most recent apply() call. */
function mounted(): Parameters<typeof mountSessionMcp>[1] {
  return vi.mocked(mountSessionMcp).mock.calls[0]![1]
}

it('defaults to the installed Browser Harness server and reserves one browser lane', () => {
  Provider.apply(new Context(), Provider.Config({}))
  const options = mounted()
  // One shared daemon holds mutable current-tab state, so a second live Session
  // must never receive these tools concurrently.
  expect(options).toMatchObject({ name: 'browser-harness', exclusive: true, command: 'browser-harness-mcp', args: [] })
  expect('env' in options).toBe(false)
  expect('toolCallTimeoutMs' in options).toBe(false)
  expect('default' in Provider).toBe(false)
})

it('passes a configured command and timeout through to the MCP client', () => {
  Provider.apply(new Context(), Provider.Config({ command: 'uvx', args: ['--from', 'browser-harness[mcp]', 'browser-harness-mcp'], toolCallTimeoutMs: 30000 }))
  expect(mounted()).toMatchObject({
    name: 'browser-harness',
    exclusive: true,
    command: 'uvx',
    args: ['--from', 'browser-harness[mcp]', 'browser-harness-mcp'],
    toolCallTimeoutMs: 30000,
  })
})

it.each([
  [{ home: '/home/user/.config/browser-harness' }, { BH_HOME: '/home/user/.config/browser-harness' }],
  [{ daemonName: 'dsh' }, { BU_NAME: 'dsh' }],
  [{ requireExistingDaemon: true }, { BH_REQUIRE_EXISTING_DAEMON: '1' }],
  [{ requireExistingDaemon: false }, { BH_REQUIRE_EXISTING_DAEMON: '' }],
  [{ record: true }, { BH_RECORD: '1' }],
  [{ record: false }, { BH_RECORD: '0' }],
  [{ tabMarker: true }, { BH_TAB_MARKER: '1' }],
  [{ tabMarker: false }, { BH_TAB_MARKER: '0' }],
  [{ cdpUrl: 'http://127.0.0.1:9222' }, { BU_CDP_URL: 'http://127.0.0.1:9222' }],
  [{ cdpWs: 'wss://browser.example/devtools/browser/id' }, { BU_CDP_WS: 'wss://browser.example/devtools/browser/id' }],
])('maps %o onto the upstream environment', (config, expected) => {
  Provider.apply(new Context(), Provider.Config(config))
  expect(mounted().env).toEqual(expected)
})

it('omits an unset recording or tab-marker preference instead of overriding the stored one', () => {
  Provider.apply(new Context(), Provider.Config({ home: '/tmp/bh' }))
  // Browser Harness persists a recording preference; writing BH_RECORD from a
  // default would silently replace the user's choice.
  expect(mounted().env).toEqual({ BH_HOME: '/tmp/bh' })
  expect(Provider.buildEnvironment(Provider.Config({}))).toEqual({})
})

it('combines every configured variable in one environment', () => {
  Provider.apply(new Context(), Provider.Config({
    home: '/tmp/bh',
    daemonName: 'dsh',
    requireExistingDaemon: true,
    record: false,
    tabMarker: false,
    cdpWs: 'ws://127.0.0.1:9222/devtools/browser/abc',
    toolCallTimeoutMs: 1200,
  }))
  expect(mounted().env).toEqual({
    BH_HOME: '/tmp/bh',
    BU_NAME: 'dsh',
    BH_REQUIRE_EXISTING_DAEMON: '1',
    BH_RECORD: '0',
    BH_TAB_MARKER: '0',
    BU_CDP_WS: 'ws://127.0.0.1:9222/devtools/browser/abc',
  })
  expect(mounted().toolCallTimeoutMs).toBe(1200)
})

it('rejects two conflicting browser endpoints before mounting anything', () => {
  expect(() => {
    Provider.apply(new Context(), Provider.Config({ cdpUrl: 'http://127.0.0.1:9222', cdpWs: 'ws://127.0.0.1:9222/devtools/browser/a' }))
  }).toThrow('cdpUrl and cdpWs')
  expect(mountSessionMcp).not.toHaveBeenCalled()
})

it('rejects a blank command before mounting anything', () => {
  expect(() => { Provider.apply(new Context(), Provider.Config({ command: '   ' })) }).toThrow('must not be empty')
  expect(mountSessionMcp).not.toHaveBeenCalled()
})

it('rejects a non-positive timeout and a malformed endpoint through the schema', () => {
  expect(() => Provider.Config({ toolCallTimeoutMs: 0 })).toThrow()
  expect(() => Provider.Config({ toolCallTimeoutMs: -1 })).toThrow()
  // A URL the platform cannot parse, and a scheme that does not name a CDP endpoint.
  expect(() => { Provider.validateConfig(Provider.Config({ cdpUrl: 'http://[unterminated' })) }).toThrow('valid URL')
  expect(() => { Provider.Config({ cdpUrl: 'not-a-url' }) }).toThrow()
  expect(mountSessionMcp).not.toHaveBeenCalled()
})

it('declares the only upstream variables this provider may set', () => {
  expect([...Provider.environmentKeys].sort()).toEqual([
    'BH_HOME', 'BH_RECORD', 'BH_REQUIRE_EXISTING_DAEMON', 'BH_TAB_MARKER', 'BU_CDP_URL', 'BU_CDP_WS', 'BU_NAME',
  ])
  expect(Provider.inject).toEqual(['browserUse', 'agents', 'tools', 'systemPrompt'])
  expect(Provider.name).toBe('experimental-browser-use-browser-harness-mcp')
})
