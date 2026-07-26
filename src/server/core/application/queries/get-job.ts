import type { Job } from '../../domain/jobs/types'
import type { JobRepo } from '../ports/repositories'
import { fail, type QueryResult } from '../results'

/**
 * Application-facing job projection (no domain brand leakage to mappers).
 */
export type JobProjection = {
  readonly id: string
  readonly status: Job['status']
  readonly planRevision: number
  readonly executionGeneration: number
  readonly stateRevision: number
  readonly threadId?: string
  readonly draftMessageId?: string
  readonly title?: string
  readonly summary?: string
  readonly createdAt?: number
  readonly updatedAt?: number
}

export function projectJob(
  job: Job,
  extras?: {
    readonly threadId?: string
    readonly draftMessageId?: string
    readonly title?: string
    readonly summary?: string
    readonly createdAt?: number
    readonly updatedAt?: number
  }
): JobProjection {
  return {
    id: job.id,
    status: job.status,
    planRevision: job.planRevision,
    executionGeneration: job.executionGeneration,
    stateRevision: job.stateRevision,
    ...(extras?.threadId !== undefined ? { threadId: extras.threadId } : {}),
    ...(extras?.draftMessageId !== undefined
      ? { draftMessageId: extras.draftMessageId }
      : {}),
    ...(extras?.title !== undefined ? { title: extras.title } : {}),
    ...(extras?.summary !== undefined ? { summary: extras.summary } : {}),
    ...(extras?.createdAt !== undefined ? { createdAt: extras.createdAt } : {}),
    ...(extras?.updatedAt !== undefined ? { updatedAt: extras.updatedAt } : {})
  }
}

export async function getJobQuery(
  deps: { readonly jobs: JobRepo },
  input: { readonly jobId: string }
): Promise<QueryResult<JobProjection>> {
  const job = await deps.jobs.get(input.jobId)
  if (!job) {
    return fail('job.not_found', `Job not found: ${input.jobId}`)
  }
  return { ok: true, value: projectJob(job) }
}
