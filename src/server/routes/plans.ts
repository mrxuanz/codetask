import { Hono } from 'hono'
import type { AppContext } from '../context'
import { requireUsername } from '../auth/session'
import { AppError } from '../error'
import {
  tryCorePlanConfirm,
  tryCorePlanCreate,
  tryCorePlanGet
} from '../composition/core-plan-bridge'

/**
 * Production plan routes — core-shaped via tryCore* bridges.
 * Returns 404 when the plan is not in core (no ThreadJobDto fallback).
 * Create always goes to core when `coreApplication` is present.
 */
export function createPlanRoutes(ctx: AppContext): Hono {
  const routes = new Hono()
  const coreApp = ctx.coreApplication

  routes.post('/', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const core = await tryCorePlanCreate(c, coreApp)
    if (core) return core
    throw AppError.notFound('Core application unavailable', 'plan.core_unavailable')
  })

  routes.get('/:planId', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const planId = c.req.param('planId')
    const core = await tryCorePlanGet(c, planId, coreApp)
    if (core) return core
    throw AppError.notFound('Plan not found', 'plan.not_found')
  })

  routes.post('/:planId/confirm', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const planId = c.req.param('planId')
    const core = await tryCorePlanConfirm(c, planId, coreApp)
    if (core) return core
    throw AppError.notFound('Plan not found', 'plan.not_found')
  })

  return routes
}
