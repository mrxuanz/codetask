/**
 * Execution jobs HTTP client — canonical `/api/jobs` surface.
 */
import type {
  JobCommandBody,
  JobCommandResult,
  JobDetail,
  JobListResult,
  JobTreeDto
} from '@codetask/contracts'
import { randomUUID } from '@renderer/lib/id'
import { api } from './client'
import type { ApiSuccess } from './types'

/** UI job view: Execution JobDetail. Use `.state` (not a deprecated `.status` alias). */
export type ExecutionJob = JobDetail & { tree?: JobTreeDto }

export interface JobsApi {
  fetchJobs(
    status?: string,
    page?: number,
    limit?: number,
    q?: string
  ): Promise<ApiSuccess<{ jobs: ExecutionJob[]; total: number; page: number; limit: number }>>
  fetchJob(jobId: string): Promise<ApiSuccess<{ job: ExecutionJob }>>
  pause(
    jobId: string,
    expectedRevision: number,
    idempotencyKey?: string
  ): Promise<ApiSuccess<{ job: ExecutionJob }>>
  continue(
    jobId: string,
    expectedRevision: number,
    idempotencyKey?: string,
    authorizeReplay?: boolean
  ): Promise<ApiSuccess<{ job: ExecutionJob }>>
  cancel(
    jobId: string,
    expectedRevision: number,
    idempotencyKey?: string
  ): Promise<ApiSuccess<{ job: ExecutionJob }>>
  restartExecution(
    jobId: string,
    expectedRevision: number,
    idempotencyKey?: string
  ): Promise<ApiSuccess<{ job: ExecutionJob }>>
  delete?(
    jobId: string,
    expectedRevision: number,
    idempotencyKey?: string
  ): Promise<ApiSuccess<JobCommandResult>>
}

export function newIdempotencyKey(): string {
  return randomUUID()
}

function commandBody(
  expectedRevision: number,
  idempotencyKey?: string,
  authorizeReplay?: boolean
): JobCommandBody {
  const body: JobCommandBody = {
    expectedRevision,
    idempotencyKey: idempotencyKey ?? newIdempotencyKey()
  }
  if (authorizeReplay !== undefined) {
    body.authorizeReplay = authorizeReplay
  }
  return body
}

async function refetchExecutionJob(jobId: string): Promise<ApiSuccess<{ job: ExecutionJob }>> {
  const encodedJobId = encodeURIComponent(jobId)
  const [res, treeRes] = await Promise.all([
    api<JobDetail>(`/api/jobs/${encodedJobId}`),
    api<JobTreeDto>(`/api/jobs/${encodedJobId}/tree`)
  ])
  return {
    ...res,
    data: { job: { ...res.data, tree: treeRes.data } }
  }
}

export function createExecutionJobsApi(): JobsApi {
  return {
    fetchJobs: async (status = 'all', page = 1, limit = 50, q = '') => {
      const params = new URLSearchParams({
        status,
        page: String(page),
        limit: String(limit)
      })
      if (q.trim()) params.set('q', q.trim())
      const res = await api<JobListResult>(`/api/jobs?${params.toString()}`)
      return {
        ...res,
        data: {
          jobs: res.data.jobs,
          total: res.data.total,
          page: res.data.page,
          limit: res.data.limit
        }
      }
    },
    fetchJob: refetchExecutionJob,
    pause: async (jobId, expectedRevision, idempotencyKey) => {
      await api<JobCommandResult>(`/api/jobs/${encodeURIComponent(jobId)}/pause`, {
        method: 'POST',
        body: JSON.stringify(commandBody(expectedRevision, idempotencyKey))
      })
      return refetchExecutionJob(jobId)
    },
    continue: async (jobId, expectedRevision, idempotencyKey, authorizeReplay) => {
      await api<JobCommandResult>(`/api/jobs/${encodeURIComponent(jobId)}/continue`, {
        method: 'POST',
        body: JSON.stringify(commandBody(expectedRevision, idempotencyKey, authorizeReplay))
      })
      return refetchExecutionJob(jobId)
    },
    cancel: async (jobId, expectedRevision, idempotencyKey) => {
      await api<JobCommandResult>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        body: JSON.stringify(commandBody(expectedRevision, idempotencyKey))
      })
      return refetchExecutionJob(jobId)
    },
    restartExecution: async (jobId, expectedRevision, idempotencyKey) => {
      await api<JobCommandResult>(`/api/jobs/${encodeURIComponent(jobId)}/restart`, {
        method: 'POST',
        body: JSON.stringify(commandBody(expectedRevision, idempotencyKey))
      })
      return refetchExecutionJob(jobId)
    },
    delete: async (jobId, expectedRevision, idempotencyKey) => {
      return api<JobCommandResult>(`/api/jobs/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        body: JSON.stringify(commandBody(expectedRevision, idempotencyKey))
      })
    }
  }
}

export function resolveJobsApi(): JobsApi {
  return createExecutionJobsApi()
}
