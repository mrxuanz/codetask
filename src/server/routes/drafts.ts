import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import type { AppContext } from '../context'
import { getRequestAuthPrincipal } from '../auth/session'
import { AppError, toErrorHttpResult } from '../error'
import { DraftError } from '../core/domain/draft'
import { isSupportedCoreCode } from '../../shared/providers/codes'
import { ok } from '../response'

function userIdFrom(context: Parameters<typeof getRequestAuthPrincipal>[0]): string {
  const principal = getRequestAuthPrincipal(context)
  if (!principal) throw AppError.unauthorized()
  return principal.userId
}
function ndjson(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}
function number(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new DraftError('draft.invalid_request', { field })
  }
  return parsed
}

export function createDraftRoutes(ctx: AppContext): Hono {
  const routes = new Hono()
  const service = ctx.draft.service

  routes.get('/draft-settings', (c) => c.json(ok(service.getSettings(userIdFrom(c)))))
  routes.put('/draft-settings', async (c) => {
    const body = await c.req.json<{
      discussionPrompt?: unknown
      discussionSkillsManual?: unknown
      plannerPrompt?: unknown
      skillsManual?: unknown
      expectedRevision?: number
    }>()
    return c.json(ok(service.updateSettings(userIdFrom(c), body)))
  })

  routes.get('/drafts', (c) => {
    const workspaceId = c.req.query('workspaceId')?.trim() || undefined
    return c.json(ok(service.listDrafts(userIdFrom(c), workspaceId)))
  })
  routes.post('/drafts/planner-sessions', async (c) => {
    const body = await c.req.json<{
      workspaceId?: string
      provider?: string
      initialPrompt?: string
    }>()
    const provider = body.provider ?? ''
    if (!isSupportedCoreCode(provider)) {
      throw new DraftError('draft.provider_invalid')
    }
    return c.json(
      ok(
        ctx.draft.startPlannerSession({
          userId: userIdFrom(c),
          workspaceId: body.workspaceId?.trim() ?? '',
          provider,
          initialPrompt: body.initialPrompt ?? ''
        })
      ),
      201
    )
  })
  routes.post('/drafts', async (c) => {
    const body = await c.req.json<{
      workspaceId?: string
      sourceThreadId?: string | null
      title?: string
      objective?: string
      requirements?: string
      constraints?: string
      acceptanceCriteria?: string
    }>()
    return c.json(
      ok(
        service.createDraft(userIdFrom(c), {
          workspaceId: body.workspaceId ?? '',
          sourceThreadId: body.sourceThreadId,
          title: body.title ?? '',
          objective: body.objective ?? '',
          requirements: body.requirements ?? '',
          constraints: body.constraints ?? '',
          acceptanceCriteria: body.acceptanceCriteria ?? ''
        })
      ),
      201
    )
  })
  routes.get('/drafts/:draftId', (c) => {
    return c.json(ok(service.getDraft(userIdFrom(c), c.req.param('draftId'))))
  })
  routes.put('/drafts/:draftId', async (c) => {
    const body = await c.req.json<{
      expectedRevision?: number
      title?: string
      objective?: string
      requirements?: string
      constraints?: string
      acceptanceCriteria?: string
    }>()
    return c.json(
      ok(
        service.updateDraft(userIdFrom(c), c.req.param('draftId'), {
          expectedRevision: number(body.expectedRevision, 'expectedRevision'),
          title: body.title ?? '',
          objective: body.objective ?? '',
          requirements: body.requirements ?? '',
          constraints: body.constraints ?? '',
          acceptanceCriteria: body.acceptanceCriteria ?? ''
        })
      )
    )
  })
  routes.delete('/drafts/:draftId', async (c) => {
    await ctx.draft.deletePlannerDraft(userIdFrom(c), c.req.param('draftId'))
    return c.json(ok({ deleted: true }))
  })

  routes.post('/drafts/:draftId/attachments', async (c) => {
    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) throw new DraftError('draft.attachment_required')
    const result = await service.addAttachment(userIdFrom(c), c.req.param('draftId'), {
      expectedRevision: number(form.get('expectedRevision'), 'expectedRevision'),
      displayName: file.name,
      mediaType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer())
    })
    return c.json(ok(result), 201)
  })
  routes.get('/drafts/:draftId/attachments/:attachmentId', async (c) => {
    const result = service.resolveAttachment(
      userIdFrom(c),
      c.req.param('draftId'),
      c.req.param('attachmentId')
    )
    const bytes = await readFile(result.absolutePath)
    c.header('Content-Type', result.attachment.mediaType)
    c.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(result.attachment.displayName)}`
    )
    c.header('X-Content-Type-Options', 'nosniff')
    return c.body(bytes)
  })
  routes.delete('/drafts/:draftId/attachments/:attachmentId', async (c) => {
    const expectedRevision = number(c.req.query('expectedRevision'), 'expectedRevision')
    const draft = await service.removeAttachment(
      userIdFrom(c),
      c.req.param('draftId'),
      c.req.param('attachmentId'),
      expectedRevision
    )
    return c.json(ok({ draft }))
  })

  routes.post('/drafts/:draftId/generate', (c) => {
    const userId = userIdFrom(c)
    const draftId = c.req.param('draftId')
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
    c.header('Cache-Control', 'no-store, no-transform')
    c.header('X-Content-Type-Options', 'nosniff')
    return stream(c, async (writer) => {
      try {
        for await (const event of ctx.draft.streamGeneration({
          userId,
          draftId,
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
  routes.post('/drafts/:draftId/planner-turns', async (c) => {
    const body = await c.req.json<{ prompt?: string }>()
    const userId = userIdFrom(c)
    const draftId = c.req.param('draftId')
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
    c.header('Cache-Control', 'no-store, no-transform')
    c.header('X-Content-Type-Options', 'nosniff')
    return stream(c, async (writer) => {
      try {
        for await (const event of ctx.draft.streamPlannerTurn({
          userId,
          draftId,
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
  routes.post('/drafts/:draftId/confirm', async (c) => {
    const body = await c.req.json<{ expectedRevision?: number; treeId?: string }>()
    const handoff = await service.confirmExecutionTree(
      userIdFrom(c),
      c.req.param('draftId'),
      {
        expectedRevision: number(body.expectedRevision, 'expectedRevision'),
        treeId: body.treeId?.trim() ?? ''
      }
    )
    const job = ctx.job.acceptHandoff(handoff.id)
    return c.json(
      ok({ handoff, job }),
      202
    )
  })

  return routes
}
