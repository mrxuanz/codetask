import { Hono } from 'hono'
import type { AppContext } from '../context'
import { requireUsername } from '../auth/session'
import { listUserDrafts } from '../legacy-control-plane/draft-plan'
import { ok } from '../response'

export function createDraftListRoutes(_ctx: AppContext): Hono {
  const routes = new Hono()

  routes.get('/', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const q = c.req.query('q')?.trim()
    const completion = c.req.query('completion')?.trim() as
      | 'all'
      | 'incomplete'
      | 'complete'
      | undefined
    const drafts = await listUserDrafts(username, {
      q: q || undefined,
      completion: completion === 'incomplete' || completion === 'complete' ? completion : 'all'
    })
    return c.json(ok({ drafts }))
  })

  return routes
}
