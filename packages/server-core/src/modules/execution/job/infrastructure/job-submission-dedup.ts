import type Database from 'better-sqlite3'
import type { JobSubmission } from '@codetask/contracts'
import { ExecutionConflictError } from '../../shared.ts'
import { stableHash } from '../../shared.ts'

export function hashSubmission(submission: JobSubmission): string {
  return stableHash(JSON.stringify(submission))
}

export class JobSubmissionDedup {
  constructor(private readonly db: Database.Database) {}

  checkIdempotency(
    idempotencyKey: string,
    submissionHash: string
  ): { kind: 'new' } | { kind: 'replay'; jobId: string; acceptedAt: number } | { kind: 'conflict' } {
    const row = this.db
      .prepare(
        `SELECT id, submission_hash, created_at FROM jobs WHERE idempotency_key = ?`
      )
      .get(idempotencyKey) as
      | { id: string; submission_hash: string; created_at: number }
      | undefined
    if (!row) return { kind: 'new' }
    if (row.submission_hash === submissionHash) {
      return { kind: 'replay', jobId: row.id, acceptedAt: row.created_at }
    }
    return { kind: 'conflict' }
  }

  checkSubmissionId(submissionId: string): { jobId: string; acceptedAt: number } | null {
    const row = this.db
      .prepare(`SELECT id, created_at FROM jobs WHERE submission_id = ?`)
      .get(submissionId) as { id: string; created_at: number } | undefined
    if (!row) return null
    return { jobId: row.id, acceptedAt: row.created_at }
  }

  assertNoConflict(dedup: ReturnType<JobSubmissionDedup['checkIdempotency']>): void {
    if (dedup.kind === 'conflict') {
      throw new ExecutionConflictError('Idempotency key reused with different payload')
    }
  }
}
