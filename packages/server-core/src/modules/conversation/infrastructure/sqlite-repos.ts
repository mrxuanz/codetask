import type Database from 'better-sqlite3'
import type { ProviderCode, TitleSource } from '@codetask/contracts'
import type { ConversationRecord, MessageRecord, TurnRecord } from '../domain/conversation.ts'
import { ACTIVE_TURN_STATES } from '../domain/conversation.ts'
import type {
  ConversationRepository,
  MessageRepository,
  TurnRepository
} from '../ports/ports.ts'

function mapConversation(row: Record<string, unknown>): ConversationRecord {
  return {
    id: String(row.id),
    actorId: String(row.actor_id),
    projectId: String(row.project_id),
    title: String(row.title),
    titleSource: row.title_source as TitleSource,
    providerCode: row.provider_code as ProviderCode,
    state: row.state as ConversationRecord['state'],
    stateRevision: Number(row.state_revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastUsedAt: row.last_used_at == null ? null : String(row.last_used_at)
  }
}

function mapMessage(row: Record<string, unknown>): MessageRecord {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    turnId: row.turn_id == null ? null : String(row.turn_id),
    role: row.role as MessageRecord['role'],
    kind: 'text',
    content: String(row.content),
    providerCode: (row.provider_code as ProviderCode | null) ?? null,
    model: row.model == null ? null : String(row.model),
    thinkingText: row.thinking_text == null ? null : String(row.thinking_text),
    thinkingDurationMs:
      row.thinking_duration_ms == null ? null : Number(row.thinking_duration_ms),
    createdAt: String(row.created_at)
  }
}

function mapTurn(row: Record<string, unknown>): TurnRecord {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    actorId: String(row.actor_id),
    state: row.state as TurnRecord['state'],
    inputText: String(row.input_text),
    providerCode: row.provider_code as ProviderCode,
    workspaceAccess: row.workspace_access as TurnRecord['workspaceAccess'],
    settingsSnapshotJson: String(row.settings_snapshot_json ?? '{}'),
    settingsHash: String(row.settings_hash ?? ''),
    idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
    requestHash: String(row.request_hash ?? ''),
    stateRevision: Number(row.state_revision),
    userMessageId: row.user_message_id == null ? null : String(row.user_message_id),
    assistantMessageId:
      row.assistant_message_id == null ? null : String(row.assistant_message_id),
    lastErrorJson: row.last_error_json == null ? null : String(row.last_error_json),
    createdAt: String(row.created_at),
    admittedAt: row.admitted_at == null ? null : String(row.admitted_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at)
  }
}

export function createSqliteConversationRepository(db: Database.Database): ConversationRepository {
  return {
    insert(row) {
      db.prepare(
        `INSERT INTO conversation_threads (
          id, actor_id, project_id, title, title_source, provider_code, state, state_revision,
          created_at, updated_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.id,
        row.actorId,
        row.projectId,
        row.title,
        row.titleSource,
        row.providerCode,
        row.state,
        row.stateRevision,
        row.createdAt,
        row.updatedAt,
        row.lastUsedAt
      )
    },
    get(id) {
      const row = db.prepare(`SELECT * FROM conversation_threads WHERE id = ?`).get(id) as
        | Record<string, unknown>
        | undefined
      return row ? mapConversation(row) : null
    },
    listForActor(actorId) {
      return (
        db
          .prepare(
            `SELECT * FROM conversation_threads WHERE actor_id = ? AND state = 'active'
             ORDER BY updated_at DESC, created_at DESC`
          )
          .all(actorId) as Record<string, unknown>[]
      ).map(mapConversation)
    },
    listForProject(actorId, projectId) {
      return (
        db
          .prepare(
            `SELECT * FROM conversation_threads
             WHERE actor_id = ? AND project_id = ? AND state = 'active'
             ORDER BY updated_at DESC, created_at DESC`
          )
          .all(actorId, projectId) as Record<string, unknown>[]
      ).map(mapConversation)
    },
    update(row) {
      db.prepare(
        `UPDATE conversation_threads SET
          title = ?, title_source = ?, provider_code = ?, state = ?, state_revision = ?,
          updated_at = ?, last_used_at = ?
         WHERE id = ?`
      ).run(
        row.title,
        row.titleSource,
        row.providerCode,
        row.state,
        row.stateRevision,
        row.updatedAt,
        row.lastUsedAt,
        row.id
      )
    },
    delete(id) {
      db.prepare(`DELETE FROM conversation_threads WHERE id = ?`).run(id)
    }
  }
}

export function createSqliteMessageRepository(db: Database.Database): MessageRepository {
  return {
    insert(row) {
      db.prepare(
        `INSERT INTO conversation_messages (
          id, conversation_id, turn_id, role, kind, content, provider_code, model,
          thinking_text, thinking_duration_ms, created_at
        ) VALUES (?, ?, ?, ?, 'text', ?, ?, ?, ?, ?, ?)`
      ).run(
        row.id,
        row.conversationId,
        row.turnId,
        row.role,
        row.content,
        row.providerCode,
        row.model,
        row.thinkingText,
        row.thinkingDurationMs,
        row.createdAt
      )
    },
    insertAttachments(rows) {
      if (rows.length === 0) return
      const stmt = db.prepare(
        `INSERT INTO conversation_message_attachments (
          id, message_id, conversation_id, asset_id, name, mime_type, size_bytes, kind, sort_order, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const tx = db.transaction((items: typeof rows) => {
        for (const row of items) {
          stmt.run(
            row.id,
            row.messageId,
            row.conversationId,
            row.assetId,
            row.name,
            row.mimeType,
            row.sizeBytes,
            row.kind,
            row.sortOrder,
            row.createdAt
          )
        }
      })
      tx(rows)
    },
    listAttachments(conversationId, messageIds) {
      if (messageIds.length === 0) return []
      const placeholders = messageIds.map(() => '?').join(',')
      return (
        db
          .prepare(
            `SELECT * FROM conversation_message_attachments
             WHERE conversation_id = ? AND message_id IN (${placeholders})
             ORDER BY sort_order ASC, created_at ASC`
          )
          .all(conversationId, ...messageIds) as Record<string, unknown>[]
      ).map((row) => ({
        id: String(row.id),
        messageId: String(row.message_id),
        conversationId: String(row.conversation_id),
        assetId: String(row.asset_id),
        name: String(row.name),
        mimeType: String(row.mime_type),
        sizeBytes: Number(row.size_bytes),
        kind: row.kind as 'image' | 'file',
        sortOrder: Number(row.sort_order),
        createdAt: String(row.created_at)
      }))
    },
    list(conversationId, limit) {
      const messages = (
        db
          .prepare(
            `SELECT * FROM conversation_messages WHERE conversation_id = ?
             ORDER BY created_at DESC LIMIT ?`
          )
          .all(conversationId, limit) as Record<string, unknown>[]
      )
        .reverse()
        .map(mapMessage)
      const attachments = this.listAttachments(
        conversationId,
        messages.map((m) => m.id)
      )
      if (attachments.length === 0) return messages
      const byMessage = new Map<string, typeof attachments>()
      for (const att of attachments) {
        const list = byMessage.get(att.messageId) ?? []
        list.push(att)
        byMessage.set(att.messageId, list)
      }
      return messages.map((message) => {
        const atts = byMessage.get(message.id)
        return atts?.length
          ? {
              ...message,
              attachments: atts.map((a) => ({
                id: a.id,
                assetId: a.assetId,
                name: a.name,
                mimeType: a.mimeType,
                sizeBytes: a.sizeBytes,
                kind: a.kind,
                sortOrder: a.sortOrder
              }))
            }
          : message
      })
    },
    deleteForConversation(conversationId) {
      db.prepare(`DELETE FROM conversation_message_attachments WHERE conversation_id = ?`).run(
        conversationId
      )
      db.prepare(`DELETE FROM conversation_messages WHERE conversation_id = ?`).run(conversationId)
    }
  }
}

export function createSqliteTurnRepository(db: Database.Database): TurnRepository {
  const activeList = ACTIVE_TURN_STATES.map((s) => `'${s}'`).join(',')
  return {
    insert(row) {
      db.prepare(
        `INSERT INTO conversation_turns (
          id, conversation_id, actor_id, state, input_text, provider_code, workspace_access,
          settings_snapshot_json, settings_hash, idempotency_key, request_hash, state_revision,
          user_message_id, assistant_message_id, last_error_json, created_at, admitted_at,
          started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.id,
        row.conversationId,
        row.actorId,
        row.state,
        row.inputText,
        row.providerCode,
        row.workspaceAccess,
        row.settingsSnapshotJson,
        row.settingsHash,
        row.idempotencyKey,
        row.requestHash,
        row.stateRevision,
        row.userMessageId,
        row.assistantMessageId,
        row.lastErrorJson,
        row.createdAt,
        row.admittedAt,
        row.startedAt,
        row.completedAt
      )
    },
    get(id) {
      const row = db.prepare(`SELECT * FROM conversation_turns WHERE id = ?`).get(id) as
        | Record<string, unknown>
        | undefined
      return row ? mapTurn(row) : null
    },
    getByIdempotency(actorId, key) {
      const row = db
        .prepare(
          `SELECT * FROM conversation_turns WHERE actor_id = ? AND idempotency_key = ? LIMIT 1`
        )
        .get(actorId, key) as Record<string, unknown> | undefined
      return row ? mapTurn(row) : null
    },
    update(row) {
      db.prepare(
        `UPDATE conversation_turns SET
          state = ?, workspace_access = ?, state_revision = ?, user_message_id = ?,
          assistant_message_id = ?, last_error_json = ?, admitted_at = ?, started_at = ?,
          completed_at = ?
         WHERE id = ?`
      ).run(
        row.state,
        row.workspaceAccess,
        row.stateRevision,
        row.userMessageId,
        row.assistantMessageId,
        row.lastErrorJson,
        row.admittedAt,
        row.startedAt,
        row.completedAt,
        row.id
      )
    },
    countActiveForActor(actorId) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS c FROM conversation_turns
           WHERE actor_id = ? AND state IN (${activeList})`
        )
        .get(actorId) as { c: number }
      return row?.c ?? 0
    },
    hasActiveForConversation(conversationId) {
      const row = db
        .prepare(
          `SELECT id FROM conversation_turns
           WHERE conversation_id = ? AND state IN (${activeList}) LIMIT 1`
        )
        .get(conversationId) as { id: string } | undefined
      return Boolean(row)
    },
    listQueued(actorId) {
      if (actorId) {
        return (
          db
            .prepare(
              `SELECT * FROM conversation_turns WHERE state = 'queued' AND actor_id = ?
               ORDER BY created_at ASC, id ASC`
            )
            .all(actorId) as Record<string, unknown>[]
        ).map(mapTurn)
      }
      return (
        db
          .prepare(
            `SELECT * FROM conversation_turns WHERE state = 'queued'
             ORDER BY created_at ASC, id ASC`
          )
          .all() as Record<string, unknown>[]
      ).map(mapTurn)
    },
    countQueuedAhead(conversationId, createdAt, turnId) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS c FROM conversation_turns
           WHERE conversation_id = ? AND state = 'queued'
             AND (created_at < ? OR (created_at = ? AND id < ?))`
        )
        .get(conversationId, createdAt, createdAt, turnId) as { c: number }
      return row?.c ?? 0
    },
    deleteForConversation(conversationId) {
      db.prepare(`DELETE FROM conversation_turns WHERE conversation_id = ?`).run(conversationId)
    }
  }
}
