import { eq, and, sql } from 'drizzle-orm'
import { createHash } from 'crypto'
import type { DbExecutor } from './db-executor'
import type { VerificationRepository as VerificationRepositoryPort, VerificationRow } from '../../../application/ports/verification-repository'
import { controlVerifications, controlPlanSlices } from './schema'

export type { VerificationRow }

function mapRow(result: typeof controlVerifications.$inferSelect): VerificationRow {
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
    resultRevision: result.resultRevision ?? null,
    failureId: result.failureId,
    startedAtMs: result.startedAtMs,
    endedAtMs: result.endedAtMs
  }
}

export class SqliteVerificationRepository implements VerificationRepositoryPort {
  constructor(private readonly db: DbExecutor) {}

  create(input: {
    id: string
    jobId: string
    executionGeneration: number
    planRevision: number
    scopeType: string
    scopeId: string
    attemptNo: number
    runId: string
    fenceToken: string
    startedAtMs: number
  }): void {
    this.db
      .insert(controlVerifications)
      .values({
        id: input.id,
        jobId: input.jobId,
        executionGeneration: input.executionGeneration,
        planRevision: input.planRevision,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        attemptNo: input.attemptNo,
        state: 'running',
        runId: input.runId,
        fenceToken: input.fenceToken,
        startedAtMs: input.startedAtMs
      })
      .run()
  }

  markPassed(
    verificationId: string,
    verdictBlobHash: string,
    resultHash: string,
    resultRevision: number,
    endedAtMs: number
  ): boolean {
    const result = this.db
      .update(controlVerifications)
      .set({
        state: 'passed',
        verdictBlobHash,
        resultHash,
        resultRevision,
        endedAtMs
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

  markRejected(verificationId: string, failureId: string, endedAtMs: number): boolean {
    const result = this.db
      .update(controlVerifications)
      .set({
        state: 'rejected',
        failureId,
        endedAtMs
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
    return mapRow(result)
  }

  getRunningForScope(input: {
    jobId: string
    executionGeneration: number
    planRevision: number
    scopeType: string
    scopeId: string
  }): VerificationRow | null {
    const result = this.db
      .select()
      .from(controlVerifications)
      .where(
        and(
          eq(controlVerifications.jobId, input.jobId),
          eq(controlVerifications.executionGeneration, input.executionGeneration),
          eq(controlVerifications.planRevision, input.planRevision),
          eq(controlVerifications.scopeType, input.scopeType),
          eq(controlVerifications.scopeId, input.scopeId),
          eq(controlVerifications.state, 'running')
        )
      )
      .get()

    return result ? mapRow(result) : null
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

    return results.map(mapRow)
  }

  isMilestoneReady(
    jobId: string,
    generation: number,
    planRevision: number,
    milestoneId: string
  ): boolean {
    const missing = this.db
      .select({ sliceId: controlPlanSlices.sliceId })
      .from(controlPlanSlices)
      .leftJoin(
        controlVerifications,
        and(
          eq(controlVerifications.jobId, controlPlanSlices.jobId),
          eq(controlVerifications.executionGeneration, generation),
          eq(controlVerifications.planRevision, planRevision),
          eq(controlVerifications.scopeType, 'slice'),
          eq(controlVerifications.scopeId, controlPlanSlices.sliceId),
          eq(controlVerifications.state, 'passed'),
          sql`${controlVerifications.verdictBlobHash} IS NOT NULL`
        )
      )
      .where(
        and(
          eq(controlPlanSlices.jobId, jobId),
          eq(controlPlanSlices.planRevision, planRevision),
          eq(controlPlanSlices.milestoneId, milestoneId),
          sql`${controlVerifications.id} IS NULL`
        )
      )
      .all()

    return missing.length === 0
  }

  storeVerdictBlob(verdict: unknown): string {
    const content = JSON.stringify(verdict)
    return createHash('sha256').update(content).digest('hex')
  }

  hasRunningVerificationForRun(runId: string): boolean {
    const row = this.db
      .select({ id: controlVerifications.id })
      .from(controlVerifications)
      .where(and(eq(controlVerifications.runId, runId), eq(controlVerifications.state, 'running')))
      .get()
    return row !== undefined
  }
}
