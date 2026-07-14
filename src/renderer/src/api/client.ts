import { authHeaders } from '@renderer/auth/token'
import {
  handleUnauthorizedApiError,
  shouldClearSessionOnApiError
} from '@renderer/auth/sessionRedirect'
import type { ApiResponse } from './types'

/**
 * Separates HTTP status from business error code (CR6 / D18).
 * - httpStatus: transport status from the Response
 * - code: domain/business code from the API body (e.g. job.revision_conflict)
 */
export class ApiError extends Error {
  readonly status: number
  readonly httpStatus: number
  readonly code: string
  readonly data: unknown

  constructor(message: string, httpStatus: number, data: unknown, code?: string) {
    super(message)
    this.status = httpStatus
    this.httpStatus = httpStatus
    this.code = code ?? extractBusinessCode(data, message)
    this.data = data
  }
}

function extractBusinessCode(data: unknown, message: string): string {
  if (data !== null && typeof data === 'object' && 'code' in data) {
    const code = (data as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) {
      return code
    }
  }
  // V3 CommandError maps `code` into ApiResponse.message
  if (/^[a-z][a-z0-9_.]*$/.test(message)) {
    return message
  }
  return message
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...authHeaders(),
    ...init.headers
  }

  const res = await fetch(path, { ...init, headers })
  const raw = await res.text()
  let body: ApiResponse<T>
  try {
    body = (raw ? JSON.parse(raw) : {}) as ApiResponse<T>
  } catch {
    throw new ApiError(raw || `request failed with HTTP ${res.status}`, res.status, { raw })
  }

  if (typeof body.success !== 'boolean') {
    throw new ApiError(raw || 'invalid API response', res.status, body)
  }

  if (!res.ok || !body.success) {
    const apiStatus = typeof body.status === 'number' ? body.status : res.status
    const message = body.message || `request failed with HTTP ${res.status}`
    if (shouldClearSessionOnApiError(res.status, apiStatus, message, body.data)) {
      handleUnauthorizedApiError()
    }
    throw new ApiError(message, res.status, body.data, message)
  }

  return body
}
