import type { ApiResponse } from '@shared/contracts/api'

export type { ApiResponse } from '@shared/contracts/api'

export function ok<T>(
  data: T,
  message = 'success',
  extra: Record<string, unknown> = {}
): ApiResponse<T> {
  return {
    data,
    status: 0,
    extra,
    message,
    success: true
  }
}

export function okWithExtra<T>(data: T, extra: Record<string, unknown>): ApiResponse<T> {
  return ok(data, 'success', extra)
}

export function fail<T = null>(
  status: number,
  message: string,
  data: T = null as T,
  extra: Record<string, unknown> = {}
): ApiResponse<T> {
  return {
    data,
    status,
    extra,
    message,
    success: false
  }
}
