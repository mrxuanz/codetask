import type Database from 'better-sqlite3'
import type { ConversationMigration } from './conversation.ts'

function nowIso(): string {
  return new Date().toISOString()
}

function toIsoFromSec(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec)) return null
  return new Date(sec * 1000).toISOString()
}

function mapProvider(code: string | null | undefined): string {
  const raw = (code ?? 'codex').trim().toLowerCase()
  if (raw === 'claude-code' || raw === 'claude') return 'claude'
  if (raw === 'cursorcli' || raw === 'cursor') return 'cursor'
  if (raw === 'opencode') return 'opencode'
  return 'codex'
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

/** Migrate chat-only threads/messages/turns into Conversation tables (03 §19). */
export const migration049ConversationDataMigrate: ConversationMigration = {
  version: 49,
  name: 'conversation_data_migrate',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS migration_failures (
        id TEXT PRIMARY KEY NOT NULL,
        migration_name TEXT NOT NULL,
        source_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      );
    `)

    if (!tableExists(db, 'threads')) return

    const insertThread = db.prepare(`
      INSERT OR IGNORE INTO conversation_threads (
        id, actor_id, project_id, title, title_source, provider_code, state, state_revision,
        created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)
    `)

    const insertMessage = db.prepare(`
      INSERT OR IGNORE INTO conversation_messages (
        id, conversation_id, turn_id, role, kind, content, provider_code, model,
        thinking_text, thinking_duration_ms, created_at
      ) VALUES (?, ?, NULL, ?, 'text', ?, ?, NULL, ?, ?, ?)
    `)

    const insertTurn = db.prepare(`
      INSERT OR IGNORE INTO conversation_turns (
        id, conversation_id, actor_id, state, input_text, provider_code, workspace_access,
        settings_snapshot_json, settings_hash, idempotency_key, request_hash, state_revision,
        last_error_json, created_at, admitted_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', '', ?, '', ?, ?, ?, NULL, ?, ?)
    `)

    const threads = db
      .prepare(
        `SELECT id, username, project_id, title, title_source, core_code, thread_kind,
                created_at, updated_at, last_used_at
         FROM threads`
      )
      .all() as Array<{
      id: string
      username: string
      project_id: string
      title: string
      title_source: string
      core_code: string
      thread_kind: string
      created_at: number
      updated_at: number
      last_used_at: number | null
    }>

    const tx = db.transaction(() => {
      for (const row of threads) {
        if (row.thread_kind !== 'chat') {
          // Intentionally not recorded in migration_failures — Design/Execution own those rows.
          continue
        }

        insertThread.run(
          row.id,
          row.username,
          row.project_id,
          row.title,
          row.title_source === 'manual' ? 'manual' : 'auto',
          mapProvider(row.core_code),
          toIsoFromSec(row.created_at) ?? nowIso(),
          toIsoFromSec(row.updated_at) ?? nowIso(),
          toIsoFromSec(row.last_used_at)
        )

        if (!tableExists(db, 'thread_messages')) continue

        const messages = db
          .prepare(
            `SELECT id, role, kind, content, core_code, payload_json, created_at
             FROM thread_messages WHERE thread_id = ? ORDER BY created_at ASC`
          )
          .all(row.id) as Array<{
          id: string
          role: string
          kind: string
          content: string
          core_code: string
          payload_json: string | null
          created_at: string
        }>

        for (const msg of messages) {
          if (msg.kind !== 'text') {
            // Design/wizard message kinds stay out of Conversation; not a hard failure.
            continue
          }

          let thinking: string | null = null
          let thinkingMs: number | null = null
          if (msg.payload_json) {
            try {
              const payload = JSON.parse(msg.payload_json) as {
                thinking?: string
                thinkingDurationMs?: number
              }
              thinking = typeof payload.thinking === 'string' ? payload.thinking : null
              thinkingMs =
                typeof payload.thinkingDurationMs === 'number' ? payload.thinkingDurationMs : null
            } catch {
              // ignore
            }
          }

          const role =
            msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system'
              ? msg.role
              : 'assistant'

          insertMessage.run(
            msg.id,
            row.id,
            role,
            msg.content,
            mapProvider(msg.core_code),
            thinking,
            thinkingMs,
            typeof msg.created_at === 'string' && msg.created_at.includes('T')
              ? msg.created_at
              : toIsoFromSec(Number(msg.created_at)) ?? nowIso()
          )
        }
      }

      if (tableExists(db, 'conversation_turns_legacy')) {
        const turns = db
          .prepare(
            `SELECT id, thread_id, username, kind, status, workspace_access, provider, message_text,
                    idempotency_key, state_revision, last_error_json, created_at, started_at, completed_at
             FROM conversation_turns_legacy`
          )
          .all() as Array<{
          id: string
          thread_id: string
          username: string
          kind: string
          status: string
          workspace_access: string
          provider: string | null
          message_text: string
          idempotency_key: string | null
          state_revision: number
          last_error_json: string | null
          created_at: number
          started_at: number | null
          completed_at: number | null
        }>

        for (const turn of turns) {
          if (turn.kind !== 'chat') {
            continue
          }
          const conversation = db
            .prepare(`SELECT id FROM conversation_threads WHERE id = ?`)
            .get(turn.thread_id) as { id: string } | undefined
          if (!conversation) {
            continue
          }
          insertTurn.run(
            turn.id,
            turn.thread_id,
            turn.username,
            turn.status,
            turn.message_text,
            mapProvider(turn.provider),
            turn.workspace_access || 'live-read',
            turn.idempotency_key,
            turn.state_revision,
            turn.last_error_json,
            toIsoFromSec(turn.created_at) ?? nowIso(),
            toIsoFromSec(turn.started_at),
            toIsoFromSec(turn.completed_at)
          )
        }
      }
    })

    tx()
  }
}
