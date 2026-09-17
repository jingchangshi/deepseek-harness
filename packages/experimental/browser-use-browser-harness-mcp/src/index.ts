/** Browser Harness tools over its stdio MCP server, attached to the user's running Chrome. @module */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import { createScreenshotProjection } from './screenshot.ts'
import { registerBrowserHarnessSkill } from './skill.ts'
// Side-effect type imports: `attachments` and `llm` are optional services read
// through `ctx.get()` for screenshot admission, never required injections.
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
// Side-effect type import: `skills` is optional, registered only when present.
import type {} from '@deepseek-ai/dsh-skill'

/** Cordis identity for the Browser Harness MCP browser provider. */
export const name = 'experimental-browser-use-browser-harness-mcp'

/** Services required for scoped MCP startup and prompt readiness checks. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt']

/** Browser Harness installation, daemon, and browser endpoint settings. */
export interface Config {
  /** MCP server executable, spawned directly without a shell. */
  command: string
  /** Arguments passed to that executable verbatim. */
  args: string[]
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
  /** Browser Harness home directory; omission uses its own default. */
  home?: string
  /** Daemon name selecting one local daemon and its browser; omission uses `default`. */
  daemonName?: string
  /** Refuse to start a daemon, requiring an already running one. */
  requireExistingDaemon?: boolean
  /** Persist browser actions to local recordings; omission preserves the stored preference. */
  record?: boolean
  /** Mark the controlled tab in the browser UI; omission preserves the daemon default. */
  tabMarker?: boolean
  /** HTTP(S) debugging URL of the browser to drive; conflicts with `cdpWs`. */
  cdpUrl?: string
  /** WS(S) browser debugging endpoint to drive; conflicts with `cdpUrl`. */
  cdpWs?: string
}

/** Validate provider settings before the provider reserves browser use. */
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  command: Schema.string().default('browser-harness-mcp'),
  args: Schema.array(Schema.string()).default([]),
  toolCallTimeoutMs: Schema.number().min(1),
  home: Schema.string().pattern(/\S/u),
  daemonName: Schema.string().pattern(/^[A-Za-z0-9_-]{1,64}$/u),
  requireExistingDaemon: Schema.boolean(),
  record: Schema.boolean(),
  tabMarker: Schema.boolean(),
  cdpUrl: Schema.string().pattern(/^https?:\/\/[^\s/]+/u),
  cdpWs: Schema.string().pattern(/^wss?:\/\/[^\s/]+/u),
})

/** Upstream environment variables this provider is allowed to set. */
const ENVIRONMENT_KEYS = [
  'BH_HOME',
  'BU_NAME',
  'BH_REQUIRE_EXISTING_DAEMON',
  'BH_RECORD',
  'BH_TAB_MARKER',
  'BU_CDP_URL',
  'BU_CDP_WS',
] as const

/** Upstream boolean vocabulary for the `BH_*` switches. */
const FLAG_VALUE: Record<'record' | 'tabMarker' | 'requireExistingDaemon', (value: boolean) => string> = {
  record: value => value ? '1' : '0',
  tabMarker: value => value ? '1' : '0',
  requireExistingDaemon: value => value ? '1' : '',
}

/**
 * Reject a setting the provider cannot express safely.
 *
 * Both endpoints name one browser, so configuring two would silently ignore
 * one of them. An absent option must stay absent: Browser Harness reads its own
 * stored recording and tab-marker preferences, and an empty string would
 * override them rather than leave them alone.
 *
 * @param config - schema-validated provider settings.
 */
export function validateConfig(config: Config): void {
  if (config.command.trim() === '') {
    throw new Error('browser-harness: the MCP server command must not be empty')
  }
  if (config.cdpUrl !== undefined && config.cdpWs !== undefined) {
    throw new Error('browser-harness: cdpUrl and cdpWs name the same browser; configure exactly one')
  }
  for (const [key, value] of [['cdpUrl', config.cdpUrl], ['cdpWs', config.cdpWs]] as const) {
    if (value === undefined) continue
    let endpoint: URL
    try {
      endpoint = new URL(value)
    } catch (error) {
      throw new Error(`browser-harness: ${key} must be a valid URL`, { cause: error })
    }
    if (/^cdpUrl$/u.test(key) ? endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:'
      : endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
      throw new Error(`browser-harness: ${key} must use ${key === 'cdpUrl' ? 'HTTP(S)' : 'WS(S)'}`)
    }
  }
}

/**
 * Build the upstream environment overrides for the configured settings.
 *
 * Only configured options contribute; every variable this returns is one
 * Browser Harness actually reads, so a default here can never silently replace
 * a user's stored preference.
 *
 * @param config - schema-validated provider settings.
 * @returns environment overrides, empty when nothing is configured.
 */
export function buildEnvironment(config: Config): Record<string, string> {
  const environment: Record<string, string> = {}
  if (config.home !== undefined) environment.BH_HOME = config.home
  if (config.daemonName !== undefined) environment.BU_NAME = config.daemonName
  if (config.requireExistingDaemon !== undefined) {
    environment.BH_REQUIRE_EXISTING_DAEMON = FLAG_VALUE.requireExistingDaemon(config.requireExistingDaemon)
  }
  if (config.record !== undefined) environment.BH_RECORD = FLAG_VALUE.record(config.record)
  if (config.tabMarker !== undefined) environment.BH_TAB_MARKER = FLAG_VALUE.tabMarker(config.tabMarker)
  if (config.cdpUrl !== undefined) environment.BU_CDP_URL = config.cdpUrl
  if (config.cdpWs !== undefined) environment.BU_CDP_WS = config.cdpWs
  return environment
}

/**
 * Expose Browser Harness' upstream catalog to one live Session at a time.
 *
 * One Browser Harness daemon drives one shared browser through mutable
 * current-tab state, so concurrent Sessions would interleave `switch_tab` and
 * act on each other's tab; `exclusive: true` reserves that single lane. The
 * browser stays externally owned: disposing this provider closes only the DSH
 * MCP client, leaving the daemon and the user's Chrome running.
 *
 * @param ctx - provider context supplying browser use, Agents, tools, and prompt assembly.
 * @param config - validated installation, daemon, and endpoint settings.
 */
export function apply(ctx: Context, config: Config): void {
  validateConfig(config)
  const environment = buildEnvironment(config)
  mountSessionMcp(ctx, {
    name: 'browser-harness',
    exclusive: true,
    command: config.command,
    args: config.args,
    // `browser_screenshot` writes a PNG and returns its path; this projects that
    // path into durable model-visible content for image-capable routes.
    projectResult: createScreenshotProjection(ctx),
    ...Object.keys(environment).length === 0 ? {} : { env: environment },
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
  })
  // The skill registry is optional: without it the browser tools still work,
  // so its absence must not fail activation.
  if (ctx.get('skills') !== undefined) {
    ctx.effect(
      () => registerBrowserHarnessSkill(ctx, { command: resolveSkillCommand(config.command), env: environment }),
      'browser-harness.skill',
    )
  }
}

/**
 * Locate the executable that prints the Browser Harness usage skill.
 *
 * `browser-harness-mcp` ships beside `browser-harness`, and the task configures
 * only the MCP executable, so the skill command is derived from it instead of
 * widening the config surface with a second path the user must keep in sync.
 *
 * @param command - configured MCP server executable.
 * @returns the sibling CLI path, or the configured command when it is not the MCP server.
 */
export function resolveSkillCommand(command: string): string {
  // uv installs both as `.exe` on Windows, so the suffix is matched before the
  // extension rather than at the very end of the string.
  return command.replace(/browser-harness-mcp(?=\.exe$|$)/u, 'browser-harness')
}

/** Upstream variables this provider owns, exported for documentation checks. */
export const environmentKeys: readonly string[] = ENVIRONMENT_KEYS
