import { Hono } from 'hono'
import type { AppContext } from '../context'
import { ok } from '../response'

export function createSystemRoutes(ctx: AppContext): Hono {
  const routes = new Hono()

  routes.get('/sandbox-health', async (c) => {
    const { getSandboxHealth } = await import('../sandbox/health')
    return c.json(ok(getSandboxHealth(ctx.dataDir)))
  })

  return routes
}
