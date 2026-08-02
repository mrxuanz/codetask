import { Hono } from 'hono'
import type { AppContext } from '../context'
import { requireAuthPrincipal } from '../auth/session'
import { ok } from '../response'
import { readStorageStats } from '../storage/stats'

export function createSystemRoutes(ctx: AppContext): Hono {
  const routes = new Hono()

  routes.get('/storage', async (c) => {
    requireAuthPrincipal()
    return c.json(ok(await readStorageStats(ctx)))
  })

  routes.get('/sandbox-health', async (c) => {
    const { getSandboxHealth } = await import('../sandbox/health')
    return c.json(ok(getSandboxHealth(ctx.dataDir)))
  })

  return routes
}
