/**
 * Thin conversation HTTP routes — auth + schema + application query/command + map.
 * Parallel to production `src/server/routes/**`; does not replace them yet.
 */
import {
  handleRoute,
  type HttpRequest,
  type HttpResult
} from '../route-handler'
import { getThreadQuery } from '../../../core/application/queries/get-thread'
import type { ThreadRepo } from '../../../core/application/ports/repositories'
import { mapThreadToLegacyAgent } from '../../../compatibility/legacy-api-mapper'

export type ConversationRouteDeps = {
  readonly threads: ThreadRepo
}

export function createConversationRoutes(deps: ConversationRouteDeps) {
  return {
    async getThreadAgent(request: HttpRequest): Promise<HttpResult<unknown>> {
      return handleRoute(request, {
        parse: (_auth, req) => {
          const threadId = req.params?.threadId ?? req.params?.id
          if (!threadId) {
            throw new Error('threadId is required')
          }
          return { threadId }
        },
        invoke: (input) => getThreadQuery({ threads: deps.threads }, input),
        mapSuccess: (thread) => mapThreadToLegacyAgent(thread)
      })
    }
  }
}

export type ConversationRoutes = ReturnType<typeof createConversationRoutes>
