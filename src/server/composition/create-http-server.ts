import type { ApplicationDependencies } from '../core/application/dependencies'
import { createConversationRoutes } from '../interfaces/http/routes/conversation'
import { createDraftRoutes } from '../interfaces/http/routes/drafts'
import { createPlanRoutes } from '../interfaces/http/routes/plans'
import { createJobRoutes } from '../interfaces/http/routes/jobs'

/**
 * Deps required to wire new-core HTTP interface routes.
 * Composition supplies adapters; interfaces never import adapters.
 */
export type HttpServerDeps = Pick<
  ApplicationDependencies,
  'threads' | 'drafts' | 'plans' | 'jobs' | 'unitOfWork' | 'idempotency' | 'ids'
>

export type HttpServerHandle = {
  readonly kind: 'new-core'
  readonly routes: {
    readonly conversation: ReturnType<typeof createConversationRoutes>
    readonly drafts: ReturnType<typeof createDraftRoutes>
    readonly plans: ReturnType<typeof createPlanRoutes>
    readonly jobs: ReturnType<typeof createJobRoutes>
  }
}

/**
 * Wire interface HTTP routes onto the new composition root.
 * In-memory / stub handle is enough for Wave 8 — does not replace Electron bootstrap.
 */
export function createHttpServer(deps: HttpServerDeps): HttpServerHandle {
  return {
    kind: 'new-core',
    routes: {
      conversation: createConversationRoutes({ threads: deps.threads }),
      drafts: createDraftRoutes({
        drafts: deps.drafts,
        unitOfWork: deps.unitOfWork,
        idempotency: deps.idempotency,
        jobs: deps.jobs,
        plans: deps.plans,
        ids: deps.ids
      }),
      plans: createPlanRoutes({
        plans: deps.plans,
        unitOfWork: deps.unitOfWork,
        idempotency: deps.idempotency,
        ids: deps.ids
      }),
      jobs: createJobRoutes({
        jobs: deps.jobs,
        unitOfWork: deps.unitOfWork,
        idempotency: deps.idempotency
      })
    }
  }
}
