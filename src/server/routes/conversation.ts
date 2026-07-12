import { Hono } from 'hono'
import type { AppContext } from '../context'
import { streamSSE } from 'hono/streaming'
import { requireUsername } from '../auth/session'
import { resolveThreadAttachments } from '../conversation/attachments'
import {
  listCores,
  listThreadMessages,
  loadThreadState,
  streamSendMessage,
  switchThreadCore
} from '../conversation/service'
import { AppError } from '../error'
import { toTurnErrorDto } from '../agent-runtime/errors'
import { ok } from '../response'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createAgentRoutes(_ctx: AppContext): Hono {
  const routes = new Hono()

  routes.get('/cores', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const cores = await listCores()
    return c.json(ok({ cores }))
  })

  return routes
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

  routes.post('/:threadId/messages', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{
      message?: string
      generateDraft?: boolean
      createTaskMode?: boolean
      attachmentIds?: string[]
      selectedDraftSection?: string
      selectedPlanNodeRef?: string
    }>()
    if (!body.message?.trim()) {
      throw AppError.badRequest('Message cannot be empty', 'message.empty')
    }

    const threadId = c.req.param('threadId')
    const attachments = resolveThreadAttachments(threadId, body.attachmentIds ?? [])
    const accept = c.req.header('Accept') ?? ''
    const wantsSse = accept.includes('text/event-stream') || c.req.query('stream') === '1'

    if (!wantsSse) {
      throw AppError.badRequest(
        'Please use SSE streaming (Accept: text/event-stream)',
        'conversation.sse_required'
      )
    }

    return streamSSE(c, async (stream) => {
      // Keep the renderer SSE idle watchdog alive during long tool/LLM gaps
      // (e.g. OpenCode read/explore). Must be < SSE_IDLE_TIMEOUT_MS (45s).
      const HEARTBEAT_MS = 15_000
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null
      const stopHeartbeat = (): void => {
        if (!heartbeatTimer) return
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
      try {
        heartbeatTimer = setInterval(() => {
          void stream
            .writeSSE({
              event: 'heartbeat',
              data: JSON.stringify({ ts: Date.now() })
            })
            .catch(() => stopHeartbeat())
        }, HEARTBEAT_MS)
        heartbeatTimer.unref?.()

        for await (const chunk of streamSendMessage(username, threadId, body.message!, {
          generateDraft: body.generateDraft === true,
          createTaskMode: body.createTaskMode === true,
          attachments,
          selectedDraftSection: body.selectedDraftSection,
          selectedPlanNodeRef: body.selectedPlanNodeRef
        })) {
          await stream.writeSSE({
            event: chunk.event,
            data: JSON.stringify(chunk.data)
          })
        }
      } catch (error) {
        const turnError = toTurnErrorDto(error)
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: turnError, message: turnError.message })
        })
      } finally {
        stopHeartbeat()
      }
    })
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
