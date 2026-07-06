import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { allMigrations } from '../../src/server/db/migrations'
import { currentMigrationVersion, runMigrations } from '../../src/server/db/migrations/runner'

function seedDesignSession(db: Database.Database): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO projects (id, username, title, workspace_root, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('proj-1', 'alice', 'Demo', '/tmp/demo', now, now)
  db.prepare(
    `INSERT INTO threads (
       id, username, project_id, title, status, conversation_id, core_code,
       runtime_status, title_source, wizard_phase, thread_kind, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'thread-1',
    'alice',
    'proj-1',
    'Thread',
    'draft',
    'conv-1',
    'core',
    'idle',
    'auto',
    'collect',
    'chat',
    now,
    now
  )
  db.prepare(
    `INSERT INTO thread_messages (
       id, thread_id, username, role, kind, content, core_code, conversation_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('msg-1', 'thread-1', 'alice', 'user', 'text', 'hello', 'core', 'conv-1', String(now))
  db.prepare(
    `INSERT INTO design_sessions (
       id, thread_id, username, draft_message_id, title, workspace_root, status,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('ds-1', 'thread-1', 'alice', 'msg-1', 'Session', '/tmp/demo', 'active', now, now)
}

test('migrations apply through latest version on empty database', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db, allMigrations)
  assert.equal(currentMigrationVersion(db), 22)
  db.close()
})

test('migration 017 succeeds when design_sessions references threads (FK on)', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  const through16 = allMigrations.filter((m) => m.version <= 16)
  runMigrations(db, through16)
  seedDesignSession(db)
  assert.equal(currentMigrationVersion(db), 16)

  runMigrations(db, allMigrations)
  assert.equal(currentMigrationVersion(db), 22)
  const wizardPhase = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'threads'`)
    .get() as { sql: string }
  assert.match(wizardPhase.sql, /plan_generating/)
  db.close()
})
