import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import { migration027ControlPlaneSchema } from '../../../src/server/db/migrations/027_control_plane_schema'
import { setAppCommitForTests } from '../../../scripts/control-plane/app-commit'
import {
  hashCanonicalJson,
  mapLegacyJob,
  mapLegacyJobs,
  readReport,
  resolveLegacySourceIdentity,
  validateCopyReport,
  writeReport
} from '../../../scripts/control-plane/migration-lib'
import {
  assertVerifiedBackup,
  backupSqliteDatabase,
  copyLegacyDatabase,
  cutoverDatabase,
  readVerifiedBackup,
  restoreSqliteBackup,
  runDatabasePreflight
} from '../../../scripts/control-plane/migration-db'
import { writeCutoverReleaseGate } from '../../../scripts/control-plane/release-gate'

interface MakeDatabaseOptions {
  readonly status?: string | null
  readonly planStatus?: string
  readonly planRevision?: number
  readonly planConfirmedAt?: number | null
  readonly withPlanGraph?: boolean
  readonly userVersion?: number
  readonly skipMaintenance?: boolean
}

function makeDatabase(options: MakeDatabaseOptions = {}): string {
  const {
    status = null,
    planStatus = 'pending',
    planRevision = 1,
    planConfirmedAt = 1,
    withPlanGraph = false,
    userVersion = 0,
    skipMaintenance = false
  } = options
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
    CREATE TABLE job_plan_tasks (
      job_id TEXT, task_id TEXT, ability_code TEXT, core_code TEXT
    );
    CREATE TABLE job_plan_milestones (
      job_id TEXT, milestone_index INTEGER, title TEXT, sort_order INTEGER
    );
    CREATE TABLE job_plan_slices (
      job_id TEXT, milestone_index INTEGER, slice_index INTEGER, title TEXT, sort_order INTEGER
    );
    CREATE TABLE job_artifacts (
      job_id TEXT, content_hash TEXT, content_inline TEXT, kind TEXT
    );
  `)
  migration027ControlPlaneSchema.up(db)
  if (!skipMaintenance) {
    db.prepare(
      `INSERT INTO control_schema_meta (key, value, source_migration, updated_at_ms) VALUES ('maintenance_mode', 'true', 27, 1)`
    ).run()
    db.prepare(
      `INSERT INTO control_schema_meta (key, value, source_migration, updated_at_ms) VALUES ('scheduler_stopped', 'true', 27, 1)`
    ).run()
  }
  if (status) {
    db.prepare(`INSERT INTO threads VALUES ('thread-1', 'project-1')`).run()
    db.prepare(
      `INSERT INTO thread_jobs VALUES ('job-1', 'thread-1', 'draft-1', 'Example', 'summary', ?, ?, ?, ?, NULL, 1, 2, NULL)`
    ).run(status, planStatus, planRevision, planConfirmedAt)
    db.prepare(
      `INSERT INTO job_tasks VALUES ('job-1', 'task-1', 'Task', 0, 'completed', NULL, NULL, NULL)`
    ).run()
    if (withPlanGraph) {
      db.prepare(
        `INSERT INTO job_plan_tasks VALUES ('job-1', 'task-1', 'ability-a', 'core-a')`
      ).run()
      db.prepare(
        `INSERT INTO job_plan_milestones VALUES ('job-1', 0, 'Milestone', 0)`
      ).run()
      db.prepare(`INSERT INTO job_plan_slices VALUES ('job-1', 0, 0, 'Slice', 0)`).run()
      db.prepare(
        `INSERT INTO job_artifacts VALUES ('job-1', 'hash-1', '{"kind":"note"}', 'note')`
      ).run()
    }
  }
  if (userVersion > 0) {
    db.pragma(`user_version = ${userVersion}`)
  }
  db.close()
  return path
}

describe('offline control-plane migration', () => {
  it('preflights and backs up a valid empty database', async () => {
    const dbPath = makeDatabase()
    const identity = resolveLegacySourceIdentity(dbPath)
    const preflight = runDatabasePreflight(dbPath)
    assert.equal(preflight.ok, true)
    assert.equal(preflight.databaseIdentity?.sha256, identity.sha256)
    const backup = await backupSqliteDatabase(dbPath, `${dbPath}.backup`)
    assert.equal(backup.userVersion, 0)
    assert.ok(backup.backupSha256)
    const db = new Database(dbPath, { readonly: true })
    const stored = readVerifiedBackup(db, backup.backupId)
    assert.ok(stored)
    assert.equal(stored?.sourceDatabaseIdentity.sha256, identity.sha256)
    db.close()
  })

  it('copies normal jobs idempotently with a stable report hash', () => {
    const dbPath = makeDatabase({ status: 'pending', withPlanGraph: true })
    const first = copyLegacyDatabase(dbPath)
    const second = copyLegacyDatabase(dbPath)
    assert.equal(first.reportHash, second.reportHash)
    assert.equal(first.perJobProjectionHashes['job-1'], second.perJobProjectionHashes['job-1'])
    const db = new Database(dbPath, { readonly: true })
    assert.equal(
      (db.prepare(`SELECT state FROM control_jobs WHERE id = 'job-1'`).get() as { state: string }).state,
      'execution_queued'
    )
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS count FROM control_plan_revisions`).get() as { count: number }).count,
      1
    )
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS count FROM control_plan_milestones`).get() as { count: number }).count,
      1
    )
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS count FROM control_evidence_blobs`).get() as { count: number }).count,
      1
    )
    assert.equal(
      (db.prepare(`SELECT value FROM control_schema_meta WHERE key = 'control_schema_generation'`).get() as {
        value: string
      }).value,
      'copied'
    )
    db.close()
    rmSync(dirname(dbPath), { recursive: true, force: true })
  })

  it('maps legacy statuses per CR7 table', () => {
    const cases: Array<[LegacyInput, string]> = [
      [{ id: 'j1', status: 'planning', planProgress: { status: 'pending' } }, 'planning_queued'],
      [{ id: 'j2', status: 'plan_editing' }, 'plan_review'],
      [{ id: 'j3', status: 'plan_ready' }, 'plan_review'],
      [{ id: 'j4', status: 'plan_confirmed' }, 'execution_queued'],
      [{ id: 'j5', status: 'pending' }, 'execution_queued'],
      [{ id: 'j6', status: 'running' }, 'failed'],
      [
        {
          id: 'j7',
          status: 'paused',
          currentPlanRevision: 2,
          planConfirmedAt: 1
        },
        'paused'
      ]
    ]
    for (const [input, expectedState] of cases) {
      const result = mapLegacyJob(input)
      assert.equal(result.kind, 'mapped', JSON.stringify(input))
      if (result.kind === 'mapped') {
        assert.equal(result.value.state, expectedState, JSON.stringify(input))
      }
    }
    const planningRunning = mapLegacyJob({
      id: 'j8',
      status: 'planning',
      planProgress: { status: 'running' }
    })
    assert.equal(planningRunning.kind, 'mapped')
    if (planningRunning.kind === 'mapped') {
      assert.equal(planningRunning.value.state, 'failed')
    }
    const pausedUnproven = mapLegacyJob({ id: 'j9', status: 'paused' })
    assert.equal(pausedUnproven.kind, 'conflict')
  })

  it('blocks authoritative cutover for a conflicted report', () => {
    const dbPath = makeDatabase({ status: 'pending' })
    const report = copyLegacyDatabase(dbPath)
    const conflict = mapLegacyJobs(
      [{ id: 'job-1', status: 'completed', planProgress: { status: 'running' } }],
      { sourceDatabaseIdentity: report.sourceDatabaseIdentity, sourceUserVersion: report.sourceUserVersion }
    )
    assert.throws(() => cutoverDatabase(dbPath, conflict, 'backup-1'), /migration\.has_conflicts/)
    const db = new Database(dbPath, { readonly: true })
    assert.equal(
      (db.prepare(`SELECT value FROM control_schema_meta WHERE key = 'control_schema_generation'`).get() as {
        value: string
      }).value,
      'copied'
    )
    db.close()
    rmSync(dirname(dbPath), { recursive: true, force: true })
  })

  it('rejects arbitrary backup IDs during cutover', async () => {
    setAppCommitForTests('cr7-test-commit')
    const dbPath = makeDatabase({ status: 'pending' })
    const report = copyLegacyDatabase(dbPath)
    const db = new Database(dbPath)
    writeCutoverReleaseGate(db, { appCommit: 'cr7-test-commit', verificationSummary: { ok: true } })
    db.close()
    try {
      assert.throws(
        () => cutoverDatabase(dbPath, report, 'not-a-real-backup', { expectedAppCommit: 'cr7-test-commit' }),
        /migration\.backup_record_missing/
      )
    } finally {
      setAppCommitForTests(null)
      rmSync(dirname(dbPath), { recursive: true, force: true })
    }
  })

  it('rejects tampered report rehash', () => {
    const dbPath = makeDatabase({ status: 'pending' })
    const report = copyLegacyDatabase(dbPath)
    const reportPath = join(dirname(dbPath), 'report.json')
    writeReport(reportPath, report)
    const tampered = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>
    tampered.mappedCount = (tampered.mappedCount as number) + 1
    writeFileSync(reportPath, JSON.stringify(tampered, null, 2))
    assert.throws(() => readReport(reportPath), /migration\.report_hash_mismatch/)
    rmSync(dirname(dbPath), { recursive: true, force: true })
  })

  it('rejects corrupt non-SQLite database during preflight', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'offline-migration-corrupt-')), 'broken.db')
    writeFileSync(path, 'not sqlite')
    assert.throws(() => runDatabasePreflight(path))
    rmSync(dirname(path), { recursive: true, force: true })
  })

  it('fails preflight without maintenance mode', () => {
    const dbPath = makeDatabase({ skipMaintenance: true })
    const result = runDatabasePreflight(dbPath)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'migration.maintenance_mode_required')
    rmSync(dirname(dbPath), { recursive: true, force: true })
  })

  it('restores backup with integrity and foreign key checks', async () => {
    const dbPath = makeDatabase({ status: 'pending' })
    const backupPath = `${dbPath}.backup`
    const restoredPath = `${dbPath}.restored`
    const backup = await backupSqliteDatabase(dbPath, backupPath)
    await restoreSqliteBackup(backupPath, restoredPath, backup.backupSha256)
    const restored = new Database(restoredPath, { readonly: true })
    assert.equal(String(restored.pragma('integrity_check', { simple: true })), 'ok')
    assert.equal((restored.pragma('foreign_key_check') as unknown[]).length, 0)
    restored.close()
    rmSync(dirname(dbPath), { recursive: true, force: true })
  })

  it('blocks cutover on projection hash mismatch', async () => {
    setAppCommitForTests('cr7-projection')
    const dbPath = makeDatabase({ status: 'pending' })
    const report = copyLegacyDatabase(dbPath)
    const backup = await backupSqliteDatabase(dbPath, `${dbPath}.backup`)
    const db = new Database(dbPath)
    writeCutoverReleaseGate(db, { appCommit: 'cr7-projection', verificationSummary: { ok: true } })
    db.close()
    const tampered = {
      ...report,
      perJobProjectionHashes: {
        ...report.perJobProjectionHashes,
        'job-1': hashCanonicalJson({ tampered: true })
      }
    }
    try {
      assert.throws(
        () => cutoverDatabase(dbPath, tampered, backup.backupId, { expectedAppCommit: 'cr7-projection' }),
        /migration\.report_hash_mismatch|migration\.projection_hash_mismatch/
      )
    } finally {
      setAppCommitForTests(null)
      rmSync(dirname(dbPath), { recursive: true, force: true })
    }
  })

  it('asserts verified backup binding to source identity', async () => {
    const dbPath = makeDatabase({ status: 'pending' })
    const backup = await backupSqliteDatabase(dbPath, `${dbPath}.backup`)
    const db = new Database(dbPath, { readonly: true })
    const identity = resolveLegacySourceIdentity(dbPath)
    assert.doesNotThrow(() => assertVerifiedBackup(db, identity, backup.backupId))
    assert.throws(
      () => assertVerifiedBackup(db, { ...identity, sha256: 'deadbeef' }, backup.backupId),
      /migration\.backup_source_identity_mismatch/
    )
    db.close()
    rmSync(dirname(dbPath), { recursive: true, force: true })
  })

  it('validates copy report stable hash fields only', () => {
    const dbPath = makeDatabase({ status: 'pending' })
    const report = copyLegacyDatabase(dbPath)
    const validation = validateCopyReport(report)
    assert.equal(validation.ok, true)
    const withNewTimestamp = { ...report, generatedAtMs: report.generatedAtMs + 99_999 }
    const validation2 = validateCopyReport(withNewTimestamp)
    assert.equal(validation2.ok, true)
    rmSync(dirname(dbPath), { recursive: true, force: true })
  })
})

type LegacyInput = {
  readonly id: string
  readonly status: string
  readonly planProgress?: { readonly status: string }
  readonly currentPlanRevision?: number | null
  readonly planConfirmedAt?: number | null
}
