import { Hono } from 'hono'
import type { AppContext } from '../context'
import { requireUsername } from '../auth/session'
import { readThreadAttachment, saveThreadAttachment } from '../conversation/attachments'
import { AppError } from '../error'
import { ok } from '../response'
import { bodySizeLimit } from '../middleware/body-limiter'
import {
  MAX_MULTIPART_BODY_BYTES,
  MAX_UPLOAD_FILE_BYTES,
  parseLimitedMultipartFiles
} from '../middleware/multipart-upload'
import { validateAssetToken } from '../auth/asset-token'
import { signAssetUrl } from '../auth/sign-asset-url'
import { getThread, getThreadOwnerUsername } from '../threads/service'
import {
  assertFrozenAttachmentId,
  assertFrozenThreadId,
  FrozenIdError
} from '../../shared/frozen-ids'
import { throwIfCurrentRequestAborted } from '../context/request-abort'

function frozenIdToAppError(error: FrozenIdError): AppError {
  return AppError.badRequest(error.message, error.code)
}

export function createAttachmentRoutes(ctx: AppContext): Hono {
  const routes = new Hono()

  routes.post('/:threadId/attachments', bodySizeLimit(MAX_MULTIPART_BODY_BYTES), async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    let threadId: string
    try {
      threadId = assertFrozenThreadId(c.req.param('threadId'))
    } catch (error) {
      if (error instanceof FrozenIdError) throw frozenIdToAppError(error)
      throw error
    }

    const thread = await getThread(username, threadId)
    if (!thread) {
      throw AppError.notFound('Thread not found', 'thread.not_found')
    }

    const [file] = await parseLimitedMultipartFiles(c, {
      maxFiles: 1,
      maxFileBytes: MAX_UPLOAD_FILE_BYTES,
      minFiles: 1,
      emptyErrorCode: 'attachment.missing_file_field',
      emptyErrorMessage: 'Missing file field'
    })

    throwIfCurrentRequestAborted()
    const attachment = saveThreadAttachment({
      threadId,
      name: file.name,
      mimeType: file.mimeType,
      buffer: file.buffer
    })

    return c.json(
      ok({
        attachment: {
          ...attachment,
          assetUrl: signAssetUrl(ctx.security.authSecret, attachment.assetUrl, username)
        }
      })
    )
  })

  routes.get('/:threadId/attachments/:attachmentId', async (c) => {
    let threadId: string
    let attachmentId: string
    try {
      threadId = assertFrozenThreadId(c.req.param('threadId'))
      attachmentId = assertFrozenAttachmentId(c.req.param('attachmentId'))
    } catch (error) {
      if (error instanceof FrozenIdError) throw frozenIdToAppError(error)
      throw error
    }

    const authHeader = c.req.header('Authorization')
    const assetToken = c.req.query('asset_token') || c.req.header('x-asset-token')

    if (assetToken) {
      const owner = await getThreadOwnerUsername(threadId)
      if (!owner) {
        throw AppError.notFound('Thread not found', 'thread.not_found')
      }
      if (!validateAssetToken(ctx.security.authSecret, assetToken, owner, threadId, attachmentId)) {
        throw AppError.unauthorized('Invalid or expired asset token', 'auth.invalid_asset_token')
      }
    } else {
      const username = await requireUsername(authHeader)
      const thread = await getThread(username, threadId)
      if (!thread) {
        throw AppError.notFound('Thread not found', 'thread.not_found')
      }
    }

    throwIfCurrentRequestAborted()
    const result = readThreadAttachment(threadId, attachmentId)
    if (!result) {
      throw AppError.notFound('Attachment not found', 'attachment.not_found')
    }

    return new Response(new Uint8Array(result.buffer), {
      headers: {
        'Content-Type': result.attachment.mimeType,
        'Content-Length': String(result.buffer.length),
        'Cache-Control': 'private, max-age=3600'
      }
    })
  })

  return routes
}
