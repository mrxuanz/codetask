/**
 * HTTP response helpers — pure ApiSuccess / ApiFailure (Batch R4).
 */
import type { ApiFailure, ApiSuccess } from '@codetask/contracts'

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure

export function ok<T>(data: T, requestId = 'local'): ApiSuccess<T> {
  return {
    success: true,
    data,
    requestId
  }
}

export function fail(
  code: number | string,
  message: string,
  details: Record<string, unknown> = {},
  requestId = 'local'
): ApiFailure {
  return {
    success: false,
    error: {
      code: String(code),
      message,
      ...(Object.keys(details).length > 0 ? { details } : {})
    },
    requestId
  }
}

export type { ApiSuccess, ApiFailure }
