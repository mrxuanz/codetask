import type { JobSseEvent } from './types'
import type { TaskProgressDto, ThreadJobDto } from './types'
import { getAppContext } from '../bootstrap'
import { slimJobForSse, slimTaskProgressForSse } from './progress-sse'

export type JobProgressEmitMode = 'delta' | 'snapshot' | 'terminal'

function bus(): import('../context/event-bus').JobEventBus {
  return getAppContext().eventBus
}

export function emitJobSseEvent(jobId: string, event: JobSseEvent): void {
  bus().emit(`job:${jobId}`, event)
}

export function emitTaskProgressDelta(jobId: string, taskProgress: TaskProgressDto): void {
  emitJobSseEvent(jobId, {
    event: 'task_progress',
    data: { taskProgress: slimTaskProgressForSse(taskProgress) }
  })
}

export function emitJobSnapshot(jobId: string, job: ThreadJobDto): void {
  emitJobSseEvent(jobId, { event: 'job_snapshot', data: { job: slimJobForSse(job) } })
}

export function emitJobDone(jobId: string, job: ThreadJobDto): void {
  emitJobSseEvent(jobId, { event: 'job_done', data: { job: slimJobForSse(job) } })
}

export function emitJobError(
  jobId: string,
  error: import('../../shared/contracts/turn-errors').TurnErrorDto
): void {
  emitJobSseEvent(jobId, { event: 'error', data: { error, message: error.message } })
}

export function emitJobProgressAfterPersist(
  jobId: string,
  mode: JobProgressEmitMode,
  input: { taskProgress: TaskProgressDto; job: ThreadJobDto | null }
): JobSseEvent[] {
  const sent: JobSseEvent[] = []
  if (!input.job) return sent

  const delta: JobSseEvent = {
    event: 'task_progress',
    data: { taskProgress: slimTaskProgressForSse(input.taskProgress) }
  }
  emitJobSseEvent(jobId, delta)
  sent.push(delta)

  if (mode === 'snapshot' || mode === 'terminal') {
    const snapshot: JobSseEvent = {
      event: 'job_snapshot',
      data: { job: slimJobForSse(input.job) }
    }
    emitJobSseEvent(jobId, snapshot)
    sent.push(snapshot)
  }

  if (mode === 'terminal') {
    const done: JobSseEvent = { event: 'job_done', data: { job: slimJobForSse(input.job) } }
    emitJobSseEvent(jobId, done)
    sent.push(done)
  }

  return sent
}
