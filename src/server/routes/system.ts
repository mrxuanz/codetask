import { Hono } from 'hono'
import type { AppContext } from '../context'
import { requireAuthPrincipal } from '../auth/session'
import { ok } from '../response'
import { readStorageStats } from '../storage/stats'

function requestId(c: { get: (key: never) => unknown }): string {
  return (c.get('requestId' as never) as string | undefined) ?? 'unknown'
}

export function createSystemRoutes(ctx: AppContext): Hono {
  const routes = new Hono()

  routes.get('/storage', async (c) => {
    requireAuthPrincipal()
    return c.json(ok(await readStorageStats(ctx), requestId(c)))
  })

  routes.get('/sandbox-health', async (c) => {
    const { getSandboxHealth } = await import('../sandbox/health')
    return c.json(ok(getSandboxHealth(ctx.dataDir), requestId(c)))
  })

  return routes
}
