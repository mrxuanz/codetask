import { randomUUID } from 'crypto'
import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '../db'
import { threadMessages, type ThreadMessage } from '../db/schema'
import { extractMessageThinking } from '../../shared/message-thinking'
import type { ConversationMessageDto, MessageAttachment } from './types'
import { getAppContext } from '../bootstrap'
import { readRetentionSettings } from '../retention/settings'
import {
  hydrateMessagePayload,
  prepareMessagePayloadForStorage,
  shouldExternalizeMessagePayload
} from '../retention/message-payload'
import {
  signAssetUrlsInValue,
  signAssetUrl,
  stripAssetUrlAuthTokens,
  stripAssetUrlAuthTokensInValue
} from '../auth/sign-asset-url'

interface MessageReadOptions {
  signAssets?: boolean
}

function nowIso(): string {
  return new Date().toISOString()
}

function parseAttachments(value: string | null | undefined): MessageAttachment[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as MessageAttachment[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function cleanAttachments(
  attachments: MessageAttachment[] | undefined
): MessageAttachment[] | undefined {
  if (!attachments?.length) return attachments
  return attachments.map((attachment) => ({
    ...attachment,
    assetUrl: stripAssetUrlAuthTokens(attachment.assetUrl)
  }))
}

async function mapMessage(
  row: ThreadMessage,
  options: MessageReadOptions = {}
): Promise<ConversationMessageDto> {
  const ctx = getAppContext()
  const dataDir = ctx.dataDir
  const signAssets = options.signAssets ?? true
  const payload = await hydrateMessagePayload({
    payloadJson: row.payloadJson,
    payloadArtifactId: row.payloadArtifactId,
    dataDir
  })
  const { text: thinking, durationMs: thinkingDurationMs } = extractMessageThinking(payload)
  const attachments = parseAttachments(row.attachmentsJson).map((attachment) =>
    signAssets
      ? {
          ...attachment,
          assetUrl: signAssetUrl(ctx.security.authSecret, attachment.assetUrl, row.username)
        }
      : attachment
  )
  return {
    id: row.id,
    role: row.role,
    kind: row.kind,
    content: row.content,
    attachments,
    coreCode: row.coreCode,
    sessionId: row.conversationId,
    conversationId: row.conversationId,
    runtimeSessionId: row.runtimeSessionId,
    wizardPhase: row.wizardPhase ?? null,
    thinking,
    thinkingDurationMs,
    payload: signAssets ? signAssetUrlsInValue(ctx.security.authSecret, payload, row.username) : payload,
    createdAt: row.createdAt
  }
}

export async function insertMessage(input: {
  id?: string
  threadId: string
  username: string
  role: string
  kind: string
  content: string
  coreCode: string
  conversationId: string
  runtimeSessionId?: string | null
  payload?: unknown
  attachments?: MessageAttachment[]
  wizardPhase?: string | null
}): Promise<ConversationMessageDto> {
  const id = input.id ?? `msg-${randomUUID()}`
  const db = getDb()
  const ctx = getAppContext()
  const settings = readRetentionSettings(ctx.settings)
  const payload = input.payload != null ? stripAssetUrlAuthTokensInValue(input.payload) : undefined
  const attachments = cleanAttachments(input.attachments)
  const externalizePayload =
    payload != null &&
    shouldExternalizeMessagePayload(payload, settings.messagePayloadInlineMaxBytes)

  await db.insert(threadMessages).values({
    id,
    threadId: input.threadId,
    username: input.username,
    role: input.role,
    kind: input.kind,
    content: input.content,
    coreCode: input.coreCode,
    conversationId: input.conversationId,
    runtimeSessionId: input.runtimeSessionId ?? null,
    payloadJson: payload != null && !externalizePayload ? JSON.stringify(payload) : null,
    payloadArtifactId: null,
    attachmentsJson: attachments?.length ? JSON.stringify(attachments) : null,
    wizardPhase: input.wizardPhase ?? null,
    createdAt: nowIso()
  })

  if (externalizePayload) {
    const stored = await prepareMessagePayloadForStorage({
      messageId: id,
      payload,
      dataDir: ctx.dataDir,
      settings,
      db
    })
    await db
      .update(threadMessages)
      .set({
        payloadJson: stored.payloadJson,
        payloadArtifactId: stored.payloadArtifactId
      })
      .where(eq(threadMessages.id, id))
  }

  const row = await getMessage(input.username, input.threadId, id)
  if (!row) {
    throw new Error('Failed to read message after writing')
  }
  return row
}

export async function getMessage(
  username: string,
  threadId: string,
  messageId: string,
  options: MessageReadOptions = {}
): Promise<ConversationMessageDto | null> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threadMessages)
    .where(
      and(
        eq(threadMessages.username, username),
        eq(threadMessages.threadId, threadId),
        eq(threadMessages.id, messageId)
      )
    )
    .limit(1)

  const row = rows[0]
  return row ? mapMessage(row, options) : null
}

/**
 * Prepare a message payload for storage (strip asset tokens + externalize large
 * payloads) WITHOUT writing the row. Callers that must persist the payload
 * atomically alongside other rows can compute this before opening a synchronous
 * transaction and then apply the returned columns inside it. (F2 §7.1)
 */
export async function prepareMessagePayloadColumns(
  messageId: string,
  payload: unknown
): Promise<{ payloadJson: string | null; payloadArtifactId: string | null }> {
  const ctx = getAppContext()
  const settings = readRetentionSettings(ctx.settings)
  const cleanPayload = stripAssetUrlAuthTokensInValue(payload)
  return prepareMessagePayloadForStorage({
    messageId,
    payload: cleanPayload,
    dataDir: ctx.dataDir,
    settings,
    db: getDb()
  })
}

export async function updateMessagePayload(
  username: string,
  threadId: string,
  messageId: string,
  payload: unknown
): Promise<ConversationMessageDto | null> {
  const db = getDb()
  const ctx = getAppContext()
  const settings = readRetentionSettings(ctx.settings)
  const cleanPayload = stripAssetUrlAuthTokensInValue(payload)
  const stored = await prepareMessagePayloadForStorage({
    messageId,
    payload: cleanPayload,
    dataDir: ctx.dataDir,
    settings,
    db
  })

  await db
    .update(threadMessages)
    .set({
      payloadJson: stored.payloadJson,
      payloadArtifactId: stored.payloadArtifactId
    })
    .where(
      and(
        eq(threadMessages.username, username),
        eq(threadMessages.threadId, threadId),
        eq(threadMessages.id, messageId)
      )
    )

  return getMessage(username, threadId, messageId)
}

export async function listMessages(
  username: string,
  threadId: string,
  limit: number,
  options: MessageReadOptions = {}
): Promise<ConversationMessageDto[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threadMessages)
    .where(and(eq(threadMessages.username, username), eq(threadMessages.threadId, threadId)))
    .orderBy(desc(threadMessages.createdAt))
    .limit(limit)

  const mapped = await Promise.all(rows.reverse().map((row) => mapMessage(row, options)))
  return mapped
}
