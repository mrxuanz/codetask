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

export function createAttachmentRoutes(ctx: AppContext): Hono {
  const routes = new Hono()

  routes.post('/:threadId/attachments', bodySizeLimit(MAX_MULTIPART_BODY_BYTES), async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const threadId = c.req.param('threadId')
    const [file] = await parseLimitedMultipartFiles(c, {
      maxFiles: 1,
      maxFileBytes: MAX_UPLOAD_FILE_BYTES,
      minFiles: 1,
      emptyErrorCode: 'attachment.missing_file_field',
      emptyErrorMessage: 'Missing file field'
    })

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
          assetUrl: signAssetUrl(ctx.security.authSecret, attachment.assetUrl)
        }
      })
    )
  })

  routes.get('/:threadId/attachments/:attachmentId', async (c) => {
    const threadId = c.req.param('threadId')
    const attachmentId = c.req.param('attachmentId')
    const authHeader = c.req.header('Authorization')
    const assetToken = c.req.query('asset_token') || c.req.header('x-asset-token')

    if (assetToken) {
      if (!validateAssetToken(ctx.security.authSecret, assetToken, threadId, attachmentId)) {
        throw AppError.unauthorized('Invalid or expired asset token', 'auth.invalid_asset_token')
      }
    } else {
      await requireUsername(authHeader)
    }

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
