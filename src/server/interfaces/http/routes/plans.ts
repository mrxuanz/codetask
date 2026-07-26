/**
 * Thin plan HTTP routes — call application commands/queries only.
 */
import {
  handleRoute,
  requireIdempotencyKey,
  RouteSchemaError,
  type HttpRequest,
  type HttpResult
} from '../route-handler'
import { getPlanQuery, projectPlan } from '../../../core/application/queries/get-plan'
import { confirmPlanCommand } from '../../../core/application/commands/confirm-plan'
import { createPlanCommand } from '../../../core/application/commands/create-plan'
import type { PlanRepo } from '../../../core/application/ports/repositories'
import type { UnitOfWork } from '../../../core/application/ports/unit-of-work'
import type { IdempotencyStore } from '../../../core/application/idempotency'
import type { IdGenerator } from '../../../core/application/ports/id-generator'
import {
  mapPlanToLegacyListItem,
  mapPlanNodesToLegacy
} from '../../../compatibility/legacy-api-mapper'

export type PlanRouteDeps = {
  readonly plans: PlanRepo
  readonly unitOfWork: UnitOfWork
  readonly idempotency: IdempotencyStore
  readonly ids: IdGenerator
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {}
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new RouteSchemaError('body must be an object', 'body')
  }
  return body as Record<string, unknown>
}

export function createPlanRoutes(deps: PlanRouteDeps) {
  return {
    async getPlan(request: HttpRequest): Promise<HttpResult<unknown>> {
      return handleRoute(request, {
        parse: (_auth, req) => {
          const planId = req.params?.planId ?? req.params?.id
          if (!planId) throw new RouteSchemaError('planId is required', 'planId')
          return { planId }
        },
        invoke: (input) => getPlanQuery({ plans: deps.plans }, input),
        mapSuccess: (plan) => ({
          plan: {
            ...mapPlanToLegacyListItem(plan),
            nodes: mapPlanNodesToLegacy(plan)
          }
        })
      })
    },

    async createPlan(request: HttpRequest): Promise<HttpResult<unknown>> {
      return handleRoute(request, {
        parse: (_auth, req) => {
          const body = asRecord(req.body)
          const threadId = String(body.threadId ?? req.params?.threadId ?? '')
          if (!threadId) throw new RouteSchemaError('threadId is required', 'threadId')
          const draftId =
            body.draftId !== undefined ? String(body.draftId) : undefined
          const idempotencyKey = requireIdempotencyKey(req.headers)
          const payloadHash = JSON.stringify({ threadId, draftId })
          return { threadId, draftId, idempotencyKey, payloadHash }
        },
        invoke: (input) =>
          createPlanCommand(
            {
              plans: deps.plans,
              ids: deps.ids,
              unitOfWork: deps.unitOfWork,
              idempotency: deps.idempotency
            },
            input
          ),
        mapSuccess: (value) => ({
          plan: mapPlanToLegacyListItem(projectPlan(value.plan))
        })
      })
    },

    async confirmPlan(request: HttpRequest): Promise<HttpResult<unknown>> {
      return handleRoute(request, {
        parse: (_auth, req) => {
          const planId = req.params?.planId ?? req.params?.id
          if (!planId) throw new RouteSchemaError('planId is required', 'planId')
          const body = asRecord(req.body)
          const expectedRevision = Number(body.expectedRevision ?? body.planRevision ?? 0)
          if (!Number.isFinite(expectedRevision)) {
            throw new RouteSchemaError('expectedRevision is required', 'expectedRevision')
          }
          const idempotencyKey = requireIdempotencyKey(req.headers)
          const payloadHash = JSON.stringify({ planId, expectedRevision })
          return { planId, expectedRevision, idempotencyKey, payloadHash }
        },
        invoke: (input) =>
          confirmPlanCommand(
            {
              plans: deps.plans,
              unitOfWork: deps.unitOfWork,
              idempotency: deps.idempotency
            },
            input
          ),
        mapSuccess: (value) => ({
          plan: mapPlanToLegacyListItem(projectPlan(value.plan))
        })
      })
    }
  }
}

export type PlanRoutes = ReturnType<typeof createPlanRoutes>
