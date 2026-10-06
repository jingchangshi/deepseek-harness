/** Named-profile composition for user-configured engineering agents. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { loadHarnessConfig, resolveRoleRoute } from '../src/config.ts'
import type { HarnessConfig } from '../src/config.ts'
import * as Engineering from './index.ts'

export const name = 'engineering-bootstrap'
export const inject = ['llm']

/** Deployment configuration location and per-role cooperative deadline. */
export interface Config {
  deploymentRoot: string
  roleTimeoutMs: number
}

export const Config: z<Config> = z.object({
  deploymentRoot: z.string().required(),
  roleTimeoutMs: z.number().min(1).step(1).default(1_200_000),
})

/**
 * Convert enabled deployment routes into the official adapter's configuration.
 * @param config - resolved deployment YAML configuration.
 * @returns provider declarations containing credential references, never key values.
 */
export function providerOptions(config: HarnessConfig): Record<string, PiAi.PiAiProviderProfile> {
  const providers: Record<string, PiAi.PiAiProviderProfile> = {}
  const register = (displayName: string, route: { provider: string; model: string; reasoningEfforts: Record<string, string | null> }): void => {
    const endpoint = config.providers[route.provider]!
    if ([endpoint.api, endpoint.apiKeyEnv, endpoint.baseURL, route.provider, route.model, ...Object.values(route.reasoningEfforts)].some(value => value !== null && value.startsWith('${'))) {
      throw new Error(`Engineering deployment route ${route.provider} has unresolved environment variables`)
    }
    const provider = providers[route.provider] ??= { ...endpoint, models: [] }
    if (provider.models!.some(model => model.id === route.model)) return
    const efforts = Object.fromEntries(Object.entries(route.reasoningEfforts).filter(([, value]) => value !== null))
    provider.models!.push({ id: route.model, name: displayName,
      reasoningEfforts: Object.keys(efforts).length === 0 ? false : { off: null, ...efforts } })
  }
  for (const role of Object.values(config.roles)) {
    if (!role.enabled) continue
    const route = config.routes[role.route]!
    register(route.displayName, route)
    for (const fallback of role.fallbackRoutes) register(config.routes[fallback]!.displayName, config.routes[fallback]!)
  }
  return providers
}

/**
 * Mount provider adapters, the Coordinator default, and workflow tools from one YAML source.
 * @param ctx - profile-owned plugin context.
 * @param config - deployment root and role deadline.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const deployment = await loadHarnessConfig(config.deploymentRoot)
  const coordinator = resolveRoleRoute(deployment, 'coordinator')
  await ctx.plugin(PiAi, { providers: providerOptions(deployment) })
  await ctx.plugin(AgentDefaultModel, {
    provider: coordinator.provider, model: coordinator.model, reasoningEffort: coordinator.reasoningEffort,
  })
  await ctx.plugin(Engineering.createEngineeringPlugin(deployment), config)
}
