import assert from 'node:assert/strict'
import test from 'node:test'
import { migration040DestructiveAuthCurrent } from '../../src/server/db/migrations/040_destructive_auth_current'
import { NodeSqliteAdapter } from '../helpers/node-sqlite-adapter'

test('migration 040 destroys only legacy auth state and installs the current auth schema', () => {
  const db = new NodeSqliteAdapter()
  try {
    db.exec(`
      CREATE TABLE auth_state (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        session_token TEXT,
        session_expires_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE auth_guard_state (id INTEGER PRIMARY KEY);
      CREATE TABLE auth_rate_bucket (bucket_key TEXT, bucket_start INTEGER);
      CREATE TABLE captcha_challenge (id TEXT PRIMARY KEY);
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        workspace_root TEXT NOT NULL
      );
      INSERT INTO projects (id, username, workspace_root)
      VALUES ('project-1', 'ops_user', '/workspace');
    `)
    db.prepare(
      `INSERT INTO auth_state (
         id, username, password_hash, session_token, session_expires_at, created_at
       ) VALUES (1, 'ops_user', 'legacy', 'plaintext-token', 9999999999, 1)`
    ).run()

    migration040DestructiveAuthCurrent.up(db as never)

    const tableNames = new Set(
      (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
          name: string
        }>
      ).map((row) => row.name)
    )
    assert.equal(tableNames.has('auth_state'), false)
    assert.equal(tableNames.has('auth_guard_state'), false)
    assert.equal(tableNames.has('auth_rate_bucket'), false)
    assert.equal(tableNames.has('captcha_challenge'), false)
    assert.equal(tableNames.has('auth_users'), true)
    assert.equal(tableNames.has('auth_sessions'), true)
    assert.equal(tableNames.has('auth_challenges'), true)
    assert.equal(tableNames.has('auth_throttles'), true)
    assert.equal(tableNames.has('auth_audit'), true)
    const project = db.prepare(`SELECT id FROM projects`).get() as { id: string }
    assert.equal(project.id, 'project-1')
  } finally {
    db.close()
  }
})
