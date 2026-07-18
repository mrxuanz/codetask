import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import { migration027ControlPlaneSchema } from '../../../src/server/db/migrations/027_control_plane_schema'
import { setAppCommitForTests } from '../../../scripts/control-plane/app-commit'
import {
  backupSqliteDatabase,
  cutoverDatabase,
  copyLegacyDatabase
} from '../../../scripts/control-plane/migration-db'
import {
  CR_STAGES,
  writeCutoverReleaseGate,
  type CrCommandEvidence,
  type CrStage
} from '../../../scripts/control-plane/release-gate'
import { buildCrVerificationSummary } from '../../../scripts/control-plane/write-release-gate'

function makePassingCrEvidence(
  commit: string
): Record<CrStage, { readonly commands: readonly CrCommandEvidence[] }> {
  const out: Record<string, { readonly commands: readonly CrCommandEvidence[] }> = {}
  for (const stage of CR_STAGES) {
    out[stage] = {
      commands: [
        {
          command: `npm run test:control-plane -- --stage=${stage}`,
          exitCode: 0,
          startedAtMs: 1_000,
          endedAtMs: 2_000,
          logHash: `sha256-${stage.toLowerCase()}`,
          commit
        }
      ]
    }
  }
  return out as Record<CrStage, { readonly commands: readonly CrCommandEvidence[] }>
}

function makeCopiedDatabase(status: string): {
  readonly dbPath: string
  readonly report: ReturnType<typeof copyLegacyDatabase>
} {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'cutover-blocked-')), 'app.db')
  const db = new Database(dbPath)
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
  db.prepare(
    `INSERT INTO control_schema_meta (key, value, source_migration, updated_at_ms)
     VALUES ('maintenance_mode', 'true', 27, 1)`
  ).run()
  db.prepare(
    `INSERT INTO control_schema_meta (key, value, source_migration, updated_at_ms)
     VALUES ('scheduler_stopped', 'true', 27, 1)`
  ).run()
  db.prepare(`INSERT INTO threads VALUES ('thread-1', 'project-1')`).run()
  db.prepare(
    `INSERT INTO thread_jobs VALUES ('job-1', 'thread-1', 'draft-1', 'Example', 'summary', ?, 'pending', 1, 1, NULL, 1, 2, NULL)`
  ).run(status)
  db.prepare(
    `INSERT INTO job_tasks VALUES ('job-1', 'task-1', 'Task', 0, 'completed', NULL, NULL, NULL)`
  ).run()
  db.close()

  const report = copyLegacyDatabase(dbPath)
  return { dbPath, report }
}

describe('composition: cutover release gate (CR0)', () => {
  it('rejects authoritative cutover without release gate and leaves marker copied', async () => {
    setAppCommitForTests('test-commit-abc')
    const { dbPath, report } = makeCopiedDatabase('pending')
    const backup = await backupSqliteDatabase(dbPath, `${dbPath}.backup`)
    try {
      assert.throws(
        () =>
          cutoverDatabase(dbPath, report, backup.backupId, {
            expectedAppCommit: 'test-commit-abc'
          }),
        /migration\.release_gate_missing/
      )

      const db = new Database(dbPath, { readonly: true })
      assert.equal(
        (
          db
            .prepare(
              `SELECT value FROM control_schema_meta WHERE key = 'control_schema_generation'`
            )
            .get() as {
            value: string
          }
        ).value,
        'copied'
      )
      db.close()
    } finally {
      setAppCommitForTests(null)
      rmSync(dirname(dbPath), { recursive: true, force: true })
    }
  })
})

describe('composition: cutover release gate (CR8)', () => {
  it('succeeds with matching gate, verified backup, and valid report', async () => {
    setAppCommitForTests('cr8-cutover-commit')
    const { dbPath, report } = makeCopiedDatabase('pending')
    const backup = await backupSqliteDatabase(dbPath, `${dbPath}.backup`)
    const db = new Database(dbPath)
    writeCutoverReleaseGate(db, {
      appCommit: 'cr8-cutover-commit',
      verificationSummary: buildCrVerificationSummary(makePassingCrEvidence('cr8-cutover-commit'))
    })
    db.close()
    try {
      cutoverDatabase(dbPath, report, backup.backupId, { expectedAppCommit: 'cr8-cutover-commit' })

      const readDb = new Database(dbPath, { readonly: true })
      assert.equal(
        (
          readDb
            .prepare(
              `SELECT value FROM control_schema_meta WHERE key = 'control_schema_generation'`
            )
            .get() as { value: string }
        ).value,
        'v3_authoritative'
      )
      readDb.close()
    } finally {
      setAppCommitForTests(null)
      rmSync(dirname(dbPath), { recursive: true, force: true })
    }
  })

  it('rejects cutover when release gate commit does not match current app commit', async () => {
    setAppCommitForTests('cr8-expected-commit')
    const { dbPath, report } = makeCopiedDatabase('pending')
    const backup = await backupSqliteDatabase(dbPath, `${dbPath}.backup`)
    const db = new Database(dbPath)
    writeCutoverReleaseGate(db, {
      appCommit: 'cr8-wrong-commit',
      verificationSummary: buildCrVerificationSummary(makePassingCrEvidence('cr8-wrong-commit'))
    })
    db.close()
    try {
      assert.throws(
        () =>
          cutoverDatabase(dbPath, report, backup.backupId, {
            expectedAppCommit: 'cr8-expected-commit'
          }),
        /migration\.release_gate_commit_mismatch/
      )

      const readDb = new Database(dbPath, { readonly: true })
      assert.equal(
        (
          readDb
            .prepare(
              `SELECT value FROM control_schema_meta WHERE key = 'control_schema_generation'`
            )
            .get() as { value: string }
        ).value,
        'copied'
      )
      readDb.close()
    } finally {
      setAppCommitForTests(null)
      rmSync(dirname(dbPath), { recursive: true, force: true })
    }
  })
})
