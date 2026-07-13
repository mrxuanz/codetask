import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import { migration027ControlPlaneSchema } from '../../../src/server/db/migrations/027_control_plane_schema'
import { mapLegacyJobs } from '../../../scripts/control-plane/migration-lib'
import {
  backupSqliteDatabase,
  copyLegacyDatabase,
  cutoverDatabase,
  runDatabasePreflight
} from '../../../scripts/control-plane/migration-db'

function makeDatabase(status: string | null): string {
  const path = join(mkdtempSync(join(tmpdir(), 'offline-migration-')), 'app.db')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE thread_jobs (
      id TEXT PRIMARY KEY, thread_id TEXT, draft_message_id TEXT, title TEXT, summary TEXT,
      status TEXT, plan_status TEXT, plan_revision INTEGER, plan_confirmed_at INTEGER,
      last_error TEXT, created_at INTEGER, updated_at INTEGER, terminal_at INTEGER
    );
    CREATE TABLE job_tasks (
      job_id TEXT, task_id TEXT, title TEXT, sort_order INTEGER, status TEXT,
      ability_code TEXT, core_code TEXT, error_message TEXT
    );
  `)
  migration027ControlPlaneSchema.up(db)
  db.prepare(`INSERT INTO control_schema_meta (key, value, source_migration, updated_at_ms) VALUES ('maintenance_mode', 'true', 27, 1)`).run()
  db.prepare(`INSERT INTO control_schema_meta (key, value, source_migration, updated_at_ms) VALUES ('scheduler_stopped', 'true', 27, 1)`).run()
  if (status) {
    db.prepare(`INSERT INTO threads VALUES ('thread-1', 'project-1')`).run()
    db.prepare(`INSERT INTO thread_jobs VALUES ('job-1', 'thread-1', 'draft-1', 'Example', 'summary', ?, 'pending', 1, 1, NULL, 1, 2, NULL)`).run(status)
    db.prepare(`INSERT INTO job_tasks VALUES ('job-1', 'task-1', 'Task', 0, 'completed', NULL, NULL, NULL)`).run()
  }
  db.close()
  return path
}

describe('offline control-plane migration', () => {
  it('preflights and backs up a valid empty database', async () => {
    const dbPath = makeDatabase(null)
    const preflight = runDatabasePreflight(dbPath)
    assert.equal(preflight.ok, true)
    const backup = await backupSqliteDatabase(dbPath, `${dbPath}.backup`)
    assert.equal(backup.userVersion, 0)
    assert.ok(backup.sha256)
  })

  it('copies normal jobs idempotently with a stable report hash', () => {
    const dbPath = makeDatabase('pending')
    const first = copyLegacyDatabase(dbPath)
    const second = copyLegacyDatabase(dbPath)
    assert.equal(first.reportHash, second.reportHash)
    const db = new Database(dbPath, { readonly: true })
    assert.equal((db.prepare(`SELECT state FROM control_jobs WHERE id = 'job-1'`).get() as { state: string }).state, 'execution_queued')
    assert.equal((db.prepare(`SELECT value FROM control_schema_meta WHERE key = 'control_schema_generation'`).get() as { value: string }).value, 'copied')
    db.close()
  })

  it('blocks authoritative cutover for a conflicted report', () => {
    const dbPath = makeDatabase('pending')
    copyLegacyDatabase(dbPath)
    const conflict = mapLegacyJobs([{ id: 'job-1', status: 'completed', planProgress: { status: 'running' } }])
    assert.throws(() => cutoverDatabase(dbPath, conflict, 'backup-1'))
    const db = new Database(dbPath, { readonly: true })
    assert.equal((db.prepare(`SELECT value FROM control_schema_meta WHERE key = 'control_schema_generation'`).get() as { value: string }).value, 'copied')
    db.close()
  })

  it('rejects a corrupt non-SQLite database during preflight', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'offline-migration-corrupt-')), 'broken.db')
    writeFileSync(path, 'not sqlite')
    assert.throws(() => runDatabasePreflight(path))
  })
})
