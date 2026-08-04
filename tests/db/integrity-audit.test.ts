import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { pathToFileURL } from 'node:url'
import { allMigrations } from '../../src/server/db/migrations'
import { runMigrations } from '../../src/server/db/migrations/runner'

test('db-integrity-audit reports FK=0 and orphan attachment dirs on fresh migrated data', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'db-audit-'))
  const dbFile = join(dataDir, 'db', 'app.db')
  mkdirSync(join(dataDir, 'db'), { recursive: true })

  try {
    const db = new Database(dbFile)
    db.pragma('foreign_keys = ON')
    runMigrations(db, allMigrations)

    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      `INSERT INTO projects (id, actor_id, title, workspace_root, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('proj-audit', 'user', 'Audit', '/tmp/audit', now, now)

    const conversationId = `conv_${'d'.repeat(32)}`
    const nowIso = new Date().toISOString()
    db.prepare(
      `INSERT INTO conversation_threads (
        id, actor_id, project_id, title, title_source, provider_code,
        state, state_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      conversationId,
      'user',
      'proj-audit',
      'Chat',
      'manual',
      'codex',
      'active',
      0,
      nowIso,
      nowIso
    )

    const attachmentsRoot = join(dataDir, 'assets', 'attachments')
    mkdirSync(join(attachmentsRoot, conversationId), { recursive: true })
    mkdirSync(join(attachmentsRoot, 'orphan-dir'), { recursive: true })
    writeFileSync(join(attachmentsRoot, 'orphan-dir', 'x.txt'), 'x')

    db.close()

    const mod = await import(
      pathToFileURL(join(process.cwd(), 'scripts/db-integrity-audit.mjs')).href
    )
    const auditDb = new Database(dbFile, { readonly: true })
    auditDb.pragma('foreign_keys = ON')
    const report = mod.auditDatabase(auditDb, { dataDir })
    auditDb.close()

    assert.equal(report.schemaVersion, allMigrations.at(-1)?.version)
    assert.deepEqual(report.foreignKeyViolations, [])
    assert.ok(Array.isArray(report.tables))
    assert.ok(report.tables.some((t) => t.name === 'projects' && t.rowCount >= 1))
    assert.equal(report.attachmentOwnerDirs.orphanCount, 1)
    assert.ok(report.attachmentOwnerDirs.orphanIds.includes('orphan-dir'))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
