/**
 * Bridge: production plan get/create/confirm → new-core `createPlanRoutes`.
 *
 * Wired by production `GET /api/plans/:planId`, `POST /api/plans`, and
 * `POST /api/plans/:planId/confirm` (404 when missing in core for get/confirm —
 * no ThreadJobDto fallback). Legacy `GET /:threadId/plans` remains ThreadJobDto[]
 * and must not use this bridge. `/api/core/plans/:planId` is the parallel core mount.
 */
import type { Context } from 'hono'
import type { ApplicationHandle } from './types'
import { createPlanRoutes } from '../interfaces/http/routes/plans'
import { toHttpRequest, sendHttpResult } from '../interfaces/http/hono-mount'

function corePlanRoutes(core: ApplicationHandle) {
  return createPlanRoutes({
    plans: core.plans,
    unitOfWork: core.unitOfWork,
    idempotency: core.idempotency,
    ids: core.ids
  })
}

/**
 * Fetch one plan through new-core.
 * @returns Hono response, or `null` when plan not in core (caller may fall back).
 */
export async function tryCorePlanGet(
  c: Context,
  planId: string,
  core: ApplicationHandle | null | undefined
): Promise<Response | null> {
  if (!core) return null

  const existing = await core.plans.get(planId)
  if (!existing) return null

  const routes = corePlanRoutes(core)
  const request = await toHttpRequest(c, { planId })
  const result = await routes.getPlan(request)
  return sendHttpResult(c, result) as unknown as Response
}

/**
 * Confirm a plan through new-core (idempotency + expectedRevision plumbing).
 * @returns Hono response, or `null` when plan not in core (caller may fall back).
 */
export async function tryCorePlanConfirm(
  c: Context,
  planId: string,
  core: ApplicationHandle | null | undefined
): Promise<Response | null> {
  if (!core) return null

  const existing = await core.plans.get(planId)
  if (!existing) return null

  const routes = corePlanRoutes(core)
  const headers: Record<string, string | undefined> = {}
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  // Legacy clients often omit Idempotency-Key / expectedRevision — use current core revision.
  if (!headers['idempotency-key']) {
    headers['idempotency-key'] =
      `core-bridge:confirm-plan:${planId}:${existing.revision}`
  }

  let body: unknown = {}
  try {
    const contentType = headers['content-type'] ?? ''
    if (contentType.includes('application/json')) {
      body = await c.req.json()
    }
  } catch {
    body = {}
  }
  if (body === undefined || body === null || typeof body !== 'object') {
    body = {}
  }
  const record = body as Record<string, unknown>
  if (
    record.expectedRevision === undefined &&
    record.planRevision === undefined &&
    record.revision === undefined
  ) {
    body = { ...record, expectedRevision: Number(existing.revision) }
  }

  const request = {
    ...(await toHttpRequest(c, { planId })),
    headers,
    body
  }

  const result = await routes.confirmPlan(request)
  return sendHttpResult(c, result) as unknown as Response
}

/**
 * Create a plan through new-core. Always routes to core when `core` is present
 * (reads threadId / draftId from body). Returns `null` only when core is absent.
 */
export async function tryCorePlanCreate(
  c: Context,
  core: ApplicationHandle | null | undefined
): Promise<Response | null> {
  if (!core) return null

  const routes = corePlanRoutes(core)
  const headers: Record<string, string | undefined> = {}
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  let body: unknown = {}
  try {
    const contentType = headers['content-type'] ?? ''
    if (contentType.includes('application/json')) {
      body = await c.req.json()
    }
  } catch {
    body = {}
  }
  if (body === undefined || body === null || typeof body !== 'object') {
    body = {}
  }
  const record = body as Record<string, unknown>
  const threadId = String(record.threadId ?? '')
  const draftId =
    record.draftId !== undefined ? String(record.draftId) : undefined

  if (!headers['idempotency-key']) {
    headers['idempotency-key'] =
      `core-bridge:create-plan:${threadId}:${draftId ?? ''}:${Date.now()}`
  }

  const request = {
    ...(await toHttpRequest(c, {})),
    headers,
    body: { ...record, threadId, ...(draftId !== undefined ? { draftId } : {}) }
  }

  const result = await routes.createPlan(request)
  return sendHttpResult(c, result) as unknown as Response
}
