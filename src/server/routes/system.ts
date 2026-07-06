import { Hono } from 'hono'
import type { AppContext } from '../context'
import { getSandboxHealth } from '../sandbox/health'
import { ok } from '../response'

export function createSystemRoutes(ctx: AppContext): Hono {
  const routes = new Hono()

  routes.get('/sandbox-health', (c) => {
    return c.json(ok(getSandboxHealth(ctx.dataDir)))
  })

  return routes
}
