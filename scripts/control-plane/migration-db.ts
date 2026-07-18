import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import {
  validateJobInvariant,
  type ActiveRunSummary
} from '../../src/server/domain/jobs/job-invariants'
import type { JobAggregate } from '@shared/contracts/control-plane'
import {
  parseControlIntent,
  parseJobState,
  parseResumeTarget
} from '../../src/server/infra/sqlite/control-plane/parsers'
import { resolveAppCommit } from './app-commit'
import {
  buildMigrationCopyReport,
  hashCanonicalJson,
  hashFile,
  mapLegacyJob,
  MIGRATION_COPY_SCOPE_TABLES,
  MIGRATION_COUNT_TABLES,
  migrationBackupMetaKey,
  resolveLegacySourceIdentity,
  type MigrationCopyReport,
  type MigrationInvariantSummary,
  type VerifiedBackupRecord
} from './migration-lib'
import { assertCutoverReleaseGate } from './release-gate'

type Sqlite = Database.Database
type Row = Record<string, unknown>

export interface MigrationPreflightOptions {
  readonly maintenanceMode?: boolean
  readonly schedulerStopped?: boolean
  readonly runtimeStopped?: boolean
  readonly activeChildren?: number
  readonly requiredUserVersion?: number
  readonly expectedDatabaseIdentity?: { readonly absolutePath: string; readonly sha256: string }
}

export interface DatabasePreflightResult {
  readonly ok: boolean
  readonly reason?: string
  readonly dbPath: string
  readonly databaseIdentity?: { readonly absolutePath: string; readonly sha256: string }
  readonly userVersion?: number
  readonly schemaGeneration?: string | undefined
  readonly integrityCheck?: string
  readonly foreignKeyViolations?: number
  readonly activeChildren?: number
  readonly freeBytes?: number
}

export interface SqliteBackupResult extends VerifiedBackupRecord {
  readonly sha256Path: string
}

function tableExists(db: Sqlite, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name))
}

function metadataValue(db: Sqlite, key: string): string | null {
  if (!tableExists(db, 'control_schema_meta')) return null
  const row = db.prepare(`SELECT value FROM control_schema_meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

function boolMetadata(db: Sqlite, key: string): boolean {
  return ['1', 'true', 'enabled', 'stopped'].includes((metadataValue(db, key) ?? '').toLowerCase())
}

function activeChildCount(db: Sqlite): number {
  if (!tableExists(db, 'control_runtime_instances')) return 0
  return (db
    .prepare(`SELECT COUNT(*) AS count FROM control_runtime_instances WHERE state != 'closed'`)
    .get() as { count: number }).count
}

function freeBytesFor(dbPath: string): number {
  const statfs = statfsSync(dirname(dbPath))
  return Number(statfs.bavail) * Number(statfs.bsize)
}

function assertCurrentMarker(db: Sqlite, expected: string): void {
  const marker = metadataValue(db, 'control_schema_generation')
  if (marker !== expected) {
    throw new Error(`migration.marker_not_${expected}`)
  }
}

export function runDatabasePreflight(
  dbPath: string,
  options: MigrationPreflightOptions = {}
): DatabasePreflightResult {
  if (!dbPath.trim() || !existsSync(dbPath)) {
    return { ok: false, reason: 'migration.db_missing', dbPath }
  }
  const databaseIdentity = resolveLegacySourceIdentity(dbPath)
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const userVersion = Number((db.pragma('user_version', { simple: true }) as number) ?? 0)
    const integrityCheck = String(db.pragma('integrity_check', { simple: true }) ?? '')
    const foreignKeyViolations = (db.pragma('foreign_key_check') as unknown[]).length
    const schemaGeneration = metadataValue(db, 'control_schema_generation')
    const activeChildren = activeChildCount(db)
    const freeBytes = freeBytesFor(dbPath)
    const maintenanceMode = options.maintenanceMode ?? boolMetadata(db, 'maintenance_mode')
    const schedulerStopped = options.schedulerStopped ?? boolMetadata(db, 'scheduler_stopped')
    const runtimeStopped = options.runtimeStopped ?? activeChildren === 0

    if (integrityCheck !== 'ok') {
      return { ok: false, reason: 'migration.integrity_check_failed', dbPath, integrityCheck, databaseIdentity }
    }
    if (foreignKeyViolations !== 0) {
      return {
        ok: false,
        reason: 'migration.foreign_key_check_failed',
        dbPath,
        foreignKeyViolations,
        databaseIdentity
      }
    }
    if (schemaGeneration !== 'preparing') {
      return {
        ok: false,
        reason: 'migration.marker_not_preparing',
        dbPath,
        schemaGeneration: schemaGeneration ?? undefined,
        databaseIdentity
      }
    }
    if (!maintenanceMode) {
      return { ok: false, reason: 'migration.maintenance_mode_required', dbPath, databaseIdentity }
    }
    if (!schedulerStopped || !runtimeStopped || activeChildren !== (options.activeChildren ?? 0)) {
      return { ok: false, reason: 'migration.runtime_not_stopped', dbPath, activeChildren, databaseIdentity }
    }
    if (options.requiredUserVersion !== undefined && userVersion !== options.requiredUserVersion) {
      return { ok: false, reason: 'migration.user_version_mismatch', dbPath, userVersion, databaseIdentity }
    }
    if (freeBytes < statSync(dbPath).size) {
      return { ok: false, reason: 'migration.insufficient_disk_space', dbPath, freeBytes, databaseIdentity }
    }
    if (
      options.expectedDatabaseIdentity &&
      (options.expectedDatabaseIdentity.absolutePath !== databaseIdentity.absolutePath ||
        options.expectedDatabaseIdentity.sha256 !== databaseIdentity.sha256)
    ) {
      return { ok: false, reason: 'migration.database_identity_mismatch', dbPath, databaseIdentity }
    }
    return {
      ok: true,
      dbPath,
      databaseIdentity,
      userVersion,
      schemaGeneration: schemaGeneration ?? undefined,
      integrityCheck,
      foreignKeyViolations,
      activeChildren,
      freeBytes
    }
  } finally {
    db.close()
  }
}

export function recordVerifiedBackup(db: Sqlite, record: VerifiedBackupRecord): void {
  if (!tableExists(db, 'control_schema_meta')) {
    throw new Error('migration.schema_meta_missing')
  }
  db.prepare(
    `INSERT INTO control_schema_meta (key, value, source_migration, validation_summary_json, updated_at_ms)
     VALUES (?, ?, 27, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       validation_summary_json = excluded.validation_summary_json,
       updated_at_ms = excluded.updated_at_ms`
  ).run(
    migrationBackupMetaKey(record.backupId),
    record.backupPath,
    JSON.stringify(record),
    record.createdAtMs
  )
}

export function readVerifiedBackup(db: Sqlite, backupId: string): VerifiedBackupRecord | null {
  const row = db
    .prepare(`SELECT validation_summary_json FROM control_schema_meta WHERE key = ?`)
    .get(migrationBackupMetaKey(backupId)) as { validation_summary_json: string | null } | undefined
  if (!row?.validation_summary_json) return null
  try {
    return JSON.parse(row.validation_summary_json) as VerifiedBackupRecord
  } catch {
    return null
  }
}

export function assertVerifiedBackup(
  db: Sqlite,
  sourceDatabaseIdentity: { readonly absolutePath: string; readonly sha256: string },
  backupId: string
): VerifiedBackupRecord {
  const record = readVerifiedBackup(db, backupId)
  if (record === null) {
    throw new Error('migration.backup_record_missing')
  }
  if (record.sourceDatabaseIdentity.sha256 !== sourceDatabaseIdentity.sha256) {
    throw new Error('migration.backup_source_identity_mismatch')
  }
  if (record.verification.integrityCheck !== 'ok' || record.verification.foreignKeyViolations !== 0) {
    throw new Error('migration.backup_not_verified')
  }
  return record
}

export async function backupSqliteDatabase(dbPath: string, backupPath: string): Promise<SqliteBackupResult> {
  if (!existsSync(dbPath)) throw new Error(`migration.db_missing: ${dbPath}`)
  const sourceDatabaseIdentity = resolveLegacySourceIdentity(dbPath)
  mkdirSync(dirname(backupPath), { recursive: true })
  const source = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    await source.backup(backupPath)
  } finally {
    source.close()
  }
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true })
  let sqliteVersion: string
  let userVersion: number
  let integrityCheck: string
  let foreignKeyViolations: number
  try {
    integrityCheck = String(backup.pragma('integrity_check', { simple: true }) ?? '')
    foreignKeyViolations = (backup.pragma('foreign_key_check') as unknown[]).length
    if (integrityCheck !== 'ok' || foreignKeyViolations !== 0) {
      throw new Error('migration.backup_validation_failed')
    }
    sqliteVersion = (backup.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version
    userVersion = Number(backup.pragma('user_version', { simple: true }) ?? 0)
  } finally {
    backup.close()
  }
  const backupSha256 = hashFile(backupPath)
  const sha256Path = `${backupPath}.sha256`
  writeFileSync(sha256Path, `${backupSha256}  ${backupPath}\n`, 'utf8')
  const backupId = randomUUID()
  const createdAtMs = Date.now()
  const appCommit = resolveAppCommit()
  const restoreCommand = `node --import tsx scripts/control-plane/restore.ts --backup "${backupPath}" --out "${dbPath}" --sha256 ${backupSha256}`
  const record: VerifiedBackupRecord = {
    backupId,
    sourceDatabaseIdentity,
    backupPath,
    backupSha256,
    backupBytes: statSync(backupPath).size,
    sqliteVersion,
    userVersion,
    appCommit,
    createdAtMs,
    restoreCommand,
    verification: {
      integrityCheck,
      foreignKeyViolations
    }
  }
  const writable = new Database(dbPath, { fileMustExist: true })
  try {
    recordVerifiedBackup(writable, record)
  } finally {
    writable.close()
  }
  return { ...record, sha256Path }
}

interface LegacyJobRow {
  id: string
  thread_id: string
  project_id: string | null
  draft_message_id: string
  title: string
  summary: string
  status: string
  plan_status: string
  plan_revision: number
  plan_confirmed_at: number | null
  last_error: string | null
  created_at: number
  updated_at: number
  terminal_at: number | null
}

function legacyProjectionHash(row: LegacyJobRow): string {
  return hashCanonicalJson(row)
}

function legacyJobs(db: Sqlite): LegacyJobRow[] {
  return db.prepare(`
    SELECT j.id, j.thread_id, t.project_id, j.draft_message_id, j.title, j.summary, j.status,
           j.plan_status, j.plan_revision, j.plan_confirmed_at, j.last_error, j.created_at,
           j.updated_at, j.terminal_at
    FROM thread_jobs j JOIN threads t ON t.id = j.thread_id ORDER BY j.id
  `).all() as LegacyJobRow[]
}

function insertEvidence(db: Sqlite, content: string, now: number): string {
  const hash = createHash('sha256').update(content).digest('hex')
  db.prepare(
    `INSERT OR IGNORE INTO control_evidence_blobs (hash, content_json, bytes, created_at_ms) VALUES (?, ?, ?, ?)`
  ).run(hash, content, Buffer.byteLength(content), now)
  return hash
}

function resetCopyScope(db: Sqlite): void {
  for (const table of MIGRATION_COPY_SCOPE_TABLES) {
    if (tableExists(db, table)) {
      db.prepare(`DELETE FROM ${table}`).run()
    }
  }
}

function copyChildren(db: Sqlite, row: LegacyJobRow, planRevision: number, now: number): void {
  if (planRevision > 0 && tableExists(db, 'job_plan_tasks')) {
    db.prepare(
      `INSERT INTO control_plan_revisions (id, job_id, plan_revision, status, content_hash, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      `${row.id}:plan:${planRevision}`,
      row.id,
      planRevision,
      row.plan_confirmed_at ? 'confirmed' : 'draft',
      legacyProjectionHash(row),
      now
    )
    const milestones = tableExists(db, 'job_plan_milestones')
      ? (db
          .prepare(`SELECT milestone_index, title, sort_order FROM job_plan_milestones WHERE job_id = ?`)
          .all(row.id) as Row[])
      : []
    const slices = tableExists(db, 'job_plan_slices')
      ? (db
          .prepare(
            `SELECT milestone_index, slice_index, title, sort_order FROM job_plan_slices WHERE job_id = ?`
          )
          .all(row.id) as Row[])
      : []
    const planTasks = db
      .prepare(`SELECT task_id, ability_code, core_code FROM job_plan_tasks WHERE job_id = ?`)
      .all(row.id) as Row[]
    for (const item of milestones) {
      db.prepare(`INSERT INTO control_plan_milestones VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        `${row.id}:milestone:${item.milestone_index}`,
        row.id,
        planRevision,
        String(item.milestone_index),
        String(item.title ?? ''),
        Number(item.sort_order),
        now
      )
    }
    for (const item of slices) {
      db.prepare(`INSERT INTO control_plan_slices VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        `${row.id}:slice:${item.milestone_index}:${item.slice_index}`,
        row.id,
        planRevision,
        String(item.milestone_index),
        `${item.milestone_index}:${item.slice_index}`,
        String(item.title ?? ''),
        Number(item.sort_order),
        now
      )
    }
    for (const item of planTasks) {
      db.prepare(`INSERT INTO control_plan_tasks VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        `${row.id}:plan-task:${String(item.task_id)}`,
        row.id,
        planRevision,
        String(item.task_id),
        item.ability_code ?? null,
        item.core_code ?? null,
        now
      )
    }
  }
  if (!tableExists(db, 'job_tasks')) return
  const tasks = db
    .prepare(
      `SELECT task_id, title, sort_order, status, ability_code, core_code, error_message FROM job_tasks WHERE job_id = ?`
    )
    .all(row.id) as Row[]
  for (const task of tasks) {
    const taskId = String(task.task_id)
    const legacyStatus = String(task.status)
    const state = legacyStatus === 'completed' ? 'completed' : legacyStatus === 'failed' ? 'failed' : 'queued'
    db.prepare(`INSERT INTO control_job_tasks VALUES (?, 0, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`).run(
      row.id,
      taskId,
      Math.max(1, planRevision),
      legacyStatus === 'running' ? 'failed' : state,
      Number(task.sort_order),
      String(task.title),
      task.ability_code ?? null,
      task.core_code ?? null,
      now,
      now
    )
    if (task.error_message || legacyStatus === 'failed' || legacyStatus === 'running') {
      const failureId = `${row.id}:task:${taskId}:failure`
      db.prepare(
        `INSERT INTO control_job_failures VALUES (?, ?, ?, 'recoverable', ?, 'execution', ?)`
      ).run(
        failureId,
        row.id,
        'migration.legacy_task_failure',
        task.error_message ?? 'legacy task failed',
        now
      )
    }
  }
  if (tableExists(db, 'job_artifacts')) {
    const artifacts = db
      .prepare(`SELECT content_hash, content_inline, kind FROM job_artifacts WHERE job_id = ?`)
      .all(row.id) as Row[]
    for (const artifact of artifacts) {
      insertEvidence(
        db,
        String(artifact.content_inline ?? JSON.stringify({ hash: artifact.content_hash, kind: artifact.kind })),
        now
      )
    }
  }
}

export function collectCountsByTable(db: Sqlite): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const table of MIGRATION_COUNT_TABLES) {
    counts[table] = tableExists(db, table)
      ? (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
      : 0
  }
  return counts
}

export function collectPerJobProjectionHashes(db: Sqlite): Record<string, string> {
  if (!tableExists(db, 'control_jobs')) return {}
  const jobs = db.prepare(`SELECT id FROM control_jobs ORDER BY id`).all() as Array<{ id: string }>
  const out: Record<string, string> = {}
  for (const job of jobs) {
    const row = db.prepare(`SELECT * FROM control_jobs WHERE id = ?`).get(job.id) as Row
    const childCounts = {
      planRevisions: tableExists(db, 'control_plan_revisions')
        ? (db
            .prepare(`SELECT COUNT(*) AS count FROM control_plan_revisions WHERE job_id = ?`)
            .get(job.id) as { count: number }).count
        : 0,
      planMilestones: tableExists(db, 'control_plan_milestones')
        ? (db
            .prepare(`SELECT COUNT(*) AS count FROM control_plan_milestones WHERE job_id = ?`)
            .get(job.id) as { count: number }).count
        : 0,
      planSlices: tableExists(db, 'control_plan_slices')
        ? (db
            .prepare(`SELECT COUNT(*) AS count FROM control_plan_slices WHERE job_id = ?`)
            .get(job.id) as { count: number }).count
        : 0,
      planTasks: tableExists(db, 'control_plan_tasks')
        ? (db
            .prepare(`SELECT COUNT(*) AS count FROM control_plan_tasks WHERE job_id = ?`)
            .get(job.id) as { count: number }).count
        : 0,
      jobTasks: tableExists(db, 'control_job_tasks')
        ? (db
            .prepare(`SELECT COUNT(*) AS count FROM control_job_tasks WHERE job_id = ?`)
            .get(job.id) as { count: number }).count
        : 0,
      failures: tableExists(db, 'control_job_failures')
        ? (db
            .prepare(`SELECT COUNT(*) AS count FROM control_job_failures WHERE job_id = ?`)
            .get(job.id) as { count: number }).count
        : 0,
      verifications: tableExists(db, 'control_verifications')
        ? (db
            .prepare(`SELECT COUNT(*) AS count FROM control_verifications WHERE job_id = ?`)
            .get(job.id) as { count: number }).count
        : 0,
      attempts: tableExists(db, 'control_task_attempts')
        ? (db
            .prepare(`SELECT COUNT(*) AS count FROM control_task_attempts WHERE job_id = ?`)
            .get(job.id) as { count: number }).count
        : 0
    }
    out[job.id] = hashCanonicalJson({ job: row, childCounts })
  }
  return out
}

export function runMigrationInvariantSummary(db: Sqlite): MigrationInvariantSummary {
  const integrityCheck = String(db.pragma('integrity_check', { simple: true }) ?? '')
  const foreignKeyViolations = (db.pragma('foreign_key_check') as unknown[]).length
  const invariantViolations: Array<{ jobId: string; code: string }> = []

  if (tableExists(db, 'control_jobs')) {
    const jobs = db
      .prepare(
        `SELECT id, thread_id, project_id, state, state_revision, control_intent, resume_target,
                current_plan_revision, execution_generation, active_run_id, last_failure_id
         FROM control_jobs ORDER BY id`
      )
      .all() as Array<{
      id: string
      thread_id: string
      project_id: string
      state: string
      state_revision: number
      control_intent: string
      resume_target: string | null
      current_plan_revision: number | null
      execution_generation: number
      active_run_id: string | null
      last_failure_id: string | null
    }>
    for (const job of jobs) {
      let activeRun: ActiveRunSummary | null = null
      if (job.active_run_id && tableExists(db, 'control_job_runs')) {
        const runRow = db
          .prepare(
            `SELECT id, state, fence_token, execution_generation, current_runtime_instance_id
             FROM control_job_runs WHERE id = ?`
          )
          .get(job.active_run_id) as
          | {
              id: string
              state: string
              fence_token: string
              execution_generation: number
              current_runtime_instance_id: string | null
            }
          | undefined
        if (runRow) {
          activeRun = {
            id: runRow.id,
            state: runRow.state,
            fenceToken: runRow.fence_token,
            executionGeneration: runRow.execution_generation,
            currentRuntimeInstanceId: runRow.current_runtime_instance_id
          }
        }
      }
      const aggregate: JobAggregate = {
        id: job.id,
        threadId: job.thread_id,
        projectId: job.project_id,
        state: parseJobState(job.state),
        stateRevision: job.state_revision,
        controlIntent: parseControlIntent(job.control_intent),
        resumeTarget:
          job.resume_target === null ? null : parseResumeTarget(job.resume_target),
        currentPlanRevision: job.current_plan_revision,
        executionGeneration: job.execution_generation,
        activeRunId: job.active_run_id,
        lastFailureId: job.last_failure_id
      }
      const violations = validateJobInvariant(aggregate, activeRun)
      for (const violation of violations) {
        invariantViolations.push({ jobId: job.id, code: violation.code })
      }
    }
  }

  return {
    integrityCheck,
    foreignKeyViolations,
    invariantViolations
  }
}

export function assertNoConflicts(report: MigrationCopyReport): void {
  if (report.hasConflicts || report.conflicts.length > 0) {
    throw new Error('migration.has_conflicts')
  }
}

export function assertAllCountsMatch(db: Sqlite, report: MigrationCopyReport): void {
  const actual = collectCountsByTable(db)
  for (const [table, expected] of Object.entries(report.countsByTable)) {
    if ((actual[table] ?? 0) !== expected) {
      throw new Error(`migration.table_count_mismatch:${table}`)
    }
  }
}

export function assertProjectionHashesMatch(db: Sqlite, report: MigrationCopyReport): void {
  const actual = collectPerJobProjectionHashes(db)
  for (const [jobId, expected] of Object.entries(report.perJobProjectionHashes)) {
    if (actual[jobId] !== expected) {
      throw new Error(`migration.projection_hash_mismatch:${jobId}`)
    }
  }
}

export function assertInvariantSweepEmpty(db: Sqlite): void {
  const summary = runMigrationInvariantSummary(db)
  if (summary.integrityCheck !== 'ok') {
    throw new Error('migration.invariant_sweep_failed')
  }
  if (summary.foreignKeyViolations !== 0) {
    throw new Error('migration.invariant_sweep_failed')
  }
  if (summary.invariantViolations.length !== 0) {
    throw new Error('migration.invariant_sweep_failed')
  }
}

export function copyLegacyDatabase(dbPath: string): MigrationCopyReport {
  const db = new Database(dbPath, { fileMustExist: true })
  db.pragma('foreign_keys = ON')
  const sourceDatabaseIdentity = resolveLegacySourceIdentity(dbPath, db)
  try {
    const sourceUserVersion = Number((db.pragma('user_version', { simple: true }) as number) ?? 0)
    const rows = legacyJobs(db)
    const seeds: Array<{
      seed: { id: string; state: string; controlIntent: string; resumeTarget: string | null }
      warnings: string[]
    }> = []
    const conflicts: Array<{ jobId: string; code: string; detail: string }> = []
    const warnings: string[] = []
    const countsByState: Record<string, number> = {}

    for (const row of rows) {
      const result = mapLegacyJob({
        id: row.id,
        status: row.status,
        planProgress: { status: row.plan_status },
        currentPlanRevision: row.plan_revision > 0 ? row.plan_revision : null,
        planConfirmedAt: row.plan_confirmed_at
      })
      if (result.kind === 'conflict') {
        conflicts.push({ jobId: row.id, code: result.code, detail: result.detail })
        continue
      }
      seeds.push({ seed: result.value, warnings: [...result.warnings] })
      countsByState[result.value.state] = (countsByState[result.value.state] ?? 0) + 1
      for (const warning of result.warnings) {
        warnings.push(`${row.id}: ${warning}`)
      }
    }

    if (conflicts.length > 0) {
      return buildMigrationCopyReport({
        generatedAtMs: Date.now(),
        sourceDatabaseIdentity,
        sourceUserVersion,
        sourceJobCount: rows.length,
        mappedCount: seeds.length,
        conflicts,
        countsByTable: Object.fromEntries(MIGRATION_COUNT_TABLES.map((table) => [table, 0])),
        countsByState,
        perJobProjectionHashes: {},
        invariantSummary: {
          integrityCheck: 'ok',
          foreignKeyViolations: 0,
          invariantViolations: []
        },
        mapped: seeds.map((item) => item.seed),
        warnings
      })
    }

    db.transaction(() => {
      const marker = metadataValue(db, 'control_schema_generation')
      if (marker !== 'preparing' && marker !== 'copied') {
        throw new Error('migration.marker_not_preparing')
      }
      resetCopyScope(db)
      for (const row of rows) {
        const seed = seeds.find((item) => item.seed.id === row.id)?.seed
        if (!seed) continue
        const currentPlanRevision =
          row.plan_confirmed_at && row.plan_revision > 0 ? row.plan_revision : null
        const failureId =
          seed.state === 'failed' ? `${row.id}:migration-failure` : null
        db.prepare(
          `INSERT INTO control_jobs
          (id, thread_id, project_id, draft_message_id, state, state_revision, control_intent, resume_target, current_plan_revision, execution_generation, active_run_id, last_failure_id, title, requirements_summary, created_at_ms, updated_at_ms, terminal_at_ms)
          VALUES (?, ?, ?, ?, ?, 1, 'none', ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?)`
        ).run(
          row.id,
          row.thread_id,
          row.project_id ?? '',
          row.draft_message_id,
          seed.state,
          seed.resumeTarget,
          currentPlanRevision,
          failureId,
          row.title || row.id,
          row.summary,
          row.created_at,
          row.updated_at,
          ['succeeded', 'failed', 'cancelled'].includes(seed.state)
            ? (row.terminal_at ?? row.updated_at)
            : null
        )
        if (seed.state === 'failed') {
          db.prepare(`INSERT INTO control_job_failures VALUES (?, ?, ?, 'recoverable', ?, ?, ?)`).run(
            `${row.id}:migration-failure`,
            row.id,
            'migration.interrupted',
            row.last_error ?? 'legacy active work interrupted by offline migration',
            row.status === 'planning' ? 'planning' : 'execution',
            row.updated_at
          )
        }
        copyChildren(db, row, row.plan_revision, row.updated_at)
      }
    })()

    const countsByTable = collectCountsByTable(db)
    const perJobProjectionHashes = collectPerJobProjectionHashes(db)
    const invariantSummary = runMigrationInvariantSummary(db)
    const report = buildMigrationCopyReport({
      generatedAtMs: Date.now(),
      sourceDatabaseIdentity,
      sourceUserVersion,
      sourceJobCount: rows.length,
      mappedCount: seeds.length,
      conflicts,
      countsByTable,
      countsByState,
      perJobProjectionHashes,
      invariantSummary,
      mapped: seeds.map((item) => item.seed),
      warnings
    })

    db.transaction(() => {
      db.prepare(
        `UPDATE control_schema_meta SET value = 'copied', copy_report_hash = ?, validation_summary_json = ?, updated_at_ms = ? WHERE key = 'control_schema_generation'`
      ).run(report.reportHash, JSON.stringify(report.invariantSummary), Date.now())
    })()

    return report
  } finally {
    db.close()
  }
}

export function cutoverDatabase(
  dbPath: string,
  report: MigrationCopyReport,
  backupId: string,
  options: { readonly expectedAppCommit?: string } = {}
): void {
  const db = new Database(dbPath, { fileMustExist: true })
  try {
    db.transaction(() => {
      assertCurrentMarker(db, 'copied')
      const liveIdentity = resolveLegacySourceIdentity(dbPath, db)
      if (liveIdentity.sha256 !== report.sourceDatabaseIdentity.sha256) {
        throw new Error('migration.database_identity_mismatch')
      }
      assertNoConflicts(report)
      const meta = db
        .prepare(
          `SELECT copy_report_hash FROM control_schema_meta WHERE key = 'control_schema_generation'`
        )
        .get() as { copy_report_hash: string | null }
      if (meta.copy_report_hash !== report.reportHash) {
        throw new Error('migration.report_hash_mismatch')
      }
      assertVerifiedBackup(db, report.sourceDatabaseIdentity, backupId)
      assertAllCountsMatch(db, report)
      assertProjectionHashesMatch(db, report)
      assertInvariantSweepEmpty(db)
      assertCutoverReleaseGate(db, options.expectedAppCommit ?? resolveAppCommit())
      db.prepare(
        `UPDATE control_schema_meta SET value = 'v3_authoritative', copy_report_hash = ?, backup_id = ?, validation_summary_json = ?, updated_at_ms = ? WHERE key = 'control_schema_generation'`
      ).run(report.reportHash, backupId, JSON.stringify(report.invariantSummary), Date.now())
    })()
  } finally {
    db.close()
  }
}

export async function restoreSqliteBackup(backupPath: string, targetPath: string, expectedSha256?: string): Promise<void> {
  if (!existsSync(backupPath)) {
    throw new Error(`migration.backup_missing: ${backupPath}`)
  }
  const actual = hashFile(backupPath)
  if (expectedSha256 && actual !== expectedSha256) {
    throw new Error(`migration.backup_hash_mismatch: expected=${expectedSha256} actual=${actual}`)
  }
  mkdirSync(dirname(targetPath), { recursive: true })
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true })
  try {
    await backup.backup(targetPath)
  } finally {
    backup.close()
  }
  const restored = new Database(targetPath, { readonly: true, fileMustExist: true })
  try {
    const integrityCheck = String(restored.pragma('integrity_check', { simple: true }) ?? '')
    const foreignKeyViolations = (restored.pragma('foreign_key_check') as unknown[]).length
    if (integrityCheck !== 'ok' || foreignKeyViolations !== 0) {
      throw new Error('migration.restore_validation_failed')
    }
  } finally {
    restored.close()
  }
}
