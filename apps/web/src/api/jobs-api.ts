/**
 * Execution jobs HTTP client — canonical `/api/jobs` surface.
 */
import type {
  JobCommandBody,
  JobCommandResult,
  JobDetail,
  JobState,
  JobSummary
} from '@codetask/contracts'
import { randomUUID } from '@renderer/lib/id'
import { api } from './client'
import type { ApiSuccess } from './types'

/** UI job view: Execution JobDetail. Prefer `.state`; `.status` is a deprecated alias. */
export type ExecutionJob = JobDetail & { /** @deprecated Use state */ status: JobState }

export interface JobsApi {
  fetchJobs(
    status?: string,
    page?: number,
    limit?: number,
    q?: string
  ): Promise<ApiSuccess<{ jobs: ExecutionJob[]; total: number }>>
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
    reasonCode?: string,
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
  ): Promise<ApiSuccess<{ deleted: boolean }>>
}

export function newIdempotencyKey(): string {
  return randomUUID()
}

function mapDetail(detail: JobDetail): ExecutionJob {
  return { ...detail, status: detail.state }
}

function mapSummary(summary: JobSummary): ExecutionJob {
  const createdAt = summary.queuedAt ?? new Date().toISOString()
  const updatedAt = summary.startedAt ?? summary.queuedAt ?? createdAt
  return {
    ...summary,
    status: summary.state,
    sourceDraftId: '',
    sourcePlanningSessionId: '',
    currentRunId: null,
    suspensionKind: null,
    queuePosition: null,
    createdAt,
    updatedAt
  }
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
  const res = await api<JobDetail>(`/api/jobs/${encodeURIComponent(jobId)}`)
  return {
    ...res,
    data: { job: mapDetail(res.data) }
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
      const res = await api<JobSummary[]>(`/api/jobs?${params.toString()}`)
      const jobs = res.data.map(mapSummary)
      return {
        ...res,
        data: { jobs, total: jobs.length }
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
    cancel: async (jobId, expectedRevision, _reasonCode, idempotencyKey) => {
      void _reasonCode
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
      await api(`/api/jobs/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        body: JSON.stringify(commandBody(expectedRevision, idempotencyKey))
      })
      return {
        success: true as const,
        data: { deleted: true },
        requestId: 'client-local'
      }
    }
  }
}

export function resolveJobsApi(): JobsApi {
  return createExecutionJobsApi()
}
