export interface TaskCheckpointInput {
  readonly jobId: string
  readonly executionGeneration: number
  readonly taskId: string
  readonly expectedState: string
  readonly nextState: string
}

export function updateTaskState(
  updateFn: (input: TaskCheckpointInput) => boolean,
  input: TaskCheckpointInput
): { readonly ok: boolean; readonly error?: string } {
  const changes = updateFn(input)

  if (!changes) {
    return { ok: false, error: 'task.state_conflict' }
  }

  return { ok: true }
}

/**
 * SQL for updating task state with optimistic locking:
 *
 * UPDATE control_job_tasks
 * SET state = :next_state, updated_at_ms = :now
 * WHERE job_id = :job_id
 *   AND execution_generation = :generation
 *   AND task_id = :task_id
 *   AND state = :expected_state
 *
 * changes must be 1. If 0, return task conflict and rollback checkpoint.
 */
export const UPDATE_TASK_STATE_SQL = `
UPDATE control_job_tasks
SET state = :next_state, updated_at_ms = :now
WHERE job_id = :job_id
  AND execution_generation = :generation
  AND task_id = :task_id
  AND state = :expected_state
`
