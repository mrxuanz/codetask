import { eq, and, sql } from 'drizzle-orm'
import { createHash } from 'crypto'
import type { ControlPlaneDatabase } from './job-repository'
import type { VerificationStore, VerificationRow } from '../../../application/ports/verification-store'
import { controlVerifications } from './schema'

export type { VerificationRow }

export class VerificationRepository implements VerificationStore {
  constructor(private readonly db: ControlPlaneDatabase) {}

  create(input: {
    jobId: string
    executionGeneration: number
    planRevision: number
    scopeType: string
    scopeId: string
    attemptNo: number
    runId: string
    fenceToken: string
  }): string {
    const id = crypto.randomUUID()
    const now = Date.now()

    this.db
      .insert(controlVerifications)
      .values({
        id,
        jobId: input.jobId,
        executionGeneration: input.executionGeneration,
        planRevision: input.planRevision,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        attemptNo: input.attemptNo,
        state: 'running',
        runId: input.runId,
        fenceToken: input.fenceToken,
        startedAtMs: now
      })
      .run()

    return id
  }

  markPassed(verificationId: string, verdictBlobHash: string, resultHash: string): boolean {
    const now = Date.now()
    const result = this.db
      .update(controlVerifications)
      .set({
        state: 'passed',
        verdictBlobHash,
        resultHash,
        endedAtMs: now
      })
      .where(
        and(
          eq(controlVerifications.id, verificationId),
          eq(controlVerifications.state, 'running')
        )
      )
      .run()

    return result.changes === 1
  }

  markRejected(verificationId: string, failureId: string): boolean {
    const now = Date.now()
    const result = this.db
      .update(controlVerifications)
      .set({
        state: 'rejected',
        failureId,
        endedAtMs: now
      })
      .where(
        and(
          eq(controlVerifications.id, verificationId),
          eq(controlVerifications.state, 'running')
        )
      )
      .run()

    return result.changes === 1
  }

  getById(verificationId: string): VerificationRow | null {
    const result = this.db
      .select()
      .from(controlVerifications)
      .where(eq(controlVerifications.id, verificationId))
      .get()

    if (!result) return null

    return {
      id: result.id,
      jobId: result.jobId,
      executionGeneration: result.executionGeneration,
      planRevision: result.planRevision,
      scopeType: result.scopeType,
      scopeId: result.scopeId,
      attemptNo: result.attemptNo,
      state: result.state,
      runId: result.runId,
      fenceToken: result.fenceToken,
      verdictBlobHash: result.verdictBlobHash,
      resultHash: result.resultHash,
      failureId: result.failureId,
      startedAtMs: result.startedAtMs,
      endedAtMs: result.endedAtMs
    }
  }

  getCurrentPassedVerifications(
    jobId: string,
    generation: number,
    planRevision: number,
    scopeType: string
  ): readonly VerificationRow[] {
    const results = this.db
      .select()
      .from(controlVerifications)
      .where(
        and(
          eq(controlVerifications.jobId, jobId),
          eq(controlVerifications.executionGeneration, generation),
          eq(controlVerifications.planRevision, planRevision),
          eq(controlVerifications.scopeType, scopeType),
          eq(controlVerifications.state, 'passed'),
          sql`${controlVerifications.verdictBlobHash} IS NOT NULL`
        )
      )
      .all()

    return results.map((r) => ({
      id: r.id,
      jobId: r.jobId,
      executionGeneration: r.executionGeneration,
      planRevision: r.planRevision,
      scopeType: r.scopeType,
      scopeId: r.scopeId,
      attemptNo: r.attemptNo,
      state: r.state,
      runId: r.runId,
      fenceToken: r.fenceToken,
      verdictBlobHash: r.verdictBlobHash,
      resultHash: r.resultHash,
      failureId: r.failureId,
      startedAtMs: r.startedAtMs,
      endedAtMs: r.endedAtMs
    }))
  }

  isMilestoneReady(
    jobId: string,
    generation: number,
    planRevision: number,
    milestoneId: string
  ): boolean {
    // Check if all slices for this milestone have passed verifications with verdicts
    const result = this.db.all(
      `SELECT COUNT(*) as missing
       FROM control_plan_slices s
       LEFT JOIN control_verifications v
         ON v.job_id = ${jobId}
         AND v.execution_generation = ${generation}
         AND v.plan_revision = ${planRevision}
         AND v.scope_type = 'slice'
         AND v.scope_id = s.slice_id
         AND v.state = 'passed'
         AND v.verdict_blob_hash IS NOT NULL
       WHERE s.milestone_id = ${milestoneId}
         AND s.job_id = ${jobId}
         AND s.plan_revision = ${planRevision}
         AND v.id IS NULL`
    ) as Array<{ missing: number }>

    return result[0]?.missing === 0
  }

  storeVerdictBlob(verdict: unknown): string {
    const content = JSON.stringify(verdict)
    return createHash('sha256').update(content).digest('hex')
  }
}
