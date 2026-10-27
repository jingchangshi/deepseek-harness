/** Source-safe Agent Teams browser registration. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { TeamAction, type TeamActionInjected } from './TeamAction.tsx'
import { en, NS, zh, type TeamKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent Teams roster and task-board copy. */
    'agent-team': TeamKey
  }
}

/** Required browser services for navigation, slots, and localized copy. */
export const inject = ['sessions', 'uiWorkspace', 'slots', 'locale']

/**
 * Register the Team locale dictionaries and the conversation-header action.
 * The panel reads the Lead Session's `agentTeam` projection from the shared
 * Session store; this registration performs no Team RPC.
 * @param ctx - Client Context carrying the injected navigation, locale, slot, and Session services.
 */
export function registerAgentTeamUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-agent-team: dictionaries')
  // Both the Host session store and the Client session object merge into
  // `Context.sessions`; TypeScript keeps the Host declaration here, while at
  // runtime this browser plugin receives the Client object. Assert the Client
  // contract: `binding` and `retainInfo` are Client-only operations with no
  // Host equivalent, so reading them through the Host type is a typing gap
  // rather than a behaviour change.
  const sessions = ctx.sessions as unknown as ISessions
  const leadSessionId = (sessionId: SessionId): SessionId => {
    const address = sessions.binding(sessionId)?.session.getSnapshot().subagent?.address
    return address?.parentSessionId ?? sessionId
  }

  const actions: TeamActionInjected = {
    openTeammate(sessionId: SessionId, childSessionId: SessionId): void {
      const parentSessionId = leadSessionId(sessionId)
      if ((sessions.retainInfo(sessionId).getSnapshot().retainedBy.mainView ?? 0) === 0) return
      if (childSessionId === parentSessionId) {
        ctx.uiWorkspace.openSession(parentSessionId)
        return
      }
      ctx.uiWorkspace.openSession({
        parentSessionId,
        childSessionId,
        mode: 'continuable',
      })
    },
  }

  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'agent-team',
      order: -20,
      locale: NS,
      inject: () => actions,
    }, TeamAction),
  )
}
