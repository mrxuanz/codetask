import { Hono } from 'hono'
import type {
  CreateConversationBody,
  CreateConversationTurnBody,
  RenameConversationBody,
  SwitchProviderBody
} from '@codetask/contracts'
import type { ConversationApplication } from '../application/conversation-application.ts'
import type { Actor } from '../shared.ts'
import {
  ConversationConflictError,
  ConversationForbiddenError,
  ConversationNotFoundError,
  ConversationValidationError
} from '../shared.ts'

export type ConversationHttpEnv = {
  Variables: {
    actor: Actor
    requestId: string
  }
}

function mapError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ConversationNotFoundError) {
    return { status: 404, code: error.code, message: error.message }
  }
  if (error instanceof ConversationForbiddenError) {
    return { status: 403, code: error.code, message: error.message }
  }
  if (error instanceof ConversationConflictError) {
    return { status: 409, code: error.code, message: error.message }
  }
  if (error instanceof ConversationValidationError) {
    return { status: 400, code: error.code, message: error.message }
  }
  return {
    status: 500,
    code: 'conversation.internal',
    message: error instanceof Error ? error.message : String(error)
  }
}

function fail(
  c: { json: (body: unknown, status: number) => Response; get: (k: 'requestId') => string },
  error: unknown
): Response {
  const mapped = mapError(error)
  return c.json(
    {
      success: false,
      error: { code: mapped.code, message: mapped.message },
      requestId: c.get('requestId') ?? 'unknown'
    },
    mapped.status as 400
  )
}

function ok(
  c: { json: (body: unknown, status?: number) => Response; get: (k: 'requestId') => string },
  data: unknown,
  status = 200
): Response {
  return c.json({ success: true, data, requestId: c.get('requestId') ?? 'unknown' }, status as 200)
}

export function createConversationRoutes(app: ConversationApplication): Hono<ConversationHttpEnv> {
  const routes = new Hono<ConversationHttpEnv>()

  routes.get('/conversations/providers', async (c) => {
    try {
      const providers = await app.listProviders()
      return ok(c, providers)
    } catch (error) {
      return fail(c, error)
    }
  })

  routes.get('/conversations', (c) => {
    try {
      return ok(c, app.list(c.get('actor')))
    } catch (error) {
      return fail(c, error)
    }
  })

  routes.get('/projects/:projectId/conversations', (c) => {
    try {
      return ok(c, app.listForProject(c.get('actor'), c.req.param('projectId')))
    } catch (error) {
      return fail(c, error)
    }
  })

  routes.post('/projects/:projectId/conversations', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as CreateConversationBody
      const created = app.create(c.get('actor'), c.req.param('projectId'), body)
      return ok(c, created, 201)
    } catch (error) {
      return fail(c, error)
    }
  })

  routes.get('/conversations/:conversationId', (c) => {
    try {
      return ok(c, app.get(c.get('actor'), c.req.param('conversationId')))
    } catch (error) {
      return fail(c, error)
    }
  })

  routes.patch('/conversations/:conversationId', async (c) => {
    try {
      const body = (await c.req.json()) as RenameConversationBody
      return ok(c, app.rename(c.get('actor'), c.req.param('conversationId'), body.title))
    } catch (error) {
      return fail(c, error)
    }
  })

  routes.patch('/conversations/:conversationId/provider', async (c) => {
    try {
      const body = (await c.req.json()) as SwitchProviderBody
      const updated = await app.switchProvider(
        c.get('actor'),
        c.req.param('conversationId'),
        body.providerCode
      )
      return ok(c, updated)
    } catch (error) {
      return fail(c, error)
    }
  })

  routes.delete('/conversations/:conversationId', async (c) => {
    try {
      await app.delete(c.get('actor'), c.req.param('conversationId'))
      return ok(c, { deleted: true })
    } catch (error) {
      return fail(c, error)
    }
  })

  routes.get('/conversations/:conversationId/messages', (c) => {
    try {
      return ok(c, app.listMessages(c.get('actor'), c.req.param('conversationId')))
    } catch (error) {
      return fail(c, error)
    }
  })

  routes.post('/conversations/:conversationId/turns', async (c) => {
    try {
      const body = (await c.req.json()) as CreateConversationTurnBody
      // Reject Design leakage fields if clients still send them
      const raw = body as CreateConversationTurnBody & {
        generateDraft?: unknown
        createTaskMode?: unknown
        kind?: unknown
      }
      if (
        raw.generateDraft != null ||
        raw.createTaskMode != null ||
        (raw.kind != null && raw.kind !== 'chat')
      ) {
        throw new ConversationValidationError(
          'Draft/Plan fields are not accepted on conversation turns'
        )
      }
      const accepted = app.enqueueTurn(c.get('actor'), c.req.param('conversationId'), {
        message: body.message ?? '',
        attachmentIds: body.attachmentIds ?? [],
        idempotencyKey: body.idempotencyKey || c.req.header('Idempotency-Key') || '',
        providerCode: body.providerCode
      })
      return ok(c, accepted, 202)
    } catch (error) {
      return fail(c, error)
    }
  })

  routes.get('/conversations/:conversationId/turns/:turnId', (c) => {
    try {
      return ok(
        c,
        app.getTurn(c.get('actor'), c.req.param('conversationId'), c.req.param('turnId'))
      )
    } catch (error) {
      return fail(c, error)
    }
  })

  routes.post('/conversations/:conversationId/turns/:turnId/cancel', (c) => {
    try {
      return ok(
        c,
        app.cancelTurn(c.get('actor'), c.req.param('conversationId'), c.req.param('turnId'))
      )
    } catch (error) {
      return fail(c, error)
    }
  })

  return routes
}
