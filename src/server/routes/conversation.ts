import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import type { AppContext } from '../context'
import { getRequestAuthPrincipal } from '../auth/session'
import { AppError, toErrorHttpResult } from '../error'
import {
  browse,
  createChildDirectory,
  inferTitleFromPath,
  normalizeWorkspacePath,
  parentBrowsePath,
  workspaceCanonicalKey
} from '../fs'
import { ok } from '../response'

function userIdFrom(context: Parameters<typeof getRequestAuthPrincipal>[0]): string {
  const principal = getRequestAuthPrincipal(context)
  if (!principal) throw AppError.unauthorized()
  return principal.userId
}

function ndjson(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

export function createConversationRoutes(ctx: AppContext): Hono {
  const routes = new Hono()
  const service = ctx.conversation.service

  routes.get('/conversation/settings', (c) => {
    return c.json(ok(service.getSettings(userIdFrom(c))))
  })

  routes.put('/conversation/settings', async (c) => {
    const body = await c.req.json<{ provider?: string | null }>()
    return c.json(ok(service.updateSettings(userIdFrom(c), { provider: body.provider })))
  })

  routes.get('/conversation/providers', async (c) => {
    userIdFrom(c)
    return c.json(ok(await ctx.conversation.providerStatuses()))
  })

  routes.get('/conversation/provider-status', async (c) => {
    userIdFrom(c)
    return c.json(ok(await ctx.conversation.providerStatuses()))
  })

  routes.get('/conversation/workspaces', (c) => {
    return c.json(
      ok(
        service.listWorkspaces(userIdFrom(c)).map((workspace) => ({
          ...workspace,
          workspaceAccess: ctx.conversation.workspaceAccess(workspace.id)
        }))
      )
    )
  })

  routes.post('/conversation/workspaces', async (c) => {
    const body = await c.req.json<{ path?: string; title?: string }>()
    const rootPath = normalizeWorkspacePath(body.path ?? '', false)
    const workspace = service.createWorkspace(userIdFrom(c), {
      rootPath,
      canonicalKey: workspaceCanonicalKey(rootPath),
      title: body.title?.trim() || inferTitleFromPath(rootPath)
    })
    return c.json(ok(workspace), 201)
  })

  routes.delete('/conversation/workspaces/:workspaceId', (c) => {
    const userId = userIdFrom(c)
    const workspaceId = c.req.param('workspaceId')
    ctx.job.service.assertWorkspaceRemovalAllowed(userId, workspaceId)
    service.deleteWorkspace(userId, workspaceId)
    return c.json(ok({ deleted: true }))
  })

  routes.get('/conversation/workspaces/:workspaceId/threads', (c) => {
    return c.json(ok(service.listThreads(userIdFrom(c), c.req.param('workspaceId'))))
  })

  routes.post('/conversation/workspaces/:workspaceId/threads', async (c) => {
    const body = await c.req
      .json<{ title?: string; provider?: string }>()
      .catch((): { title?: string; provider?: string } => ({}))
    const thread = service.createThread(userIdFrom(c), {
      workspaceId: c.req.param('workspaceId'),
      title: body.title,
      provider: body.provider
    })
    return c.json(ok(thread), 201)
  })

  routes.patch('/conversation/threads/:threadId', async (c) => {
    const body = await c.req.json<{ title?: string; provider?: string }>()
    const userId = userIdFrom(c)
    const threadId = c.req.param('threadId')
    if (typeof body.title === 'string') service.renameThread(userId, threadId, body.title)
    if (typeof body.provider === 'string') {
      service.switchThreadProvider(userId, threadId, body.provider)
    }
    return c.json(ok(service.getThread(userId, threadId)))
  })

  routes.get('/conversation/threads/:threadId', (c) => {
    return c.json(ok(service.getThread(userIdFrom(c), c.req.param('threadId'))))
  })

  routes.delete('/conversation/threads/:threadId', (c) => {
    service.deleteThread(userIdFrom(c), c.req.param('threadId'))
    return c.json(ok({ deleted: true }))
  })

  routes.get('/conversation/threads/:threadId/messages', (c) => {
    return c.json(ok(service.listMessages(userIdFrom(c), c.req.param('threadId'))))
  })

  routes.post('/conversation/threads/:threadId/turns', async (c) => {
    const body = await c.req.json<{ prompt?: string }>()
    const userId = userIdFrom(c)
    const threadId = c.req.param('threadId')
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
    c.header('Cache-Control', 'no-store, no-transform')
    c.header('X-Content-Type-Options', 'nosniff')

    return stream(c, async (writer) => {
      try {
        for await (const event of ctx.conversation.streamTurn({
          userId,
          threadId,
          prompt: body.prompt ?? '',
          signal: c.req.raw.signal
        })) {
          await writer.write(ndjson(event))
        }
      } catch (error) {
        const result = toErrorHttpResult(error)
        await writer.write(
          ndjson({
            type: 'error',
            status: result.body.status,
            message: result.body.message,
            data: result.body.data
          })
        )
      }
    })
  })

  routes.post('/fs/browse', async (c) => {
    const body = await c.req.json<{ partialPath?: string }>()
    return c.json(ok(browse(body.partialPath ?? '')))
  })

  routes.get('/fs/parent', (c) => {
    return c.json(ok({ parentPath: parentBrowsePath(c.req.query('path') ?? '') }))
  })

  routes.post('/fs/mkdir', async (c) => {
    const body = await c.req.json<{ parentPath?: string; name?: string }>()
    return c.json(
      ok({
        path: createChildDirectory(body.parentPath ?? '', body.name ?? '')
      }),
      201
    )
  })

  return routes
}
