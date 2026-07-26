import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import { ensureCoreMigrated } from '../../../src/server/composition/ensure-core-migrated.ts'
import { dataPaths } from '../../../src/server/data-paths.ts'

function buildTinyLegacy(dbFile: string): void {
  mkdirSync(dirname(dbFile), { recursive: true })
  const db = new Database(dbFile)
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
  `)
  const now = 1_700_000_000_000
  db.prepare(
    `INSERT INTO projects(id, username, title, workspace_root, created_at, updated_at)
     VALUES ('proj-1', 'alice', 'Demo', '/tmp/demo', ?, ?)`
  ).run(now, now)
  db.prepare(
    `INSERT INTO threads(id, username, project_id, title, status, created_at, updated_at)
     VALUES ('thread-1', 'alice', 'proj-1', 'Hello', 'active', ?, ?)`
  ).run(now, now)
  db.close()
}

describe('ensureCoreMigrated', () => {
  it('skips when legacy db is missing', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'codetask-ensure-empty-'))
    try {
      const coreSqlitePath = join(dataDir, 'core', 'kernel.sqlite')
      mkdirSync(join(dataDir, 'core'), { recursive: true })
      const result = ensureCoreMigrated({ dataDir, coreSqlitePath })
      assert.equal(result.migrated, false)
      assert.equal(result.reason, 'no-legacy-db')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('migrates tiny legacy fixture; second call skips nonempty core', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'codetask-ensure-mig-'))
    try {
      const legacyDb = dataPaths(dataDir).dbFile
      buildTinyLegacy(legacyDb)
      const coreSqlitePath = join(dataDir, 'core', 'kernel.sqlite')
      mkdirSync(join(dataDir, 'core'), { recursive: true })

      const first = ensureCoreMigrated({ dataDir, coreSqlitePath })
      assert.equal(first.migrated, true)
      assert.equal(first.reason, 'migrated')
      assert.equal(first.report?.counts.threads, 1)
      assert.equal(first.report?.counts.projects, 1)

      const core = new Database(coreSqlitePath, { readonly: true })
      const thread = core
        .prepare(`SELECT id FROM core_threads WHERE id = 'thread-1'`)
        .get() as { id: string } | undefined
      assert.equal(thread?.id, 'thread-1')
      core.close()

      const second = ensureCoreMigrated({ dataDir, coreSqlitePath })
      assert.equal(second.migrated, false)
      assert.equal(second.reason, 'core-nonempty')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('fail-closed: corrupt legacy db warns and does not throw (C2)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'codetask-ensure-corrupt-'))
    try {
      const legacyDb = dataPaths(dataDir).dbFile
      mkdirSync(dirname(legacyDb), { recursive: true })
      writeFileSync(legacyDb, 'not-a-sqlite-database')
      const coreSqlitePath = join(dataDir, 'core', 'kernel.sqlite')
      mkdirSync(join(dataDir, 'core'), { recursive: true })

      const warnings: string[] = []
      const result = ensureCoreMigrated({
        dataDir,
        coreSqlitePath,
        logger: {
          info() {},
          warn(message) {
            warnings.push(message)
          }
        }
      })
      assert.equal(result.migrated, false)
      assert.equal(result.reason, 'error')
      assert.ok(warnings.some((w) => w.includes('ensureCoreMigrated: failed')))
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
