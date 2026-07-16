import { Hono } from 'hono'
import type { AppContext } from '../context'
import { requireUsername } from '../auth/session'
import { deleteUserDraft, listUserDrafts } from '../legacy-control-plane/draft-plan'
import { ok } from '../response'
import { createLegacyCutoverGuard } from '../http/legacy-cutover-guard'

export function createDraftListRoutes(_ctx: AppContext): Hono {
  const routes = new Hono()
  const legacyWriteGuard = createLegacyCutoverGuard()

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

  routes.delete('/:threadId/:messageId', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const result = await deleteUserDraft(
      username,
      c.req.param('threadId'),
      c.req.param('messageId')
    )
    return c.json(ok(result))
  })

  return routes
}
