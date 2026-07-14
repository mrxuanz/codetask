import { eq, and, sql } from 'drizzle-orm'
import type { TaskRepository, TaskRow, TaskAttemptRow, TaskState } from '../../../application/ports/task-repository'
import type { DbExecutor } from './db-executor'
import { controlJobTasks, controlTaskAttempts } from './schema'

function mapTaskRow(result: {
  jobId: string
  executionGeneration: number
  taskId: string
  sourcePlanRevision: number
  state: string
  sortOrder: number
  originKind: string | null
  parentTaskId: string | null
  title: string
  abilityCode: string | null
  coreCode: string | null
  createdAtMs: number
  updatedAtMs: number
}): TaskRow {
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

function mapAttemptRow(result: {
  id: string
  jobId: string
  executionGeneration: number
  taskId: string
  attemptNo: number
  runId: string
  state: string
  provider: string | null
  evidenceBlobHash: string | null
  failureId: string | null
  startedAtMs: number
  endedAtMs: number | null
  resultHash: string | null
  resultRevision: number | null
  mustPauseAtCommit: number | null
}): TaskAttemptRow {
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
    resultHash: result.resultHash,
    resultRevision: result.resultRevision,
    mustPauseAtCommit:
      result.mustPauseAtCommit === null ? null : result.mustPauseAtCommit === 1
  }
}

export class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly db: DbExecutor) {}

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

    return result ? mapTaskRow(result) : null
  }

  listTasksForGeneration(jobId: string, generation: number): readonly TaskRow[] {
    return this.db
      .select()
      .from(controlJobTasks)
      .where(
        and(
          eq(controlJobTasks.jobId, jobId),
          eq(controlJobTasks.executionGeneration, generation)
        )
      )
      .orderBy(controlJobTasks.sortOrder)
      .all()
      .map((task) => mapTaskRow(task))
  }

  updateTaskState(
    jobId: string,
    generation: number,
    taskId: string,
    expectedState: TaskState,
    nextState: TaskState,
    updatedAtMs: number
  ): boolean {
    const result = this.db
      .update(controlJobTasks)
      .set({ state: nextState, updatedAtMs })
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

  cloneTasksToGeneration(
    jobId: string,
    sourceGeneration: number,
    targetGeneration: number,
    createdAtMs: number
  ): number {
    const sourceTasks = this.db
      .select()
      .from(controlJobTasks)
      .where(
        and(
          eq(controlJobTasks.jobId, jobId),
          eq(controlJobTasks.executionGeneration, sourceGeneration)
        )
      )
      .orderBy(controlJobTasks.sortOrder)
      .all()
    if (sourceTasks.length === 0) return 0

    const result = this.db
      .insert(controlJobTasks)
      .values(
        sourceTasks.map((task) => ({
          jobId: task.jobId,
          executionGeneration: targetGeneration,
          taskId: task.taskId,
          sourcePlanRevision: task.sourcePlanRevision,
          state: 'queued',
          sortOrder: task.sortOrder,
          originKind: task.originKind,
          parentTaskId: task.parentTaskId,
          title: task.title,
          abilityCode: task.abilityCode,
          coreCode: task.coreCode,
          createdAtMs,
          updatedAtMs: createdAtMs
        }))
      )
      .run()
    return result.changes
  }

  getAttempt(attemptId: string): TaskAttemptRow | null {
    const result = this.db
      .select()
      .from(controlTaskAttempts)
      .where(eq(controlTaskAttempts.id, attemptId))
      .get()

    return result ? mapAttemptRow(result) : null
  }

  getRunningAttempt(attemptId: string): TaskAttemptRow | null {
    const attempt = this.getAttempt(attemptId)
    return attempt?.state === 'running' ? attempt : null
  }

  getPendingAttemptForRun(runId: string): TaskAttemptRow | null {
    const result = this.db
      .select()
      .from(controlTaskAttempts)
      .where(
        and(eq(controlTaskAttempts.runId, runId), eq(controlTaskAttempts.state, 'pending'))
      )
      .get()

    return result ? mapAttemptRow(result) : null
  }

  finishAttempt(
    attemptId: string,
    resultHash: string,
    evidenceHash: string,
    resultRevision: number,
    endedAtMs: number,
    mustPauseAtCommit?: boolean
  ): void {
    this.db
      .update(controlTaskAttempts)
      .set({
        state: 'completed',
        resultHash,
        evidenceBlobHash: evidenceHash,
        resultRevision,
        endedAtMs,
        mustPauseAtCommit: mustPauseAtCommit === true ? 1 : mustPauseAtCommit === false ? 0 : null
      })
      .where(eq(controlTaskAttempts.id, attemptId))
      .run()
  }

  createAttempt(input: {
    readonly id: string
    readonly jobId: string
    readonly generation: number
    readonly taskId: string
    readonly runId: string
    readonly state: 'pending' | 'running' | 'starting'
    readonly startedAtMs: number
    readonly attemptNo?: number
  }): void {
    let attemptNo = input.attemptNo
    if (attemptNo === undefined) {
      const maxAttempt = this.db
        .select({ maxNo: sql<number>`MAX(${controlTaskAttempts.attemptNo})` })
        .from(controlTaskAttempts)
        .where(
          and(
            eq(controlTaskAttempts.jobId, input.jobId),
            eq(controlTaskAttempts.executionGeneration, input.generation),
            eq(controlTaskAttempts.taskId, input.taskId)
          )
        )
        .get()

      attemptNo = (maxAttempt?.maxNo ?? 0) + 1
    }

    this.db
      .insert(controlTaskAttempts)
      .values({
        id: input.id,
        jobId: input.jobId,
        executionGeneration: input.generation,
        taskId: input.taskId,
        attemptNo,
        runId: input.runId,
        state: input.state,
        startedAtMs: input.startedAtMs,
        resultRevision: 0
      })
      .run()
  }

  startAttempt(attemptId: string): boolean {
    const result = this.db
      .update(controlTaskAttempts)
      .set({ state: 'running' })
      .where(
        and(
          eq(controlTaskAttempts.id, attemptId),
          sql`${controlTaskAttempts.state} IN ('pending', 'starting')`
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

    return results.map((r) => mapAttemptRow(r))
  }
}
