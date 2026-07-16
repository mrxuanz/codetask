import { getAppContext } from '../bootstrap'
import { memoryDebug } from '../debug/memory'
import { isTerminalJobStatus } from '../runtime/cleanup'
import { scheduleRuntimeCleanup } from '../runtime/cleanup-coordinator'
import { releaseJobCursorResources } from '../sandbox'
import { getUserJob } from './repository'
import { emitJobSnapshot } from './progress-emit'
import type { ThreadJobDto } from './types'

export interface FinalizeJobExecutionInput {
  username: string
  jobId: string

  emitSnapshot?: boolean
}

export async function finalizeJobExecution(
  input: FinalizeJobExecutionInput
): Promise<ThreadJobDto | null> {
  const { username, jobId, emitSnapshot = false } = input
  const ctx = getAppContext()

  await releaseJobCursorResources(jobId).catch((error) => {
    console.warn('[jobs] releaseJobCursorResources failed', jobId, error)
  })

  ctx.executionRuntime.dropRuntime(jobId)

  const job = await getUserJob(username, jobId)
  if (job && isTerminalJobStatus(job.status)) {
    const result = await scheduleRuntimeCleanup({
      dataDir: ctx.dataDir,
      threadId: job.threadId,
      jobId,
      status: job.status,
      reason: 'finalizeJobExecution'
    })
    // Slot may still be held until finishExecutionRunLifecycle releases it; that path retries.
    if (result === 'deferred_active' || result === 'deferred_slot') {
      memoryDebug('finalizeJobExecution cleanup deferred', { jobId, result })
    }
  }

  memoryDebug('finalizeJobExecution', { jobId, status: job?.status, emitSnapshot })

  if (emitSnapshot && job) {
    emitJobSnapshot(jobId, job)
  }

  return job
}
