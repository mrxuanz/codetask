import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { hashCanonicalJson, hashFile, mapLegacyJobs, type MigrationCopyReport } from './migration-lib'

type Sqlite = Database.Database
type Row = Record<string, unknown>

export interface MigrationPreflightOptions {
  readonly maintenanceMode?: boolean
  readonly schedulerStopped?: boolean
  readonly runtimeStopped?: boolean
  readonly activeChildren?: number
  readonly requiredUserVersion?: number
}

export interface DatabasePreflightResult {
  readonly ok: boolean
  readonly reason?: string
  readonly dbPath: string
  readonly userVersion?: number
  readonly schemaGeneration?: string
  readonly integrityCheck?: string
  readonly foreignKeyViolations?: number
  readonly activeChildren?: number
  readonly freeBytes?: number
}

export interface SqliteBackupResult {
  readonly backupId: string
  readonly backupPath: string
  readonly sha256Path: string
  readonly sha256: string
  readonly bytes: number
  readonly sqliteVersion: string
  readonly userVersion: number
  readonly appCommit: string
  readonly restoreCommand: string
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
  // SQLite's backup needs at least one source-sized allocation in the target filesystem.
  // Node does not expose a portable free-space API; statfs is available on supported Node builds.
  const statfs = statfsSync(dirname(dbPath))
  return Number(statfs.bavail) * Number(statfs.bsize)
}

export function runDatabasePreflight(
  dbPath: string,
  options: MigrationPreflightOptions = {}
): DatabasePreflightResult {
  if (!dbPath.trim() || !existsSync(dbPath)) {
    return { ok: false, reason: 'migration.db_missing', dbPath }
  }
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

    if (integrityCheck !== 'ok') return { ok: false, reason: 'migration.integrity_check_failed', dbPath, integrityCheck }
    if (foreignKeyViolations !== 0) return { ok: false, reason: 'migration.foreign_key_check_failed', dbPath, foreignKeyViolations }
    if (schemaGeneration !== 'preparing') return { ok: false, reason: 'migration.marker_not_preparing', dbPath, schemaGeneration: schemaGeneration ?? undefined }
    if (!maintenanceMode) return { ok: false, reason: 'migration.maintenance_mode_required', dbPath }
    if (!schedulerStopped || !runtimeStopped || activeChildren !== (options.activeChildren ?? 0)) {
      return { ok: false, reason: 'migration.runtime_not_stopped', dbPath, activeChildren }
    }
    if (options.requiredUserVersion !== undefined && userVersion !== options.requiredUserVersion) {
      return { ok: false, reason: 'migration.user_version_mismatch', dbPath, userVersion }
    }
    if (freeBytes < statSync(dbPath).size) return { ok: false, reason: 'migration.insufficient_disk_space', dbPath, freeBytes }
    return { ok: true, dbPath, userVersion, schemaGeneration, integrityCheck, foreignKeyViolations, activeChildren, freeBytes }
  } finally {
    db.close()
  }
}

export async function backupSqliteDatabase(dbPath: string, backupPath: string): Promise<SqliteBackupResult> {
  if (!existsSync(dbPath)) throw new Error(`migration.db_missing: ${dbPath}`)
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
  try {
    const integrity = String(backup.pragma('integrity_check', { simple: true }) ?? '')
    const foreignKeys = backup.pragma('foreign_key_check') as unknown[]
    if (integrity !== 'ok' || foreignKeys.length !== 0) throw new Error('migration.backup_validation_failed')
    sqliteVersion = (backup.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version
    userVersion = Number(backup.pragma('user_version', { simple: true }) ?? 0)
  } finally {
    backup.close()
  }
  const sha256 = hashFile(backupPath)
  const sha256Path = `${backupPath}.sha256`
  writeFileSync(sha256Path, `${sha256}  ${backupPath}\n`, 'utf8')
  return {
    backupId: randomUUID(),
    backupPath,
    sha256Path,
    sha256,
    bytes: statSync(backupPath).size,
    sqliteVersion,
    userVersion,
    appCommit: process.env.GIT_COMMIT ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown',
    restoreCommand: `node --import tsx scripts/control-plane/restore.ts --backup "${backupPath}" --target "${dbPath}" --sha256 ${sha256}`
  }
}

interface LegacyJobRow {
  id: string; thread_id: string; project_id: string | null; draft_message_id: string; title: string; summary: string
  status: string; plan_status: string; plan_revision: number; plan_confirmed_at: number | null; last_error: string | null
  created_at: number; updated_at: number; terminal_at: number | null
}

function projectionHash(row: LegacyJobRow): string {
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
  db.prepare(`INSERT OR IGNORE INTO control_evidence_blobs (hash, content_json, bytes, created_at_ms) VALUES (?, ?, ?, ?)`)
    .run(hash, content, Buffer.byteLength(content), now)
  return hash
}

function copyChildren(db: Sqlite, row: LegacyJobRow, planRevision: number, now: number): void {
  if (planRevision > 0 && tableExists(db, 'job_plan_tasks')) {
    db.prepare(`INSERT OR IGNORE INTO control_plan_revisions (id, job_id, plan_revision, status, content_hash, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`${row.id}:plan:${planRevision}`, row.id, planRevision, row.plan_confirmed_at ? 'confirmed' : 'draft', projectionHash(row), now)
    const milestones = tableExists(db, 'job_plan_milestones')
      ? db.prepare(`SELECT milestone_index, title, sort_order FROM job_plan_milestones WHERE job_id = ?`).all(row.id) as Row[] : []
    const slices = tableExists(db, 'job_plan_slices')
      ? db.prepare(`SELECT milestone_index, slice_index, title, sort_order FROM job_plan_slices WHERE job_id = ?`).all(row.id) as Row[] : []
    const planTasks = db.prepare(`SELECT task_id, ability_code, core_code FROM job_plan_tasks WHERE job_id = ?`).all(row.id) as Row[]
    for (const item of milestones) db.prepare(`INSERT OR IGNORE INTO control_plan_milestones VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(`${row.id}:milestone:${item.milestone_index}`, row.id, planRevision, String(item.milestone_index), String(item.title ?? ''), Number(item.sort_order), now)
    for (const item of slices) db.prepare(`INSERT OR IGNORE INTO control_plan_slices VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`${row.id}:slice:${item.milestone_index}:${item.slice_index}`, row.id, planRevision, String(item.milestone_index), `${item.milestone_index}:${item.slice_index}`, String(item.title ?? ''), Number(item.sort_order), now)
    for (const item of planTasks) db.prepare(`INSERT OR IGNORE INTO control_plan_tasks VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(`${row.id}:plan-task:${String(item.task_id)}`, row.id, planRevision, String(item.task_id), item.ability_code ?? null, item.core_code ?? null, now)
  }
  if (!tableExists(db, 'job_tasks')) return
  const tasks = db.prepare(`SELECT task_id, title, sort_order, status, ability_code, core_code, error_message FROM job_tasks WHERE job_id = ?`).all(row.id) as Row[]
  for (const task of tasks) {
    const taskId = String(task.task_id)
    const state = ['completed', 'failed', 'running'].includes(String(task.status)) ? String(task.status).replace('completed', 'completed') : 'queued'
    db.prepare(`INSERT OR IGNORE INTO control_job_tasks VALUES (?, 0, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`)
      .run(row.id, taskId, Math.max(1, planRevision), state === 'running' ? 'failed' : state, Number(task.sort_order), String(task.title), task.ability_code ?? null, task.core_code ?? null, now, now)
    if (task.error_message || state === 'failed') {
      const failureId = `${row.id}:task:${taskId}:failure`
      db.prepare(`INSERT OR IGNORE INTO control_job_failures VALUES (?, ?, ?, 'recoverable', ?, 'execution', ?)`)
        .run(failureId, row.id, 'migration.legacy_task_failure', task.error_message ?? 'legacy task failed', now)
    }
  }
  if (tableExists(db, 'job_artifacts')) {
    const artifacts = db.prepare(`SELECT content_hash, content_inline, kind FROM job_artifacts WHERE job_id = ?`).all(row.id) as Row[]
    for (const artifact of artifacts) insertEvidence(db, String(artifact.content_inline ?? JSON.stringify({ hash: artifact.content_hash, kind: artifact.kind })), now)
  }
}

export function copyLegacyDatabase(dbPath: string): MigrationCopyReport {
  const db = new Database(dbPath, { fileMustExist: true })
  db.pragma('foreign_keys = ON')
  try {
    const rows = legacyJobs(db)
    const report = mapLegacyJobs(rows.map((row) => ({
      id: row.id, status: row.status, planProgress: { status: row.plan_status },
      currentPlanRevision: row.plan_revision > 0 ? row.plan_revision : null, planConfirmedAt: row.plan_confirmed_at
    })))
    if (report.hasConflicts) return report
    db.transaction(() => {
      const marker = metadataValue(db, 'control_schema_generation')
      if (marker !== 'preparing' && marker !== 'copied') throw new Error('migration.marker_not_preparing')
      for (const row of rows) {
        const seed = report.mapped.find((item) => item.id === row.id)
        if (!seed) continue
        const currentPlanRevision = row.plan_confirmed_at && row.plan_revision > 0 ? row.plan_revision : null
        db.prepare(`INSERT OR REPLACE INTO control_jobs
          (id, thread_id, project_id, draft_message_id, state, state_revision, control_intent, resume_target, current_plan_revision, execution_generation, active_run_id, last_failure_id, title, requirements_summary, created_at_ms, updated_at_ms, terminal_at_ms)
          VALUES (?, ?, ?, ?, ?, 1, 'none', ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?)`)
          .run(row.id, row.thread_id, row.project_id ?? '', row.draft_message_id, seed.state, seed.resumeTarget, currentPlanRevision,
            seed.state === 'failed' ? `${row.id}:migration-failure` : null, row.title || row.id, row.summary, row.created_at, row.updated_at, ['succeeded', 'failed', 'cancelled'].includes(seed.state) ? (row.terminal_at ?? row.updated_at) : null)
        if (seed.state === 'failed') db.prepare(`INSERT OR IGNORE INTO control_job_failures VALUES (?, ?, ?, 'recoverable', ?, ?, ?)`)
          .run(`${row.id}:migration-failure`, row.id, 'migration.interrupted', row.last_error ?? 'legacy active work interrupted by offline migration', row.status === 'planning' ? 'planning' : 'execution', row.updated_at)
        copyChildren(db, row, row.plan_revision, row.updated_at)
      }
      const summary = JSON.stringify({ sourceJobCount: report.sourceJobCount, mappedCount: report.mappedCount, conflictCount: report.conflictCount, countsByState: report.countsByState })
      db.prepare(`UPDATE control_schema_meta SET value = 'copied', copy_report_hash = ?, validation_summary_json = ?, updated_at_ms = ? WHERE key = 'control_schema_generation'`)
        .run(report.reportHash, summary, Date.now())
    })()
    return report
  } finally {
    db.close()
  }
}

export function cutoverDatabase(dbPath: string, report: MigrationCopyReport, backupId: string): void {
  const db = new Database(dbPath, { fileMustExist: true })
  try {
    db.transaction(() => {
      const marker = metadataValue(db, 'control_schema_generation')
      if (marker !== 'copied') throw new Error('migration.marker_not_copied')
      const storedHash = metadataValue(db, 'control_schema_generation') // marker row checked below with full data
      const meta = db.prepare(`SELECT copy_report_hash FROM control_schema_meta WHERE key = 'control_schema_generation'`).get() as { copy_report_hash: string | null }
      if (meta.copy_report_hash !== report.reportHash || !storedHash) throw new Error('migration.report_hash_mismatch')
      if (report.hasConflicts || report.conflictCount !== 0) throw new Error('migration.has_conflicts')
      const count = (db.prepare(`SELECT COUNT(*) AS count FROM control_jobs`).get() as { count: number }).count
      if (count !== report.mappedCount) throw new Error('migration.count_mismatch')
      const violations = db.pragma('foreign_key_check') as unknown[]
      if (violations.length !== 0) throw new Error('migration.invariant_sweep_failed')
      db.prepare(`UPDATE control_schema_meta SET value = 'v3_authoritative', copy_report_hash = ?, backup_id = ?, validation_summary_json = ?, updated_at_ms = ? WHERE key = 'control_schema_generation'`)
        .run(report.reportHash, backupId, JSON.stringify({ validated: true, controlJobCount: count }), Date.now())
    })()
  } finally {
    db.close()
  }
}
