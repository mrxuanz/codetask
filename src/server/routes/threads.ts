import { Hono } from 'hono'
import type { AppContext } from '../context'
import { requireUsername } from '../auth/session'
import { AppError } from '../error'
import { ok } from '../response'
import {
  createThread,
  deleteThread,
  discardEmptyCreateTaskThreadIfUnused,
  getThread,
  listThreadsForProject,
  listThreadsForUser,
  renameThread,
  updateThreadContext
} from '../threads/service'
import { THREAD_KIND_CHAT, THREAD_KIND_CREATE_TASK } from '../threads/types'
import { reconcileThreadsForUser } from '../conversation/service'

export function createThreadRoutes(_ctx: AppContext): Hono {
  const routes = new Hono()

  routes.get('/', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const rows = await listThreadsForUser(username)
    const reconciled = await reconcileThreadsForUser(username, rows)
    return c.json(ok(reconciled))
  })

  routes.get('/:threadId', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const threadId = c.req.param('threadId')
    const row = await getThread(username, threadId)
    if (!row) {
      throw AppError.notFound('Thread not found', 'thread.not_found')
    }
    const [reconciled] = await reconcileThreadsForUser(username, [row])
    return c.json(ok(reconciled))
  })

  routes.patch('/:threadId', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{ title?: string }>()
    if (!body.title?.trim()) {
      throw AppError.badRequest('Thread title cannot be empty', 'thread.title_empty')
    }
    const row = await renameThread(username, c.req.param('threadId'), body.title)
    return c.json(ok(row))
  })

  routes.patch('/:threadId/context', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{ activeDraftId?: string | null; activePlanId?: string | null }>()
    const row = await updateThreadContext(username, c.req.param('threadId'), {
      activeDraftId: body.activeDraftId,
      activePlanId: body.activePlanId
    })
    return c.json(ok(row))
  })

  routes.post('/:threadId/wizard/rollback', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const threadId = c.req.param('threadId')
    const body = await c.req.json<{ to?: string; reason?: string }>()
    if (!body.to?.trim() || !body.reason?.trim()) {
      throw AppError.badRequest(
        'Rollback target and reason are required',
        'thread.wizard.rollback_fields_required'
      )
    }
    const row = await getThread(username, threadId)
    if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')
    const { requestPhaseRollback } = await import('../wizard/phase')
    const { isWizardPhase, WIZARD_PHASE_COLLECT, WIZARD_PHASE_DRAFT_REVIEW } =
      await import('../wizard/types')
    const to = body.to.trim()
    if (!isWizardPhase(to) || (to !== WIZARD_PHASE_COLLECT && to !== WIZARD_PHASE_DRAFT_REVIEW)) {
      throw AppError.badRequest(
        'Invalid rollback target phase',
        'thread.wizard.invalid_rollback_target'
      )
    }
    const updated = await requestPhaseRollback(username, threadId, {
      to,
      reason: body.reason.trim(),
      coreCode: row.coreCode
    })
    return c.json(ok(updated))
  })

  routes.delete('/:threadId', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    await deleteThread(username, c.req.param('threadId'))
    return c.json(ok({ deleted: true }))
  })

  routes.post('/:threadId/discard-if-empty', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const discarded = await discardEmptyCreateTaskThreadIfUnused(username, c.req.param('threadId'))
    return c.json(ok({ discarded }))
  })

  return routes
}

export function createProjectThreadRoutes(_ctx: AppContext): Hono {
  const routes = new Hono()

  routes.get('/:projectId/threads', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const rows = await listThreadsForProject(username, c.req.param('projectId'))
    const reconciled = await reconcileThreadsForUser(username, rows)
    return c.json(ok(reconciled))
  })

  routes.post('/:projectId/threads', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{ title?: string; coreCode?: string; threadKind?: string }>()
    const kind =
      body.threadKind === THREAD_KIND_CREATE_TASK ? THREAD_KIND_CREATE_TASK : THREAD_KIND_CHAT
    const row = await createThread(
      username,
      c.req.param('projectId'),
      body.title,
      body.coreCode,
      kind
    )
    return c.json(ok(row))
  })

  return routes
}
