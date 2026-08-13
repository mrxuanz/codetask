import { Hono } from 'hono'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { AppContext } from '../context'
import { requireAuthPrincipal } from '../auth/session'
import { locateThreadAttachment, saveThreadAttachment } from '../conversation/attachments'
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
import {
  assertAttachmentOwnerId,
  assertFrozenAttachmentId,
  FrozenIdError
} from '@codetask/server-core/modules/conversation'
import { throwIfCurrentRequestAborted } from '../context/request-abort'
import { getOrComposeConversation } from '../design-module'
import { ConversationForbiddenError, ConversationNotFoundError } from '@codetask/server-core'
import { getAssetOwnerUsage } from '../assets/registry'

const MAX_ATTACHMENTS_PER_CONVERSATION = 200
const MAX_ATTACHMENT_BYTES_PER_CONVERSATION = 512 * 1024 * 1024

function requestId(c: { get: (key: never) => unknown }): string {
  return (c.get('requestId' as never) as string | undefined) ?? 'unknown'
}

function frozenIdToAppError(error: FrozenIdError): AppError {
  return AppError.badRequest(error.message, error.code)
}

function assertSafeConversationId(conversationId: string): string {
  try {
    return assertAttachmentOwnerId(conversationId)
  } catch (error) {
    if (error instanceof FrozenIdError) {
      throw AppError.badRequest(error.message, error.code)
    }
    throw error
  }
}

function mapConversationAuthError(error: unknown): never {
  if (error instanceof ConversationNotFoundError) {
    throw AppError.notFound(error.message, error.code)
  }
  if (error instanceof ConversationForbiddenError) {
    throw AppError.unauthorized(error.message, error.code)
  }
  throw error instanceof Error ? error : new Error(String(error))
}

/**
 * Conversation-scoped attachment upload/download (architecture 03).
 * Storage reuses the attachment filesystem helpers keyed by conversation id.
 */
export function createAttachmentRoutes(ctx: AppContext): Hono {
  const routes = new Hono()

  routes.post(
    '/conversations/:conversationId/attachments',
    bodySizeLimit(MAX_MULTIPART_BODY_BYTES),
    async (c) => {
      const principal = requireAuthPrincipal()
      const conversationId = assertSafeConversationId(c.req.param('conversationId'))
      const conversation = getOrComposeConversation(ctx)
      try {
        conversation.app.get(
          { userId: principal.userId, sessionId: principal.sessionId },
          conversationId
        )
      } catch (error) {
        mapConversationAuthError(error)
      }

      const [file] = await parseLimitedMultipartFiles(c, {
        maxFiles: 1,
        maxFileBytes: MAX_UPLOAD_FILE_BYTES,
        minFiles: 1,
        emptyErrorCode: 'attachment.missing_file_field',
        emptyErrorMessage: 'Missing file field'
      })

      throwIfCurrentRequestAborted()
      const client = (ctx.db as AppContext['db'] & { $client?: import('better-sqlite3').Database })
        .$client
      if (client) {
        const usage = getAssetOwnerUsage(client, 'conversation', conversationId)
        if (
          usage.count >= MAX_ATTACHMENTS_PER_CONVERSATION ||
          usage.sizeBytes + file.buffer.length > MAX_ATTACHMENT_BYTES_PER_CONVERSATION
        ) {
          throw AppError.badRequest(
            'Conversation attachment quota exceeded',
            'attachment.quota_exceeded',
            {
              maxFiles: MAX_ATTACHMENTS_PER_CONVERSATION,
              maxBytes: MAX_ATTACHMENT_BYTES_PER_CONVERSATION
            }
          )
        }
      }
      const attachment = saveThreadAttachment({
        threadId: conversationId,
        name: file.name,
        mimeType: file.mimeType,
        buffer: file.buffer
      })

      return c.json(
        ok(
          {
            attachment: {
              ...attachment,
              assetUrl: signAssetUrl(ctx.security.authSecret, attachment.assetUrl, principal.userId)
            }
          },
          requestId(c)
        )
      )
    }
  )

  routes.get('/conversations/:conversationId/attachments/:attachmentId', async (c) => {
    let conversationId: string
    let attachmentId: string
    try {
      conversationId = assertSafeConversationId(c.req.param('conversationId'))
      attachmentId = assertFrozenAttachmentId(c.req.param('attachmentId'))
    } catch (error) {
      if (error instanceof FrozenIdError) throw frozenIdToAppError(error)
      throw error
    }

    const assetToken = c.req.query('asset_token') || c.req.header('x-asset-token')
    const conversation = getOrComposeConversation(ctx)

    if (assetToken) {
      const owner = conversation.app.ownerOf(conversationId)
      if (!owner) {
        throw AppError.notFound('Conversation not found', 'conversation.not_found')
      }
      if (
        !validateAssetToken(
          ctx.security.authSecret,
          assetToken,
          owner,
          conversationId,
          attachmentId
        )
      ) {
        throw AppError.unauthorized('Invalid or expired asset token', 'auth.invalid_asset_token')
      }
    } else {
      const principal = requireAuthPrincipal()
      try {
        conversation.app.get(
          { userId: principal.userId, sessionId: principal.sessionId },
          conversationId
        )
      } catch (error) {
        mapConversationAuthError(error)
      }
    }

    throwIfCurrentRequestAborted()
    const result = locateThreadAttachment(conversationId, attachmentId)
    if (!result) {
      throw AppError.notFound('Attachment not found', 'attachment.not_found')
    }

    const body = Readable.toWeb(createReadStream(result.absolutePath)) as ReadableStream<Uint8Array>
    return new Response(body, {
      headers: {
        'Content-Type': result.attachment.mimeType,
        'Content-Length': String(result.attachment.sizeBytes),
        'Cache-Control': 'private, max-age=3600'
      }
    })
  })

  return routes
}
