import { Hono } from 'hono'
import type { AppContext } from '../context'
import { requireUsername } from '../auth/session'
import { AppError } from '../error'
import { ok } from '../response'
import { bodySizeLimit } from '../middleware/body-limiter'
import {
  MAX_MULTIPART_BODY_BYTES,
  parseLimitedMultipartFilesFromForm
} from '../middleware/multipart-upload'
import { signAssetUrlsInValue } from '../auth/sign-asset-url'
import { toPublicReferenceManifest } from '@shared/job-references'
import type { DraftReference } from '@shared/reference-corpus'
import {
  addAttachmentToCorpus,
  addLocalCorpusToCorpus,
  freezeReferenceCorpus,
  listReferenceCorpus,
  loadFrozenManifest,
  removeCorpusItem,
  updateCorpusItem
} from '../reference-corpus/service'

export function createDesignSessionRoutes(ctx: AppContext): Hono {
  const routes = new Hono()

  routes.get('/:threadId/design-sessions/:sessionId/references', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const threadId = c.req.param('threadId')
    const sessionId = c.req.param('sessionId')
    const { getDesignSessionAsJob } = await import('../design-session/service')
    const session = await getDesignSessionAsJob(username, threadId, sessionId)
    if (!session) throw AppError.notFound('Design session not found', 'design_session.not_found')
    const references = await listReferenceCorpus(sessionId)
    return c.json(
      ok({
        references: signAssetUrlsInValue(ctx.security.authSecret, references)
      })
    )
  })

  routes.post(
    '/:threadId/design-sessions/:sessionId/references/attachment',
    bodySizeLimit(MAX_MULTIPART_BODY_BYTES),
    async (c) => {
      const username = await requireUsername(c.req.header('Authorization'))
      const threadId = c.req.param('threadId')
      const sessionId = c.req.param('sessionId')
      const form = await c.req.parseBody()
      const description = typeof form.description === 'string' ? form.description.trim() : ''
      if (!description)
        throw AppError.badRequest('Description is required', 'draft.reference_description_missing')

      const uploadFiles = await parseLimitedMultipartFilesFromForm(form, {
        emptyErrorCode: 'draft.references_required',
        emptyErrorMessage: 'At least one reference file is required'
      })

      const added: DraftReference[] = []
      for (const file of uploadFiles) {
        added.push(
          await addAttachmentToCorpus({
            username,
            threadId,
            designSessionId: sessionId,
            name: file.name,
            mimeType: file.mimeType,
            buffer: file.buffer,
            description
          })
        )
      }
      return c.json(
        ok({
          references: signAssetUrlsInValue(ctx.security.authSecret, added)
        })
      )
    }
  )

  routes.post('/:threadId/design-sessions/:sessionId/references/local-corpus', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{
      localPath?: string
      name?: string
      description?: string
      kind?: 'file' | 'directory'
    }>()
    if (!body.localPath?.trim())
      throw AppError.badRequest('localPath is required', 'draft.local_path_required')
    if (!body.description?.trim())
      throw AppError.badRequest('Description is required', 'draft.reference_description_missing')

    const reference = await addLocalCorpusToCorpus({
      username,
      threadId: c.req.param('threadId'),
      designSessionId: c.req.param('sessionId'),
      localPath: body.localPath.trim(),
      name: body.name?.trim() ?? '',
      description: body.description.trim(),
      kind: body.kind
    })
    return c.json(ok({ reference }))
  })

  routes.patch('/:threadId/design-sessions/:sessionId/references/:refId', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{ description?: string; name?: string }>()
    const reference = await updateCorpusItem({
      username,
      threadId: c.req.param('threadId'),
      designSessionId: c.req.param('sessionId'),
      refId: c.req.param('refId'),
      description: body.description,
      name: body.name
    })
    return c.json(ok({ reference }))
  })

  routes.delete('/:threadId/design-sessions/:sessionId/references/:refId', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    await removeCorpusItem({
      username,
      threadId: c.req.param('threadId'),
      designSessionId: c.req.param('sessionId'),
      refId: c.req.param('refId')
    })
    return c.json(ok({ removed: true }))
  })

  routes.post('/:threadId/design-sessions/:sessionId/references/freeze', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const manifest = await freezeReferenceCorpus({
      username,
      threadId: c.req.param('threadId'),
      designSessionId: c.req.param('sessionId')
    })
    return c.json(ok({ manifest: toPublicReferenceManifest(manifest) }))
  })

  routes.get('/:threadId/design-sessions/:sessionId/reference-manifest', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const { getDesignSessionAsJob } = await import('../design-session/service')
    const session = await getDesignSessionAsJob(
      username,
      c.req.param('threadId'),
      c.req.param('sessionId')
    )
    if (!session) throw AppError.notFound('Design session not found', 'design_session.not_found')
    const manifest = await loadFrozenManifest(c.req.param('sessionId'))
    return c.json(ok({ manifest: manifest ? toPublicReferenceManifest(manifest) : null }))
  })

  routes.post('/:threadId/design-sessions/:sessionId/launch', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const { launchJobFromDesignSession } = await import('../design-session/service')
    const job = await launchJobFromDesignSession(
      username,
      c.req.param('threadId'),
      c.req.param('sessionId')
    )
    return c.json(ok({ job }))
  })

  return routes
}
