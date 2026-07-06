import { DEFAULT_RETENTION_SETTINGS } from '../../shared/contracts/retention.ts'
import type { RetentionSettings } from '../../shared/contracts/retention.ts'
import type { getDb } from '../db'
import { getMessageArtifactPayload, putMessageArtifact } from './message-artifacts'

type AppDatabase = ReturnType<typeof getDb>

export function slimMessagePayloadForInline(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload
  const record = payload as Record<string, unknown>
  if (!('draftId' in record) && !('title' in record)) {
    return payload
  }
  return {
    draftId: record.draftId,
    sourceMessageId: record.sourceMessageId,
    title: record.title,
    summary: record.summary,
    status: record.status,
    linkedPlanId: record.linkedPlanId,
    revision: record.revision,
    lockedSections: record.lockedSections,
    workspacePath: record.workspacePath,
    userFlow: record.userFlow,
    techStack: record.techStack
  }
}

export function shouldExternalizeMessagePayload(
  payload: unknown,
  maxBytes = DEFAULT_RETENTION_SETTINGS.messagePayloadInlineMaxBytes
): boolean {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8') > maxBytes
}

export async function prepareMessagePayloadForStorage(input: {
  messageId: string
  payload: unknown | undefined | null
  dataDir: string
  settings?: RetentionSettings
  db?: AppDatabase
}): Promise<{ payloadJson: string | null; payloadArtifactId: string | null }> {
  if (input.payload == null) {
    return { payloadJson: null, payloadArtifactId: null }
  }

  const settings = input.settings ?? DEFAULT_RETENTION_SETTINGS
  const db = input.db
  if (!db) {
    const { getDb } = await import('../db')
    return prepareMessagePayloadForStorage({ ...input, db: getDb() })
  }

  if (!shouldExternalizeMessagePayload(input.payload, settings.messagePayloadInlineMaxBytes)) {
    return { payloadJson: JSON.stringify(input.payload), payloadArtifactId: null }
  }

  const artifactId = await putMessageArtifact({
    db,
    dataDir: input.dataDir,
    messageId: input.messageId,
    payload: input.payload,
    settings
  })

  return {
    payloadJson: JSON.stringify(slimMessagePayloadForInline(input.payload)),
    payloadArtifactId: artifactId
  }
}

export async function hydrateMessagePayload(input: {
  payloadJson: string | null | undefined
  payloadArtifactId: string | null | undefined
  dataDir: string
  db?: AppDatabase
}): Promise<unknown | undefined> {
  if (input.payloadArtifactId) {
    const db = input.db ?? (await import('../db')).getDb()
    const full = await getMessageArtifactPayload(db, input.dataDir, input.payloadArtifactId)
    if (full != null) return full
  }
  if (!input.payloadJson) return undefined
  try {
    return JSON.parse(input.payloadJson) as unknown
  } catch {
    return undefined
  }
}
