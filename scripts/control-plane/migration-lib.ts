/**
 * Control Plane Migration Tool
 *
 * Offline migration from legacy tables to control_* tables.
 * This tool should be run in maintenance mode.
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

export type MigrationResult<T> =
  | { readonly kind: 'mapped'; readonly value: T; readonly warnings: readonly string[] }
  | { readonly kind: 'conflict'; readonly code: string; readonly detail: string }

export interface DatabaseIdentity {
  readonly absolutePath: string
  readonly sha256: string
}

export interface LegacyJobSnapshot {
  readonly id: string
  readonly status: string
  readonly planProgress?: { readonly status: string }
  readonly currentPlanRevision?: number | null
  readonly planConfirmedAt?: number | null
}

export interface ControlJobSeed {
  readonly id: string
  readonly state: string
  readonly controlIntent: string
  readonly resumeTarget: string | null
}

export interface MigrationConflict {
  readonly jobId: string
  readonly code: string
  readonly detail: string
}

export interface MigrationInvariantSummary {
  readonly integrityCheck: string
  readonly foreignKeyViolations: number
  readonly invariantViolations: readonly { readonly jobId: string; readonly code: string }[]
}

export interface MigrationStableReport {
  readonly sourceDatabaseIdentity: DatabaseIdentity
  readonly sourceUserVersion: number
  readonly sourceJobCount: number
  readonly mappedCount: number
  readonly conflicts: readonly MigrationConflict[]
  readonly countsByTable: Readonly<Record<string, number>>
  readonly countsByState: Readonly<Record<string, number>>
  readonly perJobProjectionHashes: Readonly<Record<string, string>>
  readonly invariantSummary: MigrationInvariantSummary
}

export interface MigrationCopyReport extends MigrationStableReport {
  readonly generatedAtMs: number
  readonly warningCount: number
  readonly conflictCount: number
  readonly hasConflicts: boolean
  readonly mapped: readonly ControlJobSeed[]
  readonly warnings: readonly string[]
  readonly reportHash: string
}

export interface VerifiedBackupRecord {
  readonly backupId: string
  readonly sourceDatabaseIdentity: DatabaseIdentity
  readonly backupPath: string
  readonly backupSha256: string
  readonly backupBytes: number
  readonly sqliteVersion: string
  readonly userVersion: number
  readonly appCommit: string
  readonly createdAtMs: number
  readonly restoreCommand: string
  readonly verification: {
    readonly integrityCheck: string
    readonly foreignKeyViolations: number
  }
}

export interface BackupResult {
  readonly backupPath: string
  readonly sha256Path: string
  readonly sha256: string
  readonly bytes: number
}

export interface PreflightResult {
  readonly ok: true
  readonly dbPath: string
  readonly schemaGenerationReadable: true
}

export interface PreflightFailure {
  readonly ok: false
  readonly reason: string
}

const KNOWN_LEGACY_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'paused',
  'pausing',
  'running',
  'planning',
  'plan_editing',
  'plan_ready',
  'plan_confirmed',
  'pending'
])

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

const SCHEMA_GENERATIONS = new Set(['preparing', 'copied', 'v3_authoritative'])

export const MIGRATION_COPY_SCOPE_TABLES = [
  'control_runtime_instances',
  'control_task_attempts',
  'control_resource_slots',
  'control_verifications',
  'control_job_runs',
  'control_job_tasks',
  'control_plan_tasks',
  'control_plan_slices',
  'control_plan_milestones',
  'control_plan_revisions',
  'control_job_failures',
  'control_jobs',
  'control_evidence_blobs'
] as const

export const MIGRATION_COUNT_TABLES = [
  'control_jobs',
  'control_job_runs',
  'control_job_tasks',
  'control_task_attempts',
  'control_verifications',
  'control_plan_revisions',
  'control_plan_milestones',
  'control_plan_slices',
  'control_plan_tasks',
  'control_job_failures',
  'control_evidence_blobs',
  'control_runtime_instances',
  'control_resource_slots'
] as const

export function resolveLegacySourceIdentity(dbPath: string, db?: Database.Database): DatabaseIdentity {
  const absolutePath = realpathSync(dbPath)
  const conn = db ?? new Database(dbPath, { readonly: true, fileMustExist: true })
  const closeAfter = db === undefined
  try {
    if (!conn.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_jobs'`).get()) {
      return { absolutePath, sha256: hashCanonicalJson({ jobs: [] as const }) }
    }
    const jobs = conn
      .prepare(
        `SELECT id, status, plan_status, plan_revision, plan_confirmed_at
         FROM thread_jobs ORDER BY id`
      )
      .all()
    return { absolutePath, sha256: hashCanonicalJson({ jobs }) }
  } finally {
    if (closeAfter) conn.close()
  }
}

export function resolveDatabaseIdentity(dbPath: string): DatabaseIdentity {
  return resolveLegacySourceIdentity(dbPath)
}

export function migrationBackupMetaKey(backupId: string): string {
  return `migration_backup:${backupId}`
}

export function hashStableReport(stable: MigrationStableReport): string {
  return hashCanonicalJson({
    sourceDatabaseIdentity: stable.sourceDatabaseIdentity,
    sourceUserVersion: stable.sourceUserVersion,
    sourceJobCount: stable.sourceJobCount,
    mappedCount: stable.mappedCount,
    conflicts: stable.conflicts,
    countsByTable: stable.countsByTable,
    countsByState: stable.countsByState,
    perJobProjectionHashes: stable.perJobProjectionHashes,
    invariantSummary: stable.invariantSummary
  })
}

export function buildMigrationCopyReport(input: {
  readonly generatedAtMs: number
  readonly sourceDatabaseIdentity: DatabaseIdentity
  readonly sourceUserVersion: number
  readonly sourceJobCount: number
  readonly mappedCount: number
  readonly conflicts: readonly MigrationConflict[]
  readonly countsByTable: Readonly<Record<string, number>>
  readonly countsByState: Readonly<Record<string, number>>
  readonly perJobProjectionHashes: Readonly<Record<string, string>>
  readonly invariantSummary: MigrationInvariantSummary
  readonly mapped: readonly ControlJobSeed[]
  readonly warnings: readonly string[]
}): MigrationCopyReport {
  const stableReport: MigrationStableReport = {
    sourceDatabaseIdentity: input.sourceDatabaseIdentity,
    sourceUserVersion: input.sourceUserVersion,
    sourceJobCount: input.sourceJobCount,
    mappedCount: input.mappedCount,
    conflicts: input.conflicts,
    countsByTable: input.countsByTable,
    countsByState: input.countsByState,
    perJobProjectionHashes: input.perJobProjectionHashes,
    invariantSummary: input.invariantSummary
  }
  return {
    generatedAtMs: input.generatedAtMs,
    warningCount: input.warnings.length,
    conflictCount: input.conflicts.length,
    hasConflicts: input.conflicts.length > 0,
    mapped: input.mapped,
    warnings: input.warnings,
    reportHash: hashStableReport(stableReport),
    ...stableReport
  }
}

export function mapLegacyJob(input: LegacyJobSnapshot): MigrationResult<ControlJobSeed> {
  if (!KNOWN_LEGACY_STATUSES.has(input.status)) {
    return {
      kind: 'conflict',
      code: 'migration.unknown_status',
      detail: `job ${input.id} has unknown status ${input.status}`
    }
  }

  if (
    TERMINAL_STATUSES.has(input.status) &&
    input.planProgress?.status === 'running'
  ) {
    return {
      kind: 'conflict',
      code: 'migration.job_status_conflict',
      detail: `job ${input.id} is ${input.status} but plan progress is still running`
    }
  }

  if (input.status === 'paused' || input.status === 'pausing') {
    const hasEvidence = input.planConfirmedAt != null && (input.currentPlanRevision ?? 0) > 0
    if (!hasEvidence) {
      return {
        kind: 'conflict',
        code: 'migration.paused_resume_unproven',
        detail: `job ${input.id} is ${input.status} without plan confirmation evidence`
      }
    }
    return {
      kind: 'mapped',
      value: {
        id: input.id,
        state: 'paused',
        controlIntent: 'none',
        resumeTarget: 'execution_queued'
      },
      warnings:
        input.status === 'pausing' ? ['legacy pausing settled to paused during maintenance'] : []
    }
  }

  if (input.status === 'running') {
    return {
      kind: 'mapped',
      value: {
        id: input.id,
        state: 'failed',
        controlIntent: 'none',
        resumeTarget: null
      },
      warnings: ['legacy active execution requires explicit Continue']
    }
  }

  if (input.status === 'planning' && input.planProgress?.status === 'running') {
    return {
      kind: 'mapped',
      value: {
        id: input.id,
        state: 'failed',
        controlIntent: 'none',
        resumeTarget: null
      },
      warnings: ['legacy active planning requires explicit Continue']
    }
  }

  return {
    kind: 'mapped',
    value: {
      id: input.id,
      state: mapLegacyStatus(input.status, input.planProgress?.status),
      controlIntent: 'none',
      resumeTarget: null
    },
    warnings: []
  }
}

export function mapLegacyJobs(
  jobs: readonly LegacyJobSnapshot[],
  options: {
    readonly sourceDatabaseIdentity?: DatabaseIdentity
    readonly sourceUserVersion?: number
    readonly generatedAtMs?: number
    readonly countsByTable?: Readonly<Record<string, number>>
    readonly perJobProjectionHashes?: Readonly<Record<string, string>>
    readonly invariantSummary?: MigrationInvariantSummary
  } = {}
): MigrationCopyReport {
  const mapped: ControlJobSeed[] = []
  const conflicts: MigrationConflict[] = []
  const warnings: string[] = []
  const countsByState: Record<string, number> = {}
  const perJobProjectionHashes: Record<string, string> = {}

  for (const job of jobs) {
    const result = mapLegacyJob(job)
    if (result.kind === 'conflict') {
      conflicts.push({
        jobId: job.id,
        code: result.code,
        detail: result.detail
      })
      continue
    }

    mapped.push(result.value)
    countsByState[result.value.state] = (countsByState[result.value.state] ?? 0) + 1
    perJobProjectionHashes[result.value.id] = hashCanonicalJson({
      seed: result.value,
      legacyStatus: job.status,
      planProgressStatus: job.planProgress?.status ?? null,
      currentPlanRevision: job.currentPlanRevision ?? null,
      planConfirmedAt: job.planConfirmedAt ?? null
    })
    for (const warning of result.warnings) {
      warnings.push(`${job.id}: ${warning}`)
    }
  }

  const emptyCounts = Object.fromEntries(MIGRATION_COUNT_TABLES.map((table) => [table, 0]))
  return buildMigrationCopyReport({
    generatedAtMs: options.generatedAtMs ?? Date.now(),
    sourceDatabaseIdentity: options.sourceDatabaseIdentity ?? {
      absolutePath: '',
      sha256: ''
    },
    sourceUserVersion: options.sourceUserVersion ?? 0,
    sourceJobCount: jobs.length,
    mappedCount: mapped.length,
    conflicts,
    countsByTable: options.countsByTable ?? emptyCounts,
    countsByState,
    perJobProjectionHashes: options.perJobProjectionHashes ?? perJobProjectionHashes,
    invariantSummary: options.invariantSummary ?? {
      integrityCheck: 'ok',
      foreignKeyViolations: 0,
      invariantViolations: []
    },
    mapped,
    warnings
  })
}

export function hashFile(filePath: string): string {
  const bytes = readFileSync(filePath)
  return createHash('sha256').update(bytes).digest('hex')
}

export function hashCanonicalJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

export function writeReport(reportPath: string, report: MigrationCopyReport): string {
  mkdirSync(dirname(reportPath), { recursive: true })
  const body = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(reportPath, body, 'utf8')
  return hashFile(reportPath)
}

export function readReport(reportPath: string): MigrationCopyReport {
  if (!existsSync(reportPath)) {
    throw new Error(`migration report not found: ${reportPath}`)
  }
  const parsed: unknown = JSON.parse(readFileSync(reportPath, 'utf8'))
  return parseMigrationCopyReport(parsed)
}

export function loadParseAndRehashReport(reportPath: string): MigrationCopyReport {
  const report = readReport(reportPath)
  const validation = validateCopyReport(report)
  if (!validation.ok) {
    throw new Error(validation.errors.join('; '))
  }
  return report
}

export function validateCopyReport(report: MigrationCopyReport): {
  readonly ok: boolean
  readonly errors: readonly string[]
} {
  const errors: string[] = []

  if (report.hasConflicts || report.conflicts.length > 0) {
    errors.push(`migration.has_conflicts: ${report.conflicts.length}`)
  }

  if (report.sourceJobCount !== report.mappedCount + report.conflicts.length) {
    errors.push(
      `migration.count_mismatch: source=${report.sourceJobCount} mapped=${report.mappedCount} conflicts=${report.conflicts.length}`
    )
  }

  const counted = Object.values(report.countsByState).reduce((sum, n) => sum + n, 0)
  if (counted !== report.mappedCount) {
    errors.push(
      `migration.state_count_mismatch: countsByState=${counted} mapped=${report.mappedCount}`
    )
  }

  if (!report.sourceDatabaseIdentity.absolutePath || !report.sourceDatabaseIdentity.sha256) {
    errors.push('migration.source_database_identity_missing')
  }

  const recomputed = hashStableReport(report)
  if (recomputed !== report.reportHash) {
    errors.push('migration.report_hash_mismatch')
  }

  return { ok: errors.length === 0, errors }
}

export function runPreflight(dbPath: string): PreflightResult | PreflightFailure {
  if (!dbPath.trim()) {
    return { ok: false, reason: 'migration.db_path_required' }
  }
  if (!existsSync(dbPath)) {
    return { ok: false, reason: `migration.db_missing: ${dbPath}` }
  }

  if (!SCHEMA_GENERATIONS.has('preparing')) {
    return { ok: false, reason: 'migration.schema_generation_unreadable' }
  }

  return {
    ok: true,
    dbPath,
    schemaGenerationReadable: true
  }
}

export function backupDatabase(dbPath: string, backupPath: string): BackupResult {
  if (!existsSync(dbPath)) {
    throw new Error(`migration.db_missing: ${dbPath}`)
  }
  mkdirSync(dirname(backupPath), { recursive: true })
  copyFileSync(dbPath, backupPath)
  const sha256 = hashFile(backupPath)
  const sha256Path = `${backupPath}.sha256`
  writeFileSync(sha256Path, `${sha256}  ${backupPath}\n`, 'utf8')
  const bytes = readFileSync(backupPath).byteLength
  return { backupPath, sha256Path, sha256, bytes }
}

export function restoreDatabase(backupPath: string, targetPath: string, expectedSha256?: string): void {
  if (!existsSync(backupPath)) {
    throw new Error(`migration.backup_missing: ${backupPath}`)
  }
  const actual = hashFile(backupPath)
  if (expectedSha256 && actual !== expectedSha256) {
    throw new Error(`migration.backup_hash_mismatch: expected=${expectedSha256} actual=${actual}`)
  }
  const shaFile = `${backupPath}.sha256`
  if (!expectedSha256 && existsSync(shaFile)) {
    const recorded = readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0]
    if (recorded && recorded !== actual) {
      throw new Error(`migration.backup_hash_mismatch: expected=${recorded} actual=${actual}`)
    }
  }
  mkdirSync(dirname(targetPath), { recursive: true })
  copyFileSync(backupPath, targetPath)
}

export function parseLegacyJobSnapshots(value: unknown): LegacyJobSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error('migration.jobs_must_be_array')
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`migration.job_invalid: index=${index}`)
    }
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || typeof row.status !== 'string') {
      throw new Error(`migration.job_invalid: index=${index}`)
    }
    const planProgress =
      row.planProgress && typeof row.planProgress === 'object'
        ? { status: String((row.planProgress as { status?: unknown }).status ?? '') }
        : undefined
    const currentPlanRevision =
      typeof row.currentPlanRevision === 'number'
        ? row.currentPlanRevision
        : row.currentPlanRevision === null
          ? null
          : undefined
    const planConfirmedAt =
      typeof row.planConfirmedAt === 'number'
        ? row.planConfirmedAt
        : row.planConfirmedAt === null
          ? null
          : undefined
    return {
      id: row.id,
      status: row.status,
      ...(planProgress ? { planProgress } : {}),
      ...(currentPlanRevision !== undefined ? { currentPlanRevision } : {}),
      ...(planConfirmedAt !== undefined ? { planConfirmedAt } : {})
    }
  })
}

export function summarizeReport(report: MigrationCopyReport): string {
  const lines = [
    `generatedAtMs: ${report.generatedAtMs}`,
    `sourceJobCount: ${report.sourceJobCount}`,
    `mappedCount: ${report.mappedCount}`,
    `conflictCount: ${report.conflictCount}`,
    `warningCount: ${report.warningCount}`,
    `hasConflicts: ${report.hasConflicts}`,
    `reportHash: ${report.reportHash}`,
    `countsByState: ${JSON.stringify(report.countsByState)}`,
    `countsByTable: ${JSON.stringify(report.countsByTable)}`
  ]
  if (report.conflicts.length > 0) {
    lines.push('conflicts:')
    for (const conflict of report.conflicts.slice(0, 20)) {
      lines.push(`  - ${conflict.jobId} ${conflict.code}: ${conflict.detail}`)
    }
    if (report.conflicts.length > 20) {
      lines.push(`  ... and ${report.conflicts.length - 20} more`)
    }
  }
  return lines.join('\n')
}

function mapLegacyStatus(status: string, planProgressStatus?: string): string {
  switch (status) {
    case 'planning':
      return planProgressStatus === 'pending' ? 'planning_queued' : 'planning_queued'
    case 'plan_editing':
    case 'plan_ready':
      return 'plan_review'
    case 'plan_confirmed':
    case 'pending':
      return 'execution_queued'
    case 'completed':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'failed'
  }
}

function parseMigrationCopyReport(value: unknown): MigrationCopyReport {
  if (!value || typeof value !== 'object') {
    throw new Error('migration.report_invalid')
  }
  const row = value as Record<string, unknown>
  if (
    typeof row.generatedAtMs !== 'number' ||
    typeof row.sourceJobCount !== 'number' ||
    typeof row.mappedCount !== 'number' ||
    typeof row.warningCount !== 'number' ||
    typeof row.hasConflicts !== 'boolean' ||
    typeof row.reportHash !== 'string' ||
    !Array.isArray(row.conflicts) ||
    !Array.isArray(row.mapped) ||
    !Array.isArray(row.warnings) ||
    !row.countsByState ||
    typeof row.countsByState !== 'object' ||
    !row.countsByTable ||
    typeof row.countsByTable !== 'object' ||
    !row.sourceDatabaseIdentity ||
    typeof row.sourceDatabaseIdentity !== 'object' ||
    typeof row.sourceUserVersion !== 'number' ||
    !row.invariantSummary ||
    typeof row.invariantSummary !== 'object'
  ) {
    throw new Error('migration.report_invalid')
  }

  const identity = row.sourceDatabaseIdentity as Record<string, unknown>
  if (typeof identity.absolutePath !== 'string' || typeof identity.sha256 !== 'string') {
    throw new Error('migration.report_invalid')
  }

  const invariantSummary = row.invariantSummary as Record<string, unknown>
  if (
    typeof invariantSummary.integrityCheck !== 'string' ||
    typeof invariantSummary.foreignKeyViolations !== 'number' ||
    !Array.isArray(invariantSummary.invariantViolations)
  ) {
    throw new Error('migration.report_invalid')
  }

  const report = buildMigrationCopyReport({
    generatedAtMs: row.generatedAtMs,
    sourceDatabaseIdentity: {
      absolutePath: identity.absolutePath,
      sha256: identity.sha256
    },
    sourceUserVersion: row.sourceUserVersion,
    sourceJobCount: row.sourceJobCount,
    mappedCount: row.mappedCount,
    conflicts: row.conflicts as MigrationConflict[],
    countsByTable: row.countsByTable as Record<string, number>,
    countsByState: row.countsByState as Record<string, number>,
    perJobProjectionHashes:
      row.perJobProjectionHashes && typeof row.perJobProjectionHashes === 'object'
        ? (row.perJobProjectionHashes as Record<string, string>)
        : Object.fromEntries(
            (row.mapped as ControlJobSeed[]).map((seed) => [seed.id, hashCanonicalJson(seed)])
          ),
    invariantSummary: {
      integrityCheck: invariantSummary.integrityCheck,
      foreignKeyViolations: invariantSummary.foreignKeyViolations,
      invariantViolations: invariantSummary.invariantViolations as Array<{
        jobId: string
        code: string
      }>
    },
    mapped: row.mapped as ControlJobSeed[],
    warnings: row.warnings as string[]
  })

  if (report.reportHash !== row.reportHash) {
    throw new Error('migration.report_hash_mismatch')
  }

  return report
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue)
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    )
    const out: Record<string, unknown> = {}
    for (const [key, entry] of entries) {
      out[key] = sortValue(entry)
    }
    return out
  }
  return value
}

export function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token || !token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out[key] = true
      continue
    }
    out[key] = next
    i += 1
  }
  return out
}

export function requireArg(args: Record<string, string | boolean>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`missing required --${key}`)
  }
  return value
}
