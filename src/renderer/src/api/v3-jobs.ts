/**
 * Control-plane V3 jobs HTTP client (C12).
 * Commands require If-Match (revision) and Idempotency-Key.
 */
import { authHeaders } from '@renderer/auth/token'
import { api } from './client'
import type { ApiResponse } from './types'

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

export function fetchV3Jobs(): Promise<ApiResponse<{ jobs: V3JobDto[] }>> {
  return api<{ jobs: V3JobDto[] }>('/api/v3/jobs')
}

export function fetchV3Job(jobId: string): Promise<ApiResponse<{ job: V3JobDto }>> {
  return api<{ job: V3JobDto }>(`/api/v3/jobs/${jobId}`)
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
