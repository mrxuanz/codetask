import type Database from 'better-sqlite3'
import type { MilestoneVerdict, SliceVerdict } from '@codetask/contracts'
import { newId, nowMs, stableHash } from '../../shared.ts'
import { VerificationRepository } from '../infrastructure/verification-repository.ts'
import { ExecutionOutbox } from '../../events/execution-outbox.ts'
import { WorkRepository } from '../../work/infrastructure/work-repository.ts'
import {
  evaluateSliceVerdict,
  sliceEvidenceBundleHashInput
} from '../domain/slice-verdict.ts'
import { evaluateMilestoneVerdict } from '../domain/milestone-verdict.ts'
import {
  MAX_MILESTONE_VERIFICATION_ATTEMPTS,
  MAX_SLICE_VERIFICATION_ATTEMPTS
} from '../domain/verification-policy.ts'
import { createInjectRepairWorkService } from '../../recovery/application/inject-repair-work.ts'
import { canInjectRepair } from '../../recovery/domain/repair-policy.ts'
import {
  readJobExecutionSettings,
  verificationMcpFromJobSettings,
  verifierPromptFromJobSettings
} from '../../job/application/job-settings-snapshot.ts'

function countAttempts(
  db: Database.Database,
  jobId: string,
  scopeType: string,
  scopeId: string,
  generation: number
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM verification_attempts
       WHERE job_id = ? AND scope_type = ? AND scope_id = ? AND generation = ?`
    )
    .get(jobId, scopeType, scopeId, generation) as { n: number }
  return Number(row.n)
}

function findSucceededBundle(
  db: Database.Database,
  jobId: string,
  scopeType: string,
  scopeId: string,
  bundleHash: string
): { status: string } | null {
  const row = db
    .prepare(
      `SELECT vr.status FROM verification_attempts va
       JOIN verification_results vr ON vr.verification_attempt_id = va.id
       WHERE va.job_id = ? AND va.scope_type = ? AND va.scope_id = ?
         AND va.bundle_hash = ? AND va.status = 'succeeded'
       ORDER BY va.ended_at DESC LIMIT 1`
    )
    .get(jobId, scopeType, scopeId, bundleHash) as { status: string } | undefined
  return row ?? null
}

function persistVerdict(input: {
  db: Database.Database
  outbox: ExecutionOutbox
  jobId: string
  generation: number
  scopeType: 'slice' | 'milestone'
  scopeId: string
  runId: string
  attemptNumber: number
  bundleHash: string
  verdict: SliceVerdict | MilestoneVerdict
}): void {
  const now = nowMs()
  const attemptId = newId('vattempt')
  const jobSettings = readJobExecutionSettings(input.db, input.jobId)
  // Bind attempt to frozen Job settings (05): rule-based verify today does not call AgentRuntime,
  // but still records settingsHash + verification MCP/prompt refs for audit / future agent verify.
  const settingsBinding = {
    settingsHash: jobSettings?.settingsHash ?? '',
    verificationMcpServers: verificationMcpFromJobSettings(jobSettings),
    verifierPromptBody: verifierPromptFromJobSettings(
      jobSettings,
      input.scopeType === 'milestone' ? 'milestone' : 'slice'
    )
  }
  input.db
    .prepare(
      `INSERT INTO verification_attempts (
        id, job_id, generation, scope_type, scope_id, attempt_number,
        bundle_hash, status, run_id, started_at, ended_at, error_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?)`
    )
    .run(
      attemptId,
      input.jobId,
      input.generation,
      input.scopeType,
      input.scopeId,
      input.attemptNumber,
      input.bundleHash,
      input.runId,
      now,
      now,
      JSON.stringify({ settingsBinding })
    )

  const resultId = newId('vresult')
  input.db
    .prepare(
      `INSERT INTO verification_results (
        id, verification_attempt_id, scope_type, scope_id, status, confidence,
        summary, verdict_json, bundle_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      resultId,
      attemptId,
      input.scopeType,
      input.scopeId,
      input.verdict.status,
      input.verdict.confidence,
      input.verdict.summary,
      JSON.stringify({ ...input.verdict, settingsHash: settingsBinding.settingsHash }),
      input.bundleHash,
      now
    )

  input.outbox.enqueue(
    input.jobId,
    'verification.changed',
    { jobId: input.jobId, scopeType: input.scopeType, scopeId: input.scopeId },
    input.db
  )
}

export function createVerifySliceService(deps: {
  db: Database.Database
  verification: VerificationRepository
  outbox: ExecutionOutbox
  work?: WorkRepository
}) {
  const work = deps.work ?? new WorkRepository(deps.db)
  const repair = createInjectRepairWorkService({ db: deps.db })

  return {
    verify(input: { jobId: string; generation: number; sliceId: string; runId: string }): SliceVerdict {
      const sliceWork = work
        .listWork(input.jobId, input.generation)
        .filter((w) => w.sliceId === input.sliceId)

      const bundleHash = stableHash(
        sliceEvidenceBundleHashInput(input.jobId, input.sliceId, input.generation, sliceWork)
      )

      const prior = findSucceededBundle(
        deps.db,
        input.jobId,
        'slice',
        input.sliceId,
        bundleHash
      )
      if (prior) {
        deps.verification.updateSliceVerification(
          input.jobId,
          input.generation,
          input.sliceId,
          prior.status,
          prior.status === 'progress-ok' ? 'progress-ok' : prior.status
        )
        return evaluateSliceVerdict(sliceWork)
      }

      const attempts = countAttempts(deps.db, input.jobId, 'slice', input.sliceId, input.generation)
      let verdict = evaluateSliceVerdict(sliceWork)

      if (verdict.status === 'inconclusive' && attempts + 1 >= MAX_SLICE_VERIFICATION_ATTEMPTS) {
        verdict = {
          ...verdict,
          status: 'blocked',
          confidence: 'high',
          summary: `Slice verification exhausted after ${MAX_SLICE_VERIFICATION_ATTEMPTS} attempts`
        }
      }

      const tx = deps.db.transaction(() => {
        persistVerdict({
          db: deps.db,
          outbox: deps.outbox,
          jobId: input.jobId,
          generation: input.generation,
          scopeType: 'slice',
          scopeId: input.sliceId,
          runId: input.runId,
          attemptNumber: attempts + 1,
          bundleHash,
          verdict
        })

        deps.verification.updateSliceVerification(
          input.jobId,
          input.generation,
          input.sliceId,
          verdict.status,
          verdict.status === 'progress-ok' ? 'progress-ok' : verdict.status
        )

        if (verdict.status === 'needs-repair') {
          for (const suggestion of verdict.repairSuggestions) {
            if (!suggestion.targetWorkId) continue
            const existing = deps.db
              .prepare(
                `SELECT COALESCE(MAX(generation_number), 0) AS n FROM repair_generations
                 WHERE job_id = ? AND generation = ? AND scope_type = 'work' AND scope_id = ?`
              )
              .get(input.jobId, input.generation, suggestion.targetWorkId) as { n: number }
            if (!canInjectRepair(Number(existing.n))) continue
            repair.inject({
              jobId: input.jobId,
              generation: input.generation,
              parentWorkId: suggestion.targetWorkId,
              kind: suggestion.kind,
              title: suggestion.title,
              description: suggestion.description,
              successCriteria: suggestion.successCriteria
            })
          }
        }
      })
      tx()
      return verdict
    }
  }
}

export function createVerifyMilestoneService(deps: {
  db: Database.Database
  verification: VerificationRepository
  outbox: ExecutionOutbox
}) {
  return {
    verify(input: {
      jobId: string
      generation: number
      milestoneId: string
      runId: string
    }): MilestoneVerdict {
      const sliceIds = deps.verification.listSliceIds(
        input.jobId,
        input.generation,
        input.milestoneId
      )
      const sliceVerificationStates = new Map(
        sliceIds.map((id) => [
          id,
          deps.verification.getSliceVerificationState(input.jobId, input.generation, id)
        ])
      )

      const bundleHash = stableHash(
        `${input.jobId}:${input.milestoneId}:${input.generation}:${sliceIds
          .map((id) => `${id}:${sliceVerificationStates.get(id)}`)
          .join('|')}`
      )

      const prior = findSucceededBundle(
        deps.db,
        input.jobId,
        'milestone',
        input.milestoneId,
        bundleHash
      )
      if (prior) {
        deps.verification.updateMilestoneState(
          input.jobId,
          input.generation,
          input.milestoneId,
          prior.status === 'passed' ? 'passed' : prior.status
        )
        return evaluateMilestoneVerdict({ sliceIds, sliceVerificationStates })
      }

      const attempts = countAttempts(
        deps.db,
        input.jobId,
        'milestone',
        input.milestoneId,
        input.generation
      )
      let verdict = evaluateMilestoneVerdict({ sliceIds, sliceVerificationStates })

      if (verdict.status === 'inconclusive' && attempts + 1 >= MAX_MILESTONE_VERIFICATION_ATTEMPTS) {
        verdict = {
          ...verdict,
          status: 'blocked',
          confidence: 'high',
          summary: `Milestone verification exhausted after ${MAX_MILESTONE_VERIFICATION_ATTEMPTS} attempts`
        }
      }

      const tx = deps.db.transaction(() => {
        persistVerdict({
          db: deps.db,
          outbox: deps.outbox,
          jobId: input.jobId,
          generation: input.generation,
          scopeType: 'milestone',
          scopeId: input.milestoneId,
          runId: input.runId,
          attemptNumber: attempts + 1,
          bundleHash,
          verdict
        })

        deps.verification.updateMilestoneState(
          input.jobId,
          input.generation,
          input.milestoneId,
          verdict.status === 'passed' ? 'passed' : verdict.status
        )
      })
      tx()
      return verdict
    }
  }
}

export function createVerifyTaskEvidenceService() {
  return {
    verify(evidenceValid: boolean): boolean {
      return evidenceValid
    }
  }
}
