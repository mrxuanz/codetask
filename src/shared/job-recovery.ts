import type { TaskProgressItemDto, ThreadJobDto } from './contracts/jobs.ts'
import { coerceTurnErrorField } from './turn-errors/storage.ts'
import { deriveJobRecoveryState } from './job-recovery-state.ts'

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
  return Boolean(status && ['failed', 'cancelled', 'paused', 'pausing'].includes(status))
}

/** @deprecated Retry-subtask was removed; continue covers breakpoint resume. */
export function canRetryTaskItem(
  _job: Pick<ThreadJobDto, 'status' | 'availableActions'>,
  _task: Pick<TaskProgressItemDto, 'status' | 'executionStatus'>
): boolean {
  return false
}

export function findRetryableTaskId(
  job: Pick<ThreadJobDto, 'status' | 'taskProgress' | 'recovery'>
): string | null {
  return job.recovery?.failedTaskId ?? null
}
