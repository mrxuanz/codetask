import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import {
  migrateLegacyToCore,
  UnmappableLegacyRowError,
  validateCoreDb
} from '../../../src/server/adapters/sqlite/index.ts'

function buildLegacyFixture(path: string): void {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      active_draft_id TEXT,
      active_plan_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE thread_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE thread_jobs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_revision INTEGER NOT NULL DEFAULT 0,
      draft_message_id TEXT,
      plan_confirmed_at INTEGER,
      plan_status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      terminal_at INTEGER
    );
    CREATE TABLE job_tasks (
      job_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (job_id, task_id)
    );
  `)

  const now = 1_700_000_000_000
  db.prepare(
    `INSERT INTO projects(id, username, title, workspace_root, created_at, updated_at)
     VALUES ('proj-1', 'alice', 'Demo', '/tmp/demo', ?, ?)`
  ).run(now, now)
  db.prepare(
    `INSERT INTO threads(id, username, project_id, title, status, active_draft_id, created_at, updated_at)
     VALUES ('thread-1', 'alice', 'proj-1', 'Hello', 'active', 'draft-1', ?, ?)`
  ).run(now, now)
  db.prepare(
    `INSERT INTO thread_messages(id, thread_id, username, role, kind, content, payload_json, created_at)
     VALUES ('draft-1', 'thread-1', 'alice', 'assistant', 'draft', 'Build a notes app', '{}', ?)`
  ).run(String(now))
  db.prepare(
    `INSERT INTO thread_jobs(
       id, thread_id, status, plan_revision, draft_message_id, plan_confirmed_at,
       created_at, updated_at, terminal_at
     ) VALUES ('job-1', 'thread-1', 'queued', 1, 'draft-1', NULL, ?, ?, NULL)`
  ).run(now, now)
  db.prepare(
    `INSERT INTO job_tasks(job_id, task_id, title, sort_order, status)
     VALUES ('job-1', 'task-1', 'Scaffold', 0, 'pending')`
  ).run()
  db.close()
}

describe('offline migrator dry-run', () => {
  it('maps a tiny legacy fixture into core_* and reports counts+hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codetask-migrate-'))
    const sourcePath = join(dir, 'legacy.sqlite')
    const targetPath = join(dir, 'core.sqlite')
    try {
      buildLegacyFixture(sourcePath)
      const report = migrateLegacyToCore({ sourcePath, targetPath })

      assert.equal(report.counts.projects, 1)
      assert.equal(report.counts.threads, 1)
      assert.equal(report.counts.drafts, 1)
      assert.equal(report.counts.plans, 1)
      assert.equal(report.counts.jobs, 1)
      assert.equal(report.counts.tasks, 1)
      assert.match(report.hash, /^[a-f0-9]{64}$/)

      const target = new Database(targetPath, { readonly: true })
      assert.equal(validateCoreDb(target).ok, true)
      const job = target.prepare(`SELECT status FROM core_jobs WHERE id = 'job-1'`).get() as {
        status: string
      }
      assert.equal(job.status, 'queued')
      target.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses unmappable thread with unknown project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codetask-migrate-bad-'))
    const sourcePath = join(dir, 'legacy.sqlite')
    const targetPath = join(dir, 'core.sqlite')
    try {
      const db = new Database(sourcePath)
      db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, username TEXT NOT NULL, title TEXT NOT NULL,
          workspace_root TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE threads (
          id TEXT PRIMARY KEY, username TEXT NOT NULL, project_id TEXT NOT NULL,
          title TEXT NOT NULL, status TEXT NOT NULL, active_draft_id TEXT, active_plan_id TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
      `)
      db.prepare(
        `INSERT INTO projects(id, username, title, workspace_root, created_at, updated_at)
         VALUES ('proj-1', 'alice', 'Demo', '/tmp/demo', 1, 1)`
      ).run()
      db.prepare(
        `INSERT INTO threads(id, username, project_id, title, status, created_at, updated_at)
         VALUES ('thread-1', 'alice', 'missing-proj', 'Hello', 'active', 1, 1)`
      ).run()
      db.close()

      assert.throws(
        () => migrateLegacyToCore({ sourcePath, targetPath }),
        (err: unknown) => err instanceof UnmappableLegacyRowError
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
