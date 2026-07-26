import { Hono } from 'hono'
import type { AppContext } from '../context'
import { requireUsername } from '../auth/session'
import { deleteUserDraft, listUserDrafts } from '../legacy-shim'
import { AppError } from '../error'
import { ok } from '../response'
import { createLegacyCutoverGuard } from '../http/legacy-cutover-guard'
import {
  tryCoreDraftConfirm,
  tryCoreDraftConfirmFinal,
  tryCoreDraftGet,
  tryCoreDraftPatch,
  tryCoreDraftSectionConfirm,
  tryCoreDraftUnlock
} from '../composition/core-draft-bridge'

/**
 * Production drafts routes:
 * - GET `/` — legacy list (thread/message keyed summaries)
 * - GET `/:draftId` — core-shaped get-by-id (same payload as `/api/core/drafts/:id`)
 * - POST `/:draftId/confirm` — core-shaped confirm (404 if missing; no fat legacy fallback)
 * - PATCH `/:draftId/patch` — core-shaped patch
 * - POST `/:draftId/sections/:section/confirm` — core-shaped section confirm
 * - POST `/:draftId/unlock` — core-shaped unlock
 * - POST `/:draftId/confirm-final` — core-shaped confirm-final (404 if missing)
 * - DELETE `/:threadId/:messageId` — legacy delete
 */
export function createDraftListRoutes(ctx: AppContext): Hono {
  const routes = new Hono()
  const legacyWriteGuard = createLegacyCutoverGuard()
  const coreApp = ctx.coreApplication

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

  // Core-shaped get-by-id for new clients (thin alias of `/api/core/drafts/:id`).
  // Must not shadow list (`/`) or legacy DELETE `/:threadId/:messageId`.
  routes.get('/:draftId', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const draftId = c.req.param('draftId')
    const core = await tryCoreDraftGet(c, draftId, coreApp)
    if (core) return core
    throw AppError.notFound('Draft not found', 'draft.not_found')
  })

  routes.post('/:draftId/confirm', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const draftId = c.req.param('draftId')
    const core = await tryCoreDraftConfirm(c, draftId, coreApp)
    if (core) return core
    throw AppError.notFound('Draft not found', 'draft.not_found')
  })

  routes.patch('/:draftId/patch', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const draftId = c.req.param('draftId')
    const core = await tryCoreDraftPatch(c, draftId, coreApp)
    if (core) return core
    throw AppError.notFound('Draft not found', 'draft.not_found')
  })

  routes.post('/:draftId/sections/:section/confirm', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const draftId = c.req.param('draftId')
    const section = c.req.param('section')
    const core = await tryCoreDraftSectionConfirm(c, draftId, section, coreApp)
    if (core) return core
    throw AppError.notFound('Draft not found', 'draft.not_found')
  })

  routes.post('/:draftId/unlock', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const draftId = c.req.param('draftId')
    const core = await tryCoreDraftUnlock(c, draftId, coreApp)
    if (core) return core
    throw AppError.notFound('Draft not found', 'draft.not_found')
  })

  routes.post('/:draftId/confirm-final', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const draftId = c.req.param('draftId')
    const core = await tryCoreDraftConfirmFinal(c, draftId, coreApp)
    if (core) return core
    throw AppError.notFound('Draft not found', 'draft.not_found')
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
