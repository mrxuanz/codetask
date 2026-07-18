import type { ThreadJobDto } from './types'
import { prepareInterruptedExecutionResume } from './execution-recovery'
import { updateJobRowForSnapshot } from './repository'

export { isExecutionInfraNotReadyError } from './execution-infra-errors'

export async function revertJobAfterInfraStartupFailure(
  jobId: string,
  existing: ThreadJobDto | null
): Promise<ThreadJobDto | null> {
  const taskProgress = existing?.taskProgress
    ? prepareInterruptedExecutionResume(existing.taskProgress).progress
    : undefined

  const hadStarted =
    taskProgress?.tasks.some(
      (task) => task.status !== 'queued' || task.executionStatus !== 'queued'
    ) ?? false

  return updateJobRowForSnapshot(jobId, {
    status: hadStarted ? 'paused' : 'pending',
    lastError: null,
    ...(taskProgress ? { taskProgress } : {})
  })
}
