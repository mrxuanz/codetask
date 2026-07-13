import { getAppContext } from '../bootstrap'
import { memoryDebug } from '../debug/memory'
import { cleanupJobRuntimeTreeIfTerminal, isTerminalJobStatus } from '../runtime/cleanup'
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
    await cleanupJobRuntimeTreeIfTerminal(ctx.dataDir, job.threadId, jobId, job.status).catch(
      (error) => {
        console.warn('[jobs] cleanupJobRuntimeTreeIfTerminal failed', jobId, error)
      }
    )
  }

  memoryDebug('finalizeJobExecution', { jobId, status: job?.status, emitSnapshot })

  if (emitSnapshot && job) {
    emitJobSnapshot(jobId, job)
  }

  return job
}
