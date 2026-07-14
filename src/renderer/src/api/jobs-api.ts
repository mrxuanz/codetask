/**
 * Jobs API selection — chosen once at app start from control-plane generation.
 */
import type { ApiResponse } from './types'
import type { ThreadJob } from './jobs'
import {
  continueJob,
  deleteJob,
  fetchJob,
  fetchJobs,
  pauseJob,
  restartJob,
  type ThreadJobDto
} from './jobs'
import { api } from './client'
import {
  fetchV3Jobs,
  fetchV3Job,
  pauseV3Job,
  continueV3Job,
  cancelV3Job,
  restartExecutionV3Job,
  newIdempotencyKey,
  type V3JobDto,
  type V3TaskJobDto
} from './v3-jobs'
import { fetchControlPlaneGeneration } from './control-plane-generation'

export interface JobsApi {
  fetchJobs(
    status?: string,
    page?: number,
    limit?: number,
    q?: string
  ): Promise<ApiResponse<{ jobs: V3TaskJobDto[]; total: number }>>
  fetchJob(jobId: string): Promise<ApiResponse<{ job: V3TaskJobDto }>>
  pause(
    jobId: string,
    expectedRevision: number,
    idempotencyKey?: string
  ): Promise<ApiResponse<{ job: V3JobDto }>>
  continue(
    jobId: string,
    expectedRevision: number,
    idempotencyKey?: string
  ): Promise<ApiResponse<{ job: V3JobDto }>>
  cancel(
    jobId: string,
    expectedRevision: number,
    reasonCode?: string,
    idempotencyKey?: string
  ): Promise<ApiResponse<{ job: V3JobDto }>>
  restartExecution(
    jobId: string,
    expectedRevision: number,
    idempotencyKey?: string
  ): Promise<ApiResponse<{ job: V3JobDto }>>
  delete?(jobId: string): Promise<ApiResponse<{ deleted: boolean }>>
}

function asV3Job(job: ThreadJobDto | ThreadJob): V3JobDto {
  return {
    id: job.id,
    threadId: job.threadId,
    projectId: (job as ThreadJob & { projectId?: string }).projectId ?? '',
    state: (job as ThreadJob & { state?: string }).state ?? job.status,
    stateRevision: job.stateRevision ?? 0,
    availableActions: job.availableActions ?? []
  }
}

export function createV3JobsApi(): JobsApi {
  return {
    fetchJobs: fetchV3Jobs,
    fetchJob: fetchV3Job,
    pause: pauseV3Job,
    continue: continueV3Job,
    cancel: cancelV3Job,
    restartExecution: restartExecutionV3Job
  }
}

/** Legacy jobs API for preparing/copied — ignores revision/idempotency headers. */
export function createLegacyJobsApi(): JobsApi {
  return {
    fetchJobs: async (status = 'all', page = 1, limit = 50, q = '') => {
      const res = await fetchJobs(status, page, limit, q)
      return {
        ...res,
        data: {
          jobs: res.data.jobs as V3TaskJobDto[],
          total: res.data.total
        }
      }
    },
    fetchJob: async (jobId) => {
      const res = await fetchJob(jobId)
      return {
        ...res,
        data: { job: res.data.job as V3TaskJobDto }
      }
    },
    pause: async (jobId) => {
      const res = await pauseJob(jobId)
      return { ...res, data: { job: asV3Job(res.data.job) } }
    },
    continue: async (jobId) => {
      const res = await continueJob(jobId)
      return { ...res, data: { job: asV3Job(res.data.job) } }
    },
    cancel: async (jobId) => {
      const res = await api<{ job: ThreadJobDto }>(`/api/jobs/${jobId}/cancel`, {
        method: 'POST'
      })
      return { ...res, data: { job: asV3Job(res.data.job) } }
    },
    restartExecution: async (jobId) => {
      const res = await restartJob(jobId)
      return { ...res, data: { job: asV3Job(res.data.job) } }
    },
    delete: async (jobId) => deleteJob(jobId)
  }
}

export async function resolveJobsApi(): Promise<JobsApi> {
  const generation = await fetchControlPlaneGeneration()
  return generation === 'v3_authoritative' ? createV3JobsApi() : createLegacyJobsApi()
}

export { newIdempotencyKey, type ThreadJob, type V3JobDto, type V3TaskJobDto }
