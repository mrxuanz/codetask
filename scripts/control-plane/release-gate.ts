import type Database from 'better-sqlite3'
import { resolveAppCommit } from './app-commit'

export const CUTOVER_RELEASE_GATE_KEY = 'cutover_release_gate' as const

/** CR0-CR7 correspond to the v4 corrective-plan verification stages. */
export const CR_STAGES = ['CR0', 'CR1', 'CR2', 'CR3', 'CR4', 'CR5', 'CR6', 'CR7'] as const
export type CrStage = (typeof CR_STAGES)[number]

export type CrStageStatus = 'complete' | 'failed' | 'skipped'

/** Evidence for a single executed command backing a CR stage's status. */
export interface CrCommandEvidence {
  readonly command: string
  readonly exitCode: number
  readonly startedAtMs: number
  readonly endedAtMs: number
  readonly logHash: string
  readonly commit: string
}

export interface CrStageEvidence {
  readonly status: CrStageStatus
  readonly commands: readonly CrCommandEvidence[]
}

export interface CrVerificationValidation {
  readonly ok: boolean
  readonly errors: readonly string[]
}

export interface CutoverReleaseGateRecord {
  readonly appCommit: string
  readonly verificationSummary: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateCommandEvidence(
  stage: string,
  index: number,
  value: unknown,
  expectedCommit: string,
  errors: string[]
): void {
  if (!isRecord(value)) {
    errors.push(`migration.release_gate_command_invalid: ${stage}[${index}]`)
    return
  }
  if (typeof value.command !== 'string' || !value.command.trim()) {
    errors.push(`migration.release_gate_command_missing_name: ${stage}[${index}]`)
  }
  if (typeof value.exitCode !== 'number' || !Number.isInteger(value.exitCode)) {
    errors.push(`migration.release_gate_command_missing_exit_code: ${stage}[${index}]`)
  } else if (value.exitCode !== 0) {
    errors.push(`migration.release_gate_command_failed: ${stage}[${index}]`)
  }
  if (
    typeof value.startedAtMs !== 'number' ||
    typeof value.endedAtMs !== 'number' ||
    value.endedAtMs < value.startedAtMs
  ) {
    errors.push(`migration.release_gate_command_missing_timing: ${stage}[${index}]`)
  }
  if (typeof value.logHash !== 'string' || !value.logHash.trim()) {
    errors.push(`migration.release_gate_command_missing_log_hash: ${stage}[${index}]`)
  }
  if (typeof value.commit !== 'string' || !value.commit.trim()) {
    errors.push(`migration.release_gate_command_missing_commit: ${stage}[${index}]`)
  } else if (value.commit !== expectedCommit) {
    errors.push(`migration.release_gate_command_commit_mismatch: ${stage}[${index}]`)
  }
}

/**
 * Validates that a persisted CR verification summary carries real executed-command
 * evidence for every CR0-CR7 stage, and that every stage is actually complete.
 * This is the guard against self-certified/auto-generated "complete" gates.
 */
export function validateCrVerificationSummary(
  summary: Record<string, unknown>,
  expectedCommit: string
): CrVerificationValidation {
  const errors: string[] = []
  const stagesValue = summary.stages
  if (!isRecord(stagesValue)) {
    return { ok: false, errors: ['migration.release_gate_stages_missing'] }
  }
  for (const stage of CR_STAGES) {
    const entry = stagesValue[stage]
    if (!isRecord(entry)) {
      errors.push(`migration.release_gate_stage_missing: ${stage}`)
      continue
    }
    const commands = entry.commands
    if (!Array.isArray(commands) || commands.length === 0) {
      errors.push(`migration.release_gate_stage_no_evidence: ${stage}`)
      continue
    }
    commands.forEach((command, index) =>
      validateCommandEvidence(stage, index, command, expectedCommit, errors)
    )
    if (entry.status !== 'complete') {
      errors.push(`migration.release_gate_stage_not_complete: ${stage}`)
    }
  }
  return { ok: errors.length === 0, errors }
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
    .get(CUTOVER_RELEASE_GATE_KEY) as
    | { value: string; validation_summary_json: string | null }
    | undefined
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
  const validation = validateCrVerificationSummary(gate.verificationSummary, expectedCommit)
  if (!validation.ok) {
    throw new Error(`migration.release_gate_evidence_invalid: ${validation.errors.join('; ')}`)
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
