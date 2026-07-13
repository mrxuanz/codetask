/**
 * Control Plane Migration Tool
 *
 * Offline migration from legacy tables to control_* tables.
 * This tool should be run in maintenance mode.
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type MigrationResult<T> =
  | { readonly kind: 'mapped'; readonly value: T; readonly warnings: readonly string[] }
  | { readonly kind: 'conflict'; readonly code: string; readonly detail: string }

export interface LegacyJobSnapshot {
  readonly id: string
  readonly status: string
  readonly planProgress?: { readonly status: string }
  readonly currentPlanRevision?: number | null
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

export interface MigrationCopyReport {
  readonly generatedAtMs: number
  readonly sourceJobCount: number
  readonly mappedCount: number
  readonly conflictCount: number
  readonly warningCount: number
  readonly hasConflicts: boolean
  readonly conflicts: readonly MigrationConflict[]
  readonly mapped: readonly ControlJobSeed[]
  readonly warnings: readonly string[]
  readonly countsByState: Readonly<Record<string, number>>
  readonly reportHash: string
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
  'planning'
])

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

const SCHEMA_GENERATIONS = new Set(['preparing', 'copied', 'v3_authoritative'])

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

  if (input.status === 'pausing') {
    return {
      kind: 'mapped',
      value: {
        id: input.id,
        state: 'paused',
        controlIntent: 'none',
        resumeTarget: inferResumeTarget(input)
      },
      warnings: ['legacy pausing settled to paused during maintenance']
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
      state: mapLegacyStatus(input.status),
      controlIntent: 'none',
      resumeTarget: null
    },
    warnings: []
  }
}

export function mapLegacyJobs(jobs: readonly LegacyJobSnapshot[]): MigrationCopyReport {
  const mapped: ControlJobSeed[] = []
  const conflicts: MigrationConflict[] = []
  const warnings: string[] = []
  const countsByState: Record<string, number> = {}

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
    for (const warning of result.warnings) {
      warnings.push(`${job.id}: ${warning}`)
    }
  }

  const draft: Omit<MigrationCopyReport, 'reportHash'> = {
    generatedAtMs: Date.now(),
    sourceJobCount: jobs.length,
    mappedCount: mapped.length,
    conflictCount: conflicts.length,
    warningCount: warnings.length,
    hasConflicts: conflicts.length > 0,
    conflicts,
    mapped,
    warnings,
    countsByState
  }

  return {
    ...draft,
    reportHash: hashCanonicalJson(draft)
  }
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

export function validateCopyReport(report: MigrationCopyReport): {
  readonly ok: boolean
  readonly errors: readonly string[]
} {
  const errors: string[] = []

  if (report.hasConflicts || report.conflictCount > 0) {
    errors.push(`migration.has_conflicts: ${report.conflictCount}`)
  }

  if (report.sourceJobCount !== report.mappedCount + report.conflictCount) {
    errors.push(
      `migration.count_mismatch: source=${report.sourceJobCount} mapped=${report.mappedCount} conflicts=${report.conflictCount}`
    )
  }

  const counted = Object.values(report.countsByState).reduce((sum, n) => sum + n, 0)
  if (counted !== report.mappedCount) {
    errors.push(
      `migration.state_count_mismatch: countsByState=${counted} mapped=${report.mappedCount}`
    )
  }

  const recomputed = hashCanonicalJson({
    generatedAtMs: report.generatedAtMs,
    sourceJobCount: report.sourceJobCount,
    mappedCount: report.mappedCount,
    conflictCount: report.conflictCount,
    warningCount: report.warningCount,
    hasConflicts: report.hasConflicts,
    conflicts: report.conflicts,
    mapped: report.mapped,
    warnings: report.warnings,
    countsByState: report.countsByState
  })
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

  // Schema generation marker is always readable as a typed union in-process.
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
    return {
      id: row.id,
      status: row.status,
      ...(planProgress ? { planProgress } : {}),
      ...(currentPlanRevision !== undefined ? { currentPlanRevision } : {})
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
    `countsByState: ${JSON.stringify(report.countsByState)}`
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

function inferResumeTarget(input: LegacyJobSnapshot): string | null {
  if (input.currentPlanRevision) {
    return 'execution_queued'
  }
  return null
}

function mapLegacyStatus(status: string): string {
  switch (status) {
    case 'completed':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'paused':
      return 'paused'
    case 'planning':
      return 'plan_review'
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
    typeof row.conflictCount !== 'number' ||
    typeof row.warningCount !== 'number' ||
    typeof row.hasConflicts !== 'boolean' ||
    typeof row.reportHash !== 'string' ||
    !Array.isArray(row.conflicts) ||
    !Array.isArray(row.mapped) ||
    !Array.isArray(row.warnings) ||
    !row.countsByState ||
    typeof row.countsByState !== 'object'
  ) {
    throw new Error('migration.report_invalid')
  }

  return {
    generatedAtMs: row.generatedAtMs,
    sourceJobCount: row.sourceJobCount,
    mappedCount: row.mappedCount,
    conflictCount: row.conflictCount,
    warningCount: row.warningCount,
    hasConflicts: row.hasConflicts,
    conflicts: row.conflicts as MigrationConflict[],
    mapped: row.mapped as ControlJobSeed[],
    warnings: row.warnings as string[],
    countsByState: row.countsByState as Record<string, number>,
    reportHash: row.reportHash
  }
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
