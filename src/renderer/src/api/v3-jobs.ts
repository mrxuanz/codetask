/**
 * Control-plane V3 jobs HTTP client (C12).
 * Commands require If-Match (revision) and Idempotency-Key.
 */
import { authHeaders } from '@renderer/auth/token'
import { api } from './client'
import type { ApiResponse } from './types'
import type { ThreadJob } from './jobs'

export interface V3JobDto {
  readonly id: string
  readonly threadId: string
  readonly projectId: string
  readonly state: string
  readonly stateRevision: number
  readonly availableActions: readonly string[]
  readonly controlIntent?: string
  readonly resumeTarget?: string | null
  readonly lastFailureId?: string | null
}

export interface V3TaskJobDto extends ThreadJob {
  readonly state?: string
  readonly projectId?: string
  readonly controlIntent?: string
  readonly resumeTarget?: string | null
  readonly currentPlanRevision?: number | null
  readonly executionGeneration?: number
  readonly activeRunId?: string | null
  readonly lastFailureId?: string | null
  readonly createdAtMs?: number
  readonly updatedAtMs?: number
  readonly terminalAtMs?: number | null
}

function commandHeaders(expectedRevision: number, idempotencyKey: string): HeadersInit {
  return {
    ...authHeaders(),
    'If-Match': `"${expectedRevision}"`,
    'Idempotency-Key': idempotencyKey
  }
}

function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

export function fetchV3Jobs(
  status = 'all',
  page = 1,
  limit = 50,
  q = ''
): Promise<ApiResponse<{ jobs: V3TaskJobDto[]; total: number }>> {
  const params = new URLSearchParams({
    status,
    page: String(page),
    limit: String(limit)
  })
  if (q.trim()) params.set('q', q.trim())
  return api<{ jobs: V3TaskJobDto[]; total: number }>(`/api/v3/jobs?${params.toString()}`)
}

export function fetchV3Job(jobId: string): Promise<ApiResponse<{ job: V3TaskJobDto }>> {
  return api<{ job: V3TaskJobDto }>(`/api/v3/jobs/${jobId}`)
}

export function pauseV3Job(
  jobId: string,
  expectedRevision: number
): Promise<ApiResponse<{ job: V3JobDto }>> {
  return api<{ job: V3JobDto }>(`/api/v3/jobs/${jobId}/pause`, {
    method: 'POST',
    headers: commandHeaders(expectedRevision, newIdempotencyKey())
  })
}

export function continueV3Job(
  jobId: string,
  expectedRevision: number
): Promise<ApiResponse<{ job: V3JobDto }>> {
  return api<{ job: V3JobDto }>(`/api/v3/jobs/${jobId}/continue`, {
    method: 'POST',
    headers: commandHeaders(expectedRevision, newIdempotencyKey())
  })
}

export function cancelV3Job(
  jobId: string,
  expectedRevision: number,
  reasonCode = 'user_cancelled'
): Promise<ApiResponse<{ job: V3JobDto }>> {
  return api<{ job: V3JobDto }>(`/api/v3/jobs/${jobId}/cancel`, {
    method: 'POST',
    headers: commandHeaders(expectedRevision, newIdempotencyKey()),
    body: JSON.stringify({ reasonCode })
  })
}

export function restartExecutionV3Job(
  jobId: string,
  expectedRevision: number
): Promise<ApiResponse<{ job: V3JobDto }>> {
  return api<{ job: V3JobDto }>(`/api/v3/jobs/${jobId}/restart-execution`, {
    method: 'POST',
    headers: commandHeaders(expectedRevision, newIdempotencyKey())
  })
}
