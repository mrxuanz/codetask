import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import { migration027ControlPlaneSchema } from '../../../src/server/db/migrations/027_control_plane_schema'
import {
  CR_STAGES,
  assertCutoverReleaseGate,
  validateCrVerificationSummary,
  writeCutoverReleaseGate,
  type CrCommandEvidence,
  type CrStage
} from '../../../scripts/control-plane/release-gate'
import { buildCrVerificationSummary } from '../../../scripts/control-plane/write-release-gate'

function makeSchemaDb(): { readonly dbPath: string; readonly db: Database.Database } {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'release-gate-evidence-')), 'app.db')
  const db = new Database(dbPath)
  migration027ControlPlaneSchema.up(db)
  return { dbPath, db }
}

function passingEvidence(
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

describe('release gate: evidence-based CR verification (F1-D)', () => {
  it('buildCrVerificationSummary refuses to default missing stages to complete', () => {
    const partial = passingEvidence('commit-a')
    const { CR7: _dropped, ...withoutCr7 } = partial
    assert.throws(
      () => buildCrVerificationSummary(withoutCr7 as typeof partial),
      /migration\.release_gate_stage_evidence_missing: CR7/
    )
  })

  it('derives failed status from a non-zero exit code instead of defaulting to complete', () => {
    const evidence = passingEvidence('commit-a')
    const withFailure = {
      ...evidence,
      CR3: {
        commands: [{ ...evidence.CR3.commands[0]!, exitCode: 1 }]
      }
    }
    const summary = buildCrVerificationSummary(withFailure) as {
      stages: Record<string, { status: string }>
    }
    assert.equal(summary.stages.CR3?.status, 'failed')
    assert.equal(summary.stages.CR0?.status, 'complete')
  })

  it('derives skipped status when a stage has no executed commands', () => {
    const evidence = passingEvidence('commit-a')
    const withSkip = { ...evidence, CR5: { commands: [] } }
    const summary = buildCrVerificationSummary(withSkip) as {
      stages: Record<string, { status: string }>
    }
    assert.equal(summary.stages.CR5?.status, 'skipped')
  })

  it('validateCrVerificationSummary rejects an old-style self-certified summary with no evidence', () => {
    const selfCertified = {
      correctivePlan: 'v4',
      stages: Object.fromEntries(
        CR_STAGES.map((stage) => [
          stage,
          { status: 'complete', evidence: [`tests/control-plane/** (${stage})`] }
        ])
      )
    }
    const validation = validateCrVerificationSummary(selfCertified, 'commit-a')
    assert.equal(validation.ok, false)
    assert.ok(validation.errors.some((error) => error.includes('release_gate_stage_no_evidence')))
  })

  it('validateCrVerificationSummary rejects a failed command and a commit mismatch', () => {
    const evidence = passingEvidence('commit-a')
    const summary = buildCrVerificationSummary({
      ...evidence,
      CR1: { commands: [{ ...evidence.CR1.commands[0]!, exitCode: 1 }] },
      CR2: { commands: [{ ...evidence.CR2.commands[0]!, commit: 'other-commit' }] }
    })
    const validation = validateCrVerificationSummary(summary, 'commit-a')
    assert.equal(validation.ok, false)
    assert.ok(validation.errors.some((error) => error.includes('release_gate_command_failed: CR1')))
    assert.ok(
      validation.errors.some((error) => error.includes('release_gate_stage_not_complete: CR1'))
    )
    assert.ok(
      validation.errors.some((error) => error.includes('release_gate_command_commit_mismatch: CR2'))
    )
  })

  it('assertCutoverReleaseGate rejects a persisted gate lacking real command evidence', () => {
    const { dbPath, db } = makeSchemaDb()
    try {
      writeCutoverReleaseGate(db, {
        appCommit: 'commit-a',
        verificationSummary: {
          correctivePlan: 'v4',
          stages: Object.fromEntries(
            CR_STAGES.map((stage) => [stage, { status: 'complete', evidence: ['fabricated'] }])
          )
        }
      })
      assert.throws(
        () => assertCutoverReleaseGate(db, 'commit-a'),
        /migration\.release_gate_evidence_invalid/
      )
    } finally {
      db.close()
      rmSync(dirname(dbPath), { recursive: true, force: true })
    }
  })

  it('assertCutoverReleaseGate accepts a gate with real, passing, matching-commit evidence', () => {
    const { dbPath, db } = makeSchemaDb()
    try {
      writeCutoverReleaseGate(db, {
        appCommit: 'commit-a',
        verificationSummary: buildCrVerificationSummary(passingEvidence('commit-a'))
      })
      assert.doesNotThrow(() => assertCutoverReleaseGate(db, 'commit-a'))
    } finally {
      db.close()
      rmSync(dirname(dbPath), { recursive: true, force: true })
    }
  })
})
