import { Hono } from 'hono'
import type { AppContext } from '../context'
import { requireUsername } from '../auth/session'
import {
  cancelConversationTurn,
  enqueueConversationTurn,
  getTurn
} from '../conversation/turn-queue'
import { AppError } from '../error'
import { ok } from '../response'

export function createTurnRoutes(_ctx: AppContext): Hono {
  const routes = new Hono()

  routes.post('/:threadId/turns', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{
      message?: string
      generateDraft?: boolean
      createTaskMode?: boolean
      attachmentIds?: string[]
      selectedDraftSection?: string
      selectedPlanNodeRef?: string
      idempotencyKey?: string
      provider?: string
      kind?: 'chat' | 'create_task' | 'draft'
    }>()

    const accepted = await enqueueConversationTurn({
      username,
      threadId: c.req.param('threadId'),
      message: body.message ?? '',
      generateDraft: body.generateDraft === true,
      createTaskMode: body.createTaskMode === true,
      attachmentIds: body.attachmentIds,
      selectedDraftSection: body.selectedDraftSection,
      selectedPlanNodeRef: body.selectedPlanNodeRef,
      idempotencyKey: body.idempotencyKey ?? c.req.header('Idempotency-Key') ?? null,
      provider: body.provider ?? null,
      kind: body.kind
    })

    return c.json(ok(accepted), 202)
  })

  routes.get('/:threadId/turns/:turnId', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const turn = await getTurn(username, c.req.param('turnId'))
    if (!turn || turn.threadId !== c.req.param('threadId')) {
      throw AppError.notFound('Turn not found', 'turn.not_found')
    }
    return c.json(ok({ turn }))
  })

  routes.post('/:threadId/turns/:turnId/cancel', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const turn = await getTurn(username, c.req.param('turnId'))
    if (!turn || turn.threadId !== c.req.param('threadId')) {
      throw AppError.notFound('Turn not found', 'turn.not_found')
    }
    const cancelled = await cancelConversationTurn(username, c.req.param('turnId'))
    return c.json(ok({ turn: cancelled }))
  })

  return routes
}
