import type { TaskProgressItemDto, ThreadJobDto } from './contracts/jobs.ts'
import { coerceTurnErrorField } from './turn-errors/storage.ts'
import { deriveJobRecoveryState, jobHasAction } from './job-recovery-state.ts'

export function isRecoverableWorkflowBlock(lastError: ThreadJobDto['lastError']): boolean {
  if (!lastError) return false
  const dto = typeof lastError === 'object' ? lastError : coerceTurnErrorField(lastError)
  return dto?.code === 'workflow.deadlock'
}

export function isRecoverableJobFailure(): boolean {
  return false
}

export function canContinueJob(
  job: Pick<ThreadJobDto, 'status' | 'lastError' | 'taskProgress'>
): boolean {
  return deriveJobRecoveryState(job).recovery.recoverable && job.status === 'failed'
}

export function canRestartJob(status: string | null | undefined): boolean {
  return Boolean(status && ['failed', 'cancelled', 'paused'].includes(status))
}

export function canRetryTaskItem(
  job: Pick<ThreadJobDto, 'status' | 'availableActions'>,
  task: Pick<TaskProgressItemDto, 'status' | 'executionStatus'>
): boolean {
  if (jobHasAction(job, 'retry_failed_task')) {
    if (task.status === 'failed') return true
    return task.executionStatus === 'retry-queued' || task.executionStatus === 'waiting-on-repair'
  }
  if (['running', 'pending', 'planning'].includes(job.status)) return false
  if (task.status === 'failed') return true
  return task.executionStatus === 'retry-queued' || task.executionStatus === 'waiting-on-repair'
}

export function findRetryableTaskId(
  job: Pick<ThreadJobDto, 'status' | 'taskProgress' | 'recovery'>
): string | null {
  return job.recovery?.failedTaskId ?? null
}
