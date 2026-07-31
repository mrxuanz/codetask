import type { ThreadJobDto } from './contracts/jobs.ts'
import { coerceTurnErrorField } from './turn-errors/storage.ts'
import { deriveJobRecoveryState } from './job-recovery-state.ts'

export function isRecoverableWorkflowBlock(lastError: ThreadJobDto['lastError']): boolean {
  if (!lastError) return false
  const dto = typeof lastError === 'object' ? lastError : coerceTurnErrorField(lastError)
  return dto?.code === 'workflow.deadlock'
}

export function canContinueJob(
  job: Pick<ThreadJobDto, 'status' | 'lastError' | 'taskProgress'>
): boolean {
  return deriveJobRecoveryState(job).recovery.recoverable && job.status === 'failed'
}

export function canRestartJob(status: string | null | undefined): boolean {
  return Boolean(status && ['failed', 'cancelled', 'paused', 'pausing'].includes(status))
}
