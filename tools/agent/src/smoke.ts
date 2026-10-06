/** Credential-free route smoke planning and separately qualified real checks. */

import type { CheckStatus } from './types.ts'
import type { HarnessConfig } from './config.ts'
import { resolveRoleRoute } from './config.ts'

/** One diagnostic model-route smoke result. */
export interface ModelSmokeResult {
  qualification?: 'role' | 'route'
  routeId?: string
  role: string
  provider: string
  model: string
  reasoningEffort: string
  status: CheckStatus
  checks: Readonly<Record<string, CheckStatus>>
  reason?: string
}

/** Observable results returned by a credential-free or deployment smoke driver. */
export interface ModelSmokeObservation {
  completion: string
  toolResult: string
  subagentResult: string
  backgroundResult: string
  structuredOutput: { ok: true }
  cancelled: boolean
  actualRoute: { provider: string; model: string; reasoningEffort: string }
}

/** Injectable model driver used by smoke qualification. */
export interface ModelSmokeDriver {
  run(request: { provider: string; model: string; reasoningEffort: string }): Promise<ModelSmokeObservation>
}

class CredentialFreeSmokeDriver implements ModelSmokeDriver {
  /** Execute every smoke interaction against a deterministic in-memory route. */
  async run(request: { provider: string; model: string; reasoningEffort: string }): Promise<ModelSmokeObservation> {
    await Promise.resolve()
    return {
      completion: 'complete',
      toolResult: 'tool-ok',
      subagentResult: 'subagent-ok',
      backgroundResult: 'background-ok',
      structuredOutput: { ok: true },
      cancelled: true,
      actualRoute: request,
    }
  }
}

const CHECK_NAMES = [
  'provider-resolves',
  'model-resolves',
  'reasoning-routed',
  'completion',
  'tool-use',
  'subagent',
  'background',
  'structured-output',
  'bounded-cancellation',
  'route-diagnostic',
] as const

const REQUIRED_MOCK_CHECKS = CHECK_NAMES.filter(name => name !== 'structured-output')

/**
 * Produce route smoke evidence without credentials or network access.
 * @param config - validated exact-role configuration.
 * @param real - deprecated compatibility flag; real checks use `runRealModelSmokes`.
 * @returns one result per enabled role.
 */
export async function smokeModelRoutes(
  config: HarnessConfig,
  real = false,
  driver: ModelSmokeDriver = new CredentialFreeSmokeDriver(),
): Promise<ModelSmokeResult[]> {
  const results: ModelSmokeResult[] = []
  for (const [role, roleConfig] of Object.entries(config.roles)) {
    if (!roleConfig.enabled) continue
      const route = resolveRoleRoute(config, role)
      if (real) {
        const status: CheckStatus = 'NOT_RUN'
        results.push({
          qualification: 'role',
          routeId: route.routeId,
          role,
          provider: route.provider,
          model: route.model,
          reasoningEffort: route.reasoningEffort,
          status,
          checks: Object.fromEntries(CHECK_NAMES.map(name => [name, status])),
          reason: 'real provider credentials and deployment model IDs are not configured',
        })
        continue
      }
      const observation = await driver.run({ provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort })
      const checks: Record<string, CheckStatus> = {
        'provider-resolves': observation.actualRoute.provider === route.provider ? 'PASS' : 'FAIL',
        'model-resolves': observation.actualRoute.model === route.model ? 'PASS' : 'FAIL',
        'reasoning-routed': observation.actualRoute.reasoningEffort === route.reasoningEffort ? 'PASS' : 'FAIL',
        completion: observation.completion.length > 0 ? 'PASS' : 'FAIL',
        'tool-use': observation.toolResult.length > 0 ? 'PASS' : 'FAIL',
        subagent: observation.subagentResult.length > 0 ? 'PASS' : 'FAIL',
        background: observation.backgroundResult.length > 0 ? 'PASS' : 'FAIL',
        'structured-output': 'NOT_RUN',
        'bounded-cancellation': observation.cancelled ? 'PASS' : 'FAIL',
        'route-diagnostic': observation.actualRoute.provider.length > 0 ? 'PASS' : 'FAIL',
      }
      const status: CheckStatus = REQUIRED_MOCK_CHECKS.every(name => checks[name] === 'PASS') ? 'PASS' : 'FAIL'
      results.push({
        qualification: 'role',
        routeId: route.routeId,
        role,
        provider: route.provider,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        status,
        checks,
      })
  }
  return results
}
