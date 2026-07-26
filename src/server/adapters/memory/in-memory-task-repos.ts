import type { TaskAttempt } from '../../core/domain/tasks/types'
import { TERMINAL_ATTEMPT_STATUSES } from '../../core/domain/tasks/types'
import type {
  AttemptRepo,
  ProjectedTask,
  TaskProjectionRepo
} from '../../core/application/ports/task-projection'

function taskKey(jobId: string, generation: number, taskId: string): string {
  return `${jobId}:${generation}:${taskId}`
}

export class InMemoryTaskProjectionRepo implements TaskProjectionRepo {
  private readonly store = new Map<string, ProjectedTask>()

  async listForJob(
    jobId: string,
    executionGeneration: number
  ): Promise<readonly ProjectedTask[]> {
    return [...this.store.values()].filter(
      (t) => t.jobId === jobId && t.executionGeneration === executionGeneration
    )
  }

  async get(
    jobId: string,
    executionGeneration: number,
    taskId: string
  ): Promise<ProjectedTask | undefined> {
    const row = this.store.get(taskKey(jobId, executionGeneration, taskId))
    return row ? { ...row, task: { ...row.task } } : undefined
  }

  async save(record: ProjectedTask): Promise<void> {
    this.store.set(taskKey(record.jobId, record.executionGeneration, record.task.id), {
      ...record,
      task: { ...record.task, dependencyIds: [...record.task.dependencyIds] }
    })
  }
}

export class InMemoryAttemptRepo implements AttemptRepo {
  private readonly store = new Map<string, TaskAttempt & { jobId: string }>

  async get(id: string): Promise<TaskAttempt | undefined> {
    const row = this.store.get(id)
    if (!row) return undefined
    const { jobId: _jobId, ...attempt } = row
    return { ...attempt }
  }

  async save(
    attempt: TaskAttempt,
    opts?: { readonly jobId?: string }
  ): Promise<void> {
    const existing = this.store.get(attempt.id)
    const resolvedJobId = opts?.jobId ?? existing?.jobId
    if (!resolvedJobId) {
      throw new Error(`attempt.jobId_required: ${attempt.id}`)
    }
    this.store.set(attempt.id, { ...attempt, jobId: resolvedJobId })
  }

  async listForTask(
    jobId: string,
    taskId: string,
    executionGeneration: number
  ): Promise<readonly TaskAttempt[]> {
    return [...this.store.values()]
      .filter(
        (a) =>
          a.jobId === jobId &&
          a.taskId === taskId &&
          a.executionGeneration === executionGeneration
      )
      .map(({ jobId: _j, ...attempt }) => ({ ...attempt }))
  }

  async listNonTerminal(): Promise<readonly (TaskAttempt & { readonly jobId: string })[]> {
    return [...this.store.values()]
      .filter((a) => !TERMINAL_ATTEMPT_STATUSES.has(a.status))
      .map((a) => ({ ...a }))
  }
}
