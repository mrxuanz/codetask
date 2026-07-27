import type Database from 'better-sqlite3'
import type { SupportedCoreCode } from '../../../../shared/providers/codes'
import type {
  ConversationMessageRecord,
  ConversationRepository,
  ConversationSettingsRecord,
  ConversationThreadRecord,
  ConversationTurnRecord,
  ConversationWorkspaceRecord
} from '../../../core/application/ports'

type SettingsRow = {
  user_id: string
  preferred_provider_code: SupportedCoreCode
  revision: number
  updated_at_ms: number
}

type WorkspaceRow = {
  id: string
  user_id: string
  title: string
  root_path: string
  canonical_key: string
  created_at_ms: number
  updated_at_ms: number
}

type ThreadRow = {
  id: string
  workspace_id: string
  thread_kind: 'chat' | 'planner'
  title: string
  selected_provider_code: SupportedCoreCode
  runtime_session_id: string | null
  created_at_ms: number
  updated_at_ms: number
  last_message_at_ms: number | null
}

type MessageRow = {
  id: string
  thread_id: string
  role: 'user' | 'assistant'
  content: string
  sequence: number
  created_at_ms: number
}

type TurnRow = {
  id: string
  thread_id: string
  user_message_id: string
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  selected_provider_code: SupportedCoreCode
  error_code: string | null
  error_message: string | null
  started_at_ms: number
  finished_at_ms: number | null
}

function settings(row: SettingsRow | undefined): ConversationSettingsRecord | null {
  return row
    ? {
        userId: row.user_id,
        provider: row.preferred_provider_code,
        revision: row.revision,
        updatedAtMs: row.updated_at_ms
      }
    : null
}

function workspace(row: WorkspaceRow | undefined): ConversationWorkspaceRecord | null {
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        title: row.title,
        rootPath: row.root_path,
        canonicalKey: row.canonical_key,
        createdAtMs: row.created_at_ms,
        updatedAtMs: row.updated_at_ms
      }
    : null
}

function thread(row: ThreadRow | undefined): ConversationThreadRecord | null {
  return row
    ? {
        id: row.id,
        workspaceId: row.workspace_id,
        kind: row.thread_kind,
        title: row.title,
        provider: row.selected_provider_code,
        runtimeSessionId: row.runtime_session_id,
        createdAtMs: row.created_at_ms,
        updatedAtMs: row.updated_at_ms,
        lastMessageAtMs: row.last_message_at_ms
      }
    : null
}

function message(row: MessageRow): ConversationMessageRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    sequence: row.sequence,
    createdAtMs: row.created_at_ms
  }
}

function turn(row: TurnRow | undefined): ConversationTurnRecord | null {
  return row
    ? {
        id: row.id,
        threadId: row.thread_id,
        userMessageId: row.user_message_id,
        state: row.state,
        provider: row.selected_provider_code,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        startedAtMs: row.started_at_ms,
        finishedAtMs: row.finished_at_ms
      }
    : null
}

const THREAD_SELECT = `SELECT conversation_threads.id, conversation_threads.workspace_id,
  conversation_threads.thread_kind, conversation_threads.title,
  conversation_threads.selected_provider_code,
  conversation_threads.runtime_session_id, conversation_threads.created_at_ms,
  conversation_threads.updated_at_ms, conversation_threads.last_message_at_ms
  FROM conversation_threads`

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly database: Database.Database) {}

  getSettings(userId: string): ConversationSettingsRecord | null {
    return settings(
      this.database
        .prepare(
          `SELECT user_id, preferred_provider_code, revision, updated_at_ms
           FROM conversation_settings WHERE user_id = ?`
        )
        .get(userId) as SettingsRow | undefined
    )
  }

  putSettings(record: ConversationSettingsRecord): void {
    this.database
      .prepare(
        `INSERT INTO conversation_settings
           (user_id, provider_code, model, preferred_provider_code, revision, updated_at_ms)
         VALUES (?, 'cursorcli', NULL, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           preferred_provider_code = excluded.preferred_provider_code,
           revision = excluded.revision,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(record.userId, record.provider, record.revision, record.updatedAtMs)
  }

  listWorkspaces(userId: string): ConversationWorkspaceRecord[] {
    return (
      this.database
        .prepare(
          `SELECT id, user_id, title, root_path, canonical_key, created_at_ms, updated_at_ms
           FROM conversation_workspaces
           WHERE user_id = ?
           ORDER BY updated_at_ms DESC, id`
        )
        .all(userId) as WorkspaceRow[]
    ).map((row) => workspace(row) as ConversationWorkspaceRecord)
  }

  getWorkspace(userId: string, workspaceId: string): ConversationWorkspaceRecord | null {
    return workspace(
      this.database
        .prepare(
          `SELECT id, user_id, title, root_path, canonical_key, created_at_ms, updated_at_ms
           FROM conversation_workspaces WHERE user_id = ? AND id = ?`
        )
        .get(userId, workspaceId) as WorkspaceRow | undefined
    )
  }

  getWorkspaceByCanonicalKey(
    userId: string,
    canonicalKey: string
  ): ConversationWorkspaceRecord | null {
    return workspace(
      this.database
        .prepare(
          `SELECT id, user_id, title, root_path, canonical_key, created_at_ms, updated_at_ms
           FROM conversation_workspaces WHERE user_id = ? AND canonical_key = ?`
        )
        .get(userId, canonicalKey) as WorkspaceRow | undefined
    )
  }

  insertWorkspace(record: ConversationWorkspaceRecord): void {
    this.database
      .prepare(
        `INSERT INTO conversation_workspaces
           (id, user_id, title, root_path, canonical_key, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.userId,
        record.title,
        record.rootPath,
        record.canonicalKey,
        record.createdAtMs,
        record.updatedAtMs
      )
  }

  deleteWorkspace(userId: string, workspaceId: string): boolean {
    return (
      this.database
        .prepare(`DELETE FROM conversation_workspaces WHERE user_id = ? AND id = ?`)
        .run(userId, workspaceId).changes === 1
    )
  }

  listThreads(
    userId: string,
    workspaceId: string,
    kind?: ConversationThreadRecord['kind']
  ): ConversationThreadRecord[] {
    const kindClause = kind ? ' AND conversation_threads.thread_kind = ?' : ''
    const values = kind ? [userId, workspaceId, kind] : [userId, workspaceId]
    return (
      this.database
        .prepare(
          `${THREAD_SELECT}
           JOIN conversation_workspaces w ON w.id = conversation_threads.workspace_id
           WHERE w.user_id = ? AND conversation_threads.workspace_id = ?${kindClause}
           ORDER BY conversation_threads.last_message_at_ms DESC,
                    conversation_threads.created_at_ms DESC,
                    conversation_threads.id`
        )
        .all(...values) as ThreadRow[]
    ).map((row) => thread(row) as ConversationThreadRecord)
  }

  getThread(userId: string, threadId: string): ConversationThreadRecord | null {
    return thread(
      this.database
        .prepare(
          `${THREAD_SELECT}
           JOIN conversation_workspaces w ON w.id = conversation_threads.workspace_id
           WHERE w.user_id = ? AND conversation_threads.id = ?`
        )
        .get(userId, threadId) as ThreadRow | undefined
    )
  }

  insertThread(record: ConversationThreadRecord): void {
    this.database
      .prepare(
        `INSERT INTO conversation_threads
           (id, workspace_id, thread_kind, title, provider_code, model, selected_provider_code,
            runtime_session_id, created_at_ms, updated_at_ms, last_message_at_ms)
         VALUES (?, ?, ?, ?, 'cursorcli', NULL, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.workspaceId,
        record.kind ?? 'chat',
        record.title,
        record.provider,
        record.runtimeSessionId,
        record.createdAtMs,
        record.updatedAtMs,
        record.lastMessageAtMs
      )
  }

  updateThreadTitle(userId: string, threadId: string, title: string, updatedAtMs: number): boolean {
    return (
      this.database
        .prepare(
          `UPDATE conversation_threads
           SET title = ?, updated_at_ms = ?
           WHERE id = ? AND workspace_id IN (
             SELECT id FROM conversation_workspaces WHERE user_id = ?
           )`
        )
        .run(title, updatedAtMs, threadId, userId).changes === 1
    )
  }

  updateThreadProvider(
    userId: string,
    threadId: string,
    provider: SupportedCoreCode,
    updatedAtMs: number
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE conversation_threads
           SET selected_provider_code = ?, runtime_session_id = NULL, updated_at_ms = ?
           WHERE id = ? AND workspace_id IN (
             SELECT id FROM conversation_workspaces WHERE user_id = ?
           )`
        )
        .run(provider, updatedAtMs, threadId, userId).changes === 1
    )
  }

  deleteThread(userId: string, threadId: string): boolean {
    return (
      this.database
        .prepare(
          `DELETE FROM conversation_threads
           WHERE id = ? AND workspace_id IN (
             SELECT id FROM conversation_workspaces WHERE user_id = ?
           )`
        )
        .run(threadId, userId).changes === 1
    )
  }

  listMessages(userId: string, threadId: string): ConversationMessageRecord[] {
    return (
      this.database
        .prepare(
          `SELECT m.id, m.thread_id, m.role, m.content, m.sequence, m.created_at_ms
           FROM conversation_messages m
           JOIN conversation_threads t ON t.id = m.thread_id
           JOIN conversation_workspaces w ON w.id = t.workspace_id
           WHERE w.user_id = ? AND m.thread_id = ?
           ORDER BY m.sequence`
        )
        .all(userId, threadId) as MessageRow[]
    ).map(message)
  }

  nextMessageSequence(threadId: string): number {
    const row = this.database
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM conversation_messages WHERE thread_id = ?`
      )
      .get(threadId) as { next_sequence: number }
    return row.next_sequence
  }

  insertMessage(record: ConversationMessageRecord): void {
    this.database
      .prepare(
        `INSERT INTO conversation_messages
           (id, thread_id, role, content, sequence, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.threadId,
        record.role,
        record.content,
        record.sequence,
        record.createdAtMs
      )
    this.database
      .prepare(
        `UPDATE conversation_threads
         SET updated_at_ms = ?, last_message_at_ms = ?
         WHERE id = ?`
      )
      .run(record.createdAtMs, record.createdAtMs, record.threadId)
  }

  getRunningTurn(threadId: string): ConversationTurnRecord | null {
    return turn(
      this.database
        .prepare(
          `SELECT id, thread_id, user_message_id, state, selected_provider_code,
                  error_code, error_message, started_at_ms, finished_at_ms
           FROM conversation_turns WHERE thread_id = ? AND state = 'running'`
        )
        .get(threadId) as TurnRow | undefined
    )
  }

  insertTurn(record: ConversationTurnRecord): void {
    this.database
      .prepare(
        `INSERT INTO conversation_turns
           (id, thread_id, user_message_id, state, provider_code, model, selected_provider_code,
            error_code, error_message, started_at_ms, finished_at_ms)
         VALUES (?, ?, ?, ?, 'cursorcli', NULL, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.threadId,
        record.userMessageId,
        record.state,
        record.provider,
        record.errorCode,
        record.errorMessage,
        record.startedAtMs,
        record.finishedAtMs
      )
  }

  completeTurn(input: {
    readonly turnId: string
    readonly threadId: string
    readonly assistantMessage: ConversationMessageRecord
    readonly runtimeSessionId: string | null
    readonly finishedAtMs: number
  }): boolean {
    const updated = this.database
      .prepare(
        `UPDATE conversation_turns
         SET state = 'completed', finished_at_ms = ?, error_code = NULL, error_message = NULL
         WHERE id = ? AND thread_id = ? AND state = 'running'`
      )
      .run(input.finishedAtMs, input.turnId, input.threadId)
    if (updated.changes !== 1) return false
    this.insertMessage(input.assistantMessage)
    this.database
      .prepare(
        `UPDATE conversation_threads
         SET runtime_session_id = ?, updated_at_ms = ?, last_message_at_ms = ?
         WHERE id = ?`
      )
      .run(input.runtimeSessionId, input.finishedAtMs, input.finishedAtMs, input.threadId)
    return true
  }

  failTurn(input: {
    readonly turnId: string
    readonly state: 'failed' | 'cancelled'
    readonly errorCode: string
    readonly errorMessage: string
    readonly finishedAtMs: number
  }): boolean {
    return (
      this.database
        .prepare(
          `UPDATE conversation_turns
           SET state = ?, error_code = ?, error_message = ?, finished_at_ms = ?
           WHERE id = ? AND state = 'running'`
        )
        .run(input.state, input.errorCode, input.errorMessage, input.finishedAtMs, input.turnId)
        .changes === 1
    )
  }
}
