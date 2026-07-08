import { and, asc, eq } from 'drizzle-orm'
import { getDb } from '../db'
import { threadJobs } from '../db/schema'
import type { ExecutionQueueDto, ThreadJobDto } from '@shared/contracts/jobs'

export function computeExecutionQueueMeta(
  jobId: string,
  pendingJobIds: readonly string[]
): ExecutionQueueDto | undefined {
  const index = pendingJobIds.indexOf(jobId)
  if (index < 0) return undefined
  return {
    position: index + 1,
    ahead: index
  }
}

export async function listPendingJobIds(username: string): Promise<string[]> {
  const db = getDb()
  const rows = await db
    .select({ id: threadJobs.id })
    .from(threadJobs)
    .where(and(eq(threadJobs.username, username), eq(threadJobs.status, 'pending')))
    .orderBy(asc(threadJobs.createdAt))
  return rows.map((row) => row.id)
}

export async function attachExecutionQueueMeta(
  job: ThreadJobDto,
  username: string,
  pendingJobIds?: string[]
): Promise<ThreadJobDto> {
  if (job.status !== 'pending') return job
  const ids = pendingJobIds ?? (await listPendingJobIds(username))
  const queue = computeExecutionQueueMeta(job.id, ids)
  return queue ? { ...job, queue } : job
}

export async function attachExecutionQueueMetaBatch(
  username: string,
  jobs: ThreadJobDto[]
): Promise<ThreadJobDto[]> {
  const hasPending = jobs.some((job) => job.status === 'pending')
  if (!hasPending) return jobs
  const pendingJobIds = await listPendingJobIds(username)
  return Promise.all(
    jobs.map((job) => attachExecutionQueueMeta(job, username, pendingJobIds))
  )
}
