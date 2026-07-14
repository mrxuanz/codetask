import type Database from 'better-sqlite3'
import { resolveAppCommit } from './app-commit'

export const CUTOVER_RELEASE_GATE_KEY = 'cutover_release_gate' as const

export interface CutoverReleaseGateRecord {
  readonly appCommit: string
  readonly verificationSummary: Record<string, unknown>
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)
  )
}

function parseVerificationSummary(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw?.trim()) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return null
  }
  return null
}

export function readCutoverReleaseGate(db: Database.Database): CutoverReleaseGateRecord | null {
  if (!tableExists(db, 'control_schema_meta')) return null
  const row = db
    .prepare(
      `SELECT value, validation_summary_json
       FROM control_schema_meta
       WHERE key = ?`
    )
    .get(CUTOVER_RELEASE_GATE_KEY) as { value: string; validation_summary_json: string | null } | undefined
  if (!row?.value?.trim()) return null
  const verificationSummary = parseVerificationSummary(row.validation_summary_json)
  if (verificationSummary === null) return null
  return {
    appCommit: row.value.trim(),
    verificationSummary
  }
}

export function assertCutoverReleaseGate(
  db: Database.Database,
  expectedCommit: string = resolveAppCommit()
): CutoverReleaseGateRecord {
  const gate = readCutoverReleaseGate(db)
  if (gate === null) {
    throw new Error('migration.release_gate_missing')
  }
  if (gate.appCommit !== expectedCommit) {
    throw new Error('migration.release_gate_commit_mismatch')
  }
  if (Object.keys(gate.verificationSummary).length === 0) {
    throw new Error('migration.release_gate_summary_missing')
  }
  return gate
}

/** Test/CR8 helper — writes a release gate row bound to app commit + verification summary. */
export function writeCutoverReleaseGate(
  db: Database.Database,
  record: CutoverReleaseGateRecord,
  updatedAtMs: number = Date.now()
): void {
  if (!tableExists(db, 'control_schema_meta')) {
    throw new Error('migration.release_gate_table_missing')
  }
  db.prepare(
    `INSERT INTO control_schema_meta (key, value, source_migration, validation_summary_json, updated_at_ms)
     VALUES (?, ?, 27, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       validation_summary_json = excluded.validation_summary_json,
       updated_at_ms = excluded.updated_at_ms`
  ).run(
    CUTOVER_RELEASE_GATE_KEY,
    record.appCommit,
    JSON.stringify(record.verificationSummary),
    updatedAtMs
  )
}
