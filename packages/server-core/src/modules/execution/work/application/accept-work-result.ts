import type { TaskEvidence } from '@codetask/contracts'
import type Database from 'better-sqlite3'
import { newId, nowMs, stableHash } from '../../shared.ts'
import { WorkRepository } from '../infrastructure/work-repository.ts'
import { ExecutionOutbox } from '../../events/execution-outbox.ts'
import { validateTaskEvidence } from '../../verification/domain/task-evidence.ts'

export type AcceptWorkResultService = {
  accept(input: {
    jobId: string
    workId: string
    attemptId: string
    evidence: TaskEvidence
  }): void
}

export function createAcceptWorkResultService(deps: {
  db: Database.Database
  work: WorkRepository
  outbox: ExecutionOutbox
}): AcceptWorkResultService {
  return {
    accept(input: {
      jobId: string
      workId: string
      attemptId: string
      evidence: TaskEvidence
    }): void {
      validateTaskEvidence(input.evidence)
      const now = nowMs()
      const resultHash = stableHash(JSON.stringify(input.evidence))
      const resultId = newId('wresult')

      const tx = deps.db.transaction(() => {
        const work = deps.work.requireWork(input.jobId, input.workId)
        deps.work.casWorkState({
          jobId: input.jobId,
          workId: input.workId,
          expectedRevision: work.stateRevision,
          nextState: 'reported',
          updatedAt: now
        })

        deps.db
          .prepare(
            `INSERT INTO work_results (
              id, attempt_id, status, summary, evidence_json, changed_files_json, validation_json,
              evidence_summary, result_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            resultId,
            input.attemptId,
            input.evidence.status,
            input.evidence.summary,
            JSON.stringify(input.evidence),
            JSON.stringify(input.evidence.changedFiles),
            JSON.stringify(input.evidence.validation),
            input.evidence.evidence.join('\n'),
            resultHash,
            now
          )

        deps.db
          .prepare(`UPDATE work_attempts SET status = 'succeeded', ended_at = ?, result_hash = ? WHERE id = ?`)
          .run(now, resultHash, input.attemptId)

        const nextState =
          input.evidence.status === 'completed'
            ? 'succeeded'
            : input.evidence.status === 'blocked'
              ? 'blocked'
              : 'failed'
        const updated = deps.work.requireWork(input.jobId, input.workId)
        deps.work.casWorkState({
          jobId: input.jobId,
          workId: input.workId,
          expectedRevision: updated.stateRevision,
          nextState,
          updatedAt: now
        })

        deps.outbox.enqueue(
          input.jobId,
          'work.changed',
          { jobId: input.jobId, workId: input.workId, state: nextState },
          deps.db
        )
      })
      tx()
    }
  }
}
