import { eq, and, sql } from 'drizzle-orm'
import type { TaskRepository, TaskRow, TaskAttemptRow, TaskState } from '../../../application/ports/task-repository'
import type { ControlPlaneDatabase } from './job-repository'
import { controlJobTasks, controlTaskAttempts } from './schema'

export class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly db: ControlPlaneDatabase) {}

  getCurrentTask(jobId: string, generation: number, taskId: string): TaskRow | null {
    const result = this.db
      .select()
      .from(controlJobTasks)
      .where(
        and(
          eq(controlJobTasks.jobId, jobId),
          eq(controlJobTasks.executionGeneration, generation),
          eq(controlJobTasks.taskId, taskId)
        )
      )
      .get()

    if (!result) return null

    return {
      jobId: result.jobId,
      executionGeneration: result.executionGeneration,
      taskId: result.taskId,
      sourcePlanRevision: result.sourcePlanRevision,
      state: result.state as TaskState,
      sortOrder: result.sortOrder,
      originKind: result.originKind,
      parentTaskId: result.parentTaskId,
      title: result.title,
      abilityCode: result.abilityCode,
      coreCode: result.coreCode,
      createdAtMs: result.createdAtMs,
      updatedAtMs: result.updatedAtMs
    }
  }

  updateTaskState(
    jobId: string,
    generation: number,
    taskId: string,
    expectedState: TaskState,
    nextState: TaskState
  ): boolean {
    const now = Date.now()
    const result = this.db
      .update(controlJobTasks)
      .set({ state: nextState, updatedAtMs: now })
      .where(
        and(
          eq(controlJobTasks.jobId, jobId),
          eq(controlJobTasks.executionGeneration, generation),
          eq(controlJobTasks.taskId, taskId),
          eq(controlJobTasks.state, expectedState)
        )
      )
      .run()

    return result.changes === 1
  }

  getRunningAttempt(attemptId: string): TaskAttemptRow | null {
    const result = this.db
      .select()
      .from(controlTaskAttempts)
      .where(
        and(eq(controlTaskAttempts.id, attemptId), eq(controlTaskAttempts.state, 'running'))
      )
      .get()

    if (!result) return null

    return {
      id: result.id,
      jobId: result.jobId,
      executionGeneration: result.executionGeneration,
      taskId: result.taskId,
      attemptNo: result.attemptNo,
      runId: result.runId,
      state: result.state,
      provider: result.provider,
      evidenceBlobHash: result.evidenceBlobHash,
      failureId: result.failureId,
      startedAtMs: result.startedAtMs,
      endedAtMs: result.endedAtMs,
      resultHash: result.resultHash
    }
  }

  finishAttempt(attemptId: string, resultHash: string, evidenceHash: string): void {
    const now = Date.now()
    this.db
      .update(controlTaskAttempts)
      .set({
        state: 'completed',
        resultHash,
        evidenceBlobHash: evidenceHash,
        endedAtMs: now
      })
      .where(eq(controlTaskAttempts.id, attemptId))
      .run()
  }

  createAttempt(jobId: string, generation: number, taskId: string, runId: string): string {
    const attemptId = crypto.randomUUID()
    const now = Date.now()

    // Get next attempt number
    const maxAttempt = this.db
      .select({ maxNo: sql`MAX(${controlTaskAttempts.attemptNo})` })
      .from(controlTaskAttempts)
      .where(
        and(
          eq(controlTaskAttempts.jobId, jobId),
          eq(controlTaskAttempts.executionGeneration, generation),
          eq(controlTaskAttempts.taskId, taskId)
        )
      )
      .get() as { maxNo: number | null } | undefined

    const nextAttemptNo = (maxAttempt?.maxNo ?? 0) + 1

    this.db
      .insert(controlTaskAttempts)
      .values({
        id: attemptId,
        jobId,
        executionGeneration: generation,
        taskId,
        attemptNo: nextAttemptNo,
        runId,
        state: 'running',
        startedAtMs: now
      })
      .run()

    return attemptId
  }

  startAttempt(attemptId: string): boolean {
    const result = this.db
      .update(controlTaskAttempts)
      .set({ state: 'running' })
      .where(
        and(
          eq(controlTaskAttempts.id, attemptId),
          eq(controlTaskAttempts.state, 'starting')
        )
      )
      .run()

    return result.changes === 1
  }

  getTaskAttempts(jobId: string, generation: number, taskId: string): readonly TaskAttemptRow[] {
    const results = this.db
      .select()
      .from(controlTaskAttempts)
      .where(
        and(
          eq(controlTaskAttempts.jobId, jobId),
          eq(controlTaskAttempts.executionGeneration, generation),
          eq(controlTaskAttempts.taskId, taskId)
        )
      )
      .orderBy(controlTaskAttempts.attemptNo)
      .all()

    return results.map((r) => ({
      id: r.id,
      jobId: r.jobId,
      executionGeneration: r.executionGeneration,
      taskId: r.taskId,
      attemptNo: r.attemptNo,
      runId: r.runId,
      state: r.state,
      provider: r.provider,
      evidenceBlobHash: r.evidenceBlobHash,
      failureId: r.failureId,
      startedAtMs: r.startedAtMs,
      endedAtMs: r.endedAtMs,
      resultHash: r.resultHash
    }))
  }
}
