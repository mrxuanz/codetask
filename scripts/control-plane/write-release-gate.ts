#!/usr/bin/env node
/**
 * CR8: Write cutover_release_gate bound to current app commit + CR0–CR7 verification summary.
 *
 * The verification summary is never self-generated. Callers must supply real executed-command
 * evidence per CR stage via --summary (exit code, log hash, commit, start/end times); the gate
 * is derived from that evidence and rejected outright if any command failed, is missing, or was
 * run against a different commit than the one being released.
 *
 * Usage:
 *   node --import tsx scripts/control-plane/write-release-gate.ts --db <app.db> --summary <evidence.json>
 *
 * <evidence.json> shape:
 *   {
 *     "stages": {
 *       "CR0": { "commands": [{ "command": "...", "exitCode": 0, "startedAtMs": 0, "endedAtMs": 1, "logHash": "...", "commit": "..." }] },
 *       "CR1": { "commands": [...] },
 *       ...
 *       "CR7": { "commands": [...] }
 *     }
 *   }
 */

import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { resolveAppCommit } from './app-commit'
import { parseArgs, requireArg } from './migration-lib'
import {
  CR_STAGES,
  validateCrVerificationSummary,
  writeCutoverReleaseGate,
  type CrCommandEvidence,
  type CrStage,
  type CrStageStatus
} from './release-gate'

export { CR_STAGES }

export interface CrStageEvidenceInput {
  readonly commands: readonly CrCommandEvidence[]
}

export type CrEvidenceInput = Readonly<Record<CrStage, CrStageEvidenceInput>>

function deriveStageStatus(commands: readonly CrCommandEvidence[]): CrStageStatus {
  if (commands.length === 0) return 'skipped'
  return commands.every((command) => command.exitCode === 0) ? 'complete' : 'failed'
}

/**
 * Builds the CR0-CR7 verification summary strictly from supplied executed-command evidence.
 * Status is always derived from the evidence (never defaulted to "complete"); a stage with no
 * evidence is "skipped" and a stage with any failing command is "failed".
 */
export function buildCrVerificationSummary(
  stageEvidence: CrEvidenceInput,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  for (const stage of CR_STAGES) {
    if (!stageEvidence[stage]) {
      throw new Error(`migration.release_gate_stage_evidence_missing: ${stage}`)
    }
  }
  const stages = Object.fromEntries(
    CR_STAGES.map((stage) => {
      const commands = stageEvidence[stage].commands
      return [stage, { status: deriveStageStatus(commands), commands }]
    })
  )
  return {
    correctivePlan: 'v4',
    stages,
    generatedAtMs: Date.now(),
    ...overrides
  }
}

function loadSummaryArg(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('migration.release_gate_summary_invalid')
  }
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).length === 0) {
    throw new Error('migration.release_gate_summary_missing')
  }
  return record
}

function parseEvidenceInput(record: Record<string, unknown>): CrEvidenceInput {
  const stagesValue = record.stages
  if (stagesValue === null || typeof stagesValue !== 'object' || Array.isArray(stagesValue)) {
    throw new Error('migration.release_gate_stages_missing')
  }
  const stages = stagesValue as Record<string, unknown>
  const out: Record<string, CrStageEvidenceInput> = {}
  for (const stage of CR_STAGES) {
    const entry = stages[stage]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`migration.release_gate_stage_evidence_missing: ${stage}`)
    }
    const commands = (entry as Record<string, unknown>).commands
    if (!Array.isArray(commands)) {
      throw new Error(`migration.release_gate_stage_evidence_missing: ${stage}`)
    }
    out[stage] = { commands: commands as CrCommandEvidence[] }
  }
  return out as CrEvidenceInput
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = requireArg(args, 'db')
  const appCommit =
    typeof args.commit === 'string' && args.commit.trim() ? args.commit.trim() : resolveAppCommit()

  if (typeof args.summary !== 'string' || !args.summary.trim()) {
    throw new Error('migration.release_gate_summary_required')
  }

  const evidenceRecord = loadSummaryArg(args.summary)
  const { stages: _rawStages, ...evidenceOverrides } = evidenceRecord
  const verificationSummary = buildCrVerificationSummary(
    parseEvidenceInput(evidenceRecord),
    evidenceOverrides
  )

  const validation = validateCrVerificationSummary(verificationSummary, appCommit)
  if (!validation.ok) {
    throw new Error(`migration.release_gate_evidence_invalid: ${validation.errors.join('; ')}`)
  }

  const db = new Database(dbPath, { fileMustExist: true })
  try {
    writeCutoverReleaseGate(db, { appCommit, verificationSummary })
  } finally {
    db.close()
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        dbPath,
        appCommit,
        verificationSummaryKeys: Object.keys(verificationSummary)
      },
      null,
      2
    )
  )
}

const entryPath = process.argv[1]?.replace(/\\/g, '/')
if (entryPath?.endsWith('write-release-gate.ts')) {
  main()
}
