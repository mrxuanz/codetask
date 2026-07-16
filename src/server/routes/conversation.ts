import { Hono } from 'hono'
import type { AppContext } from '../context'
import { requireUsername } from '../auth/session'
import { listCores, listThreadMessages, loadThreadState, switchThreadCore } from '../conversation/service'
import { AppError } from '../error'
import { ok } from '../response'

export function createAgentRoutes(_ctx: AppContext): Hono {
  const routes = new Hono()

  routes.get('/cores', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const cores = await listCores()
    return c.json(ok({ cores }))
  })

  return routes
}

export function createThreadAgentRoutes(_ctx: AppContext): Hono {
  const routes = new Hono()

  routes.get('/:threadId/agent', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const state = await loadThreadState(username, c.req.param('threadId'))
    return c.json(ok(state))
  })

  routes.get('/:threadId/messages', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50))
    const messages = await listThreadMessages(username, c.req.param('threadId'), limit)
    return c.json(ok({ messages }))
  })

  // P7: old per-request conversation SSE removed. Use POST /turns + /api/realtime.
  routes.post('/:threadId/messages', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const threadId = c.req.param('threadId')
    throw AppError.gone(
      `POST /api/threads/${threadId}/messages is gone; use POST /api/threads/${threadId}/turns and subscribe via /api/realtime`,
      'conversation.messages_post_gone'
    )
  })

  routes.patch('/:threadId/core', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{ coreCode?: string }>()
    if (!body.coreCode?.trim()) {
      throw AppError.badRequest('coreCode is required', 'thread.core_required')
    }
    const thread = await switchThreadCore(username, c.req.param('threadId'), body.coreCode)
    return c.json(ok(thread))
  })

  return routes
}
