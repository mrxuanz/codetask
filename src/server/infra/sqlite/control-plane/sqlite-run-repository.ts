import { eq } from 'drizzle-orm'
import type { RunRepository } from '../../../application/ports/run-repository'
import type { ActiveRunSummary } from '../../../domain/jobs/job-invariants'
import type { DbExecutor } from './db-executor'
import { controlJobRuns } from './schema'

export class SqliteRunRepository implements RunRepository {
  constructor(private readonly db: DbExecutor) {}

  createRun(input: Parameters<RunRepository['createRun']>[0]): void {
    this.db
      .insert(controlJobRuns)
      .values({
        id: input.id,
        jobId: input.jobId,
        kind: input.kind,
        state: 'starting',
        attemptNo: 1,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration,
        startedAtMs: input.startedAtMs
      })
      .run()
  }

  getActiveRunSummary(runId: string): ActiveRunSummary | null {
    const result = this.db
      .select({
        id: controlJobRuns.id,
        state: controlJobRuns.state,
        fenceToken: controlJobRuns.fenceToken,
        executionGeneration: controlJobRuns.executionGeneration,
        currentRuntimeInstanceId: controlJobRuns.currentRuntimeInstanceId
      })
      .from(controlJobRuns)
      .where(eq(controlJobRuns.id, runId))
      .get()

    if (!result) return null

    return {
      id: result.id,
      state: result.state,
      fenceToken: result.fenceToken,
      executionGeneration: result.executionGeneration,
      currentRuntimeInstanceId: result.currentRuntimeInstanceId
    }
  }

  markRunState(input: {
    readonly runId: string
    readonly state: string
    readonly stopReason?: string | null
    readonly updatedAtMs: number
  }): void {
    const ended =
      input.state === 'paused' ||
      input.state === 'cancelled' ||
      input.state === 'failed' ||
      input.state === 'succeeded' ||
      input.state === 'interrupted'
    this.db
      .update(controlJobRuns)
      .set({
        state: input.state,
        stopReason: input.stopReason ?? null,
        endedAtMs: ended ? input.updatedAtMs : null
      })
      .where(eq(controlJobRuns.id, input.runId))
      .run()
  }

  markRunActive(input: {
    readonly runId: string
    readonly runtimeInstanceId: string
    readonly updatedAtMs: number
  }): void {
    this.db
      .update(controlJobRuns)
      .set({
        state: 'active',
        currentRuntimeInstanceId: input.runtimeInstanceId,
        heartbeatAtMs: input.updatedAtMs
      })
      .where(eq(controlJobRuns.id, input.runId))
      .run()
  }
}
