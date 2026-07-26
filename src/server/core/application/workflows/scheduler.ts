import { isTaskReady } from '../../domain/tasks/readiness'
import type { ProjectedTask } from '../ports/task-projection'
import type { WorkspaceLeaseRepo } from '../ports/workspace-lease'
import { assertSingleWriter } from '../policies/workspace-single-writer'

export type SelectReadyTasksInput = {
  readonly jobId: string
  readonly workspaceId: string
  readonly tasks: readonly ProjectedTask[]
  readonly leases: WorkspaceLeaseRepo
  readonly nowMs: number
}

export type ReadyTaskSelection = {
  readonly ready: readonly ProjectedTask[]
  readonly leaseAcquired: boolean
}

/**
 * Select pending tasks whose dependencies are all completed,
 * enforcing workspace single-writer via lease acquire.
 */
export async function selectReadyTasks(
  input: SelectReadyTasksInput
): Promise<ReadyTaskSelection> {
  const existing = await input.leases.get(input.workspaceId)
  assertSingleWriter(input.workspaceId, input.jobId, existing?.holderId ?? null)

  const acquired = await input.leases.tryAcquire({
    workspaceId: input.workspaceId,
    holderId: input.jobId,
    acquiredAtMs: input.nowMs
  })
  if (!acquired) {
    throw new Error(
      `workspace.single_writer: failed to acquire lease for ${input.workspaceId}`
    )
  }

  const completedIds = new Set(
    input.tasks.filter((t) => t.status === 'completed' || t.status === 'skipped').map((t) => t.task.id)
  )

  const ready = input.tasks.filter(
    (t) =>
      t.status === 'pending' &&
      t.jobId === input.jobId &&
      isTaskReady(t.task, completedIds)
  )

  return { ready, leaseAcquired: true }
}
