import { authHeaders } from '@renderer/auth/token'
import {
  handleUnauthorizedApiError,
  shouldClearSessionOnApiError
} from '@renderer/auth/sessionRedirect'
import type { ApiResponse } from './types'

export class ApiError extends Error {
  status: number
  data: unknown

  constructor(message: string, status: number, data: unknown) {
    super(message)
    this.status = status
    this.data = data
  }
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
    const status = body.status || res.status
    const message = body.message || `request failed with HTTP ${res.status}`
    if (shouldClearSessionOnApiError(res.status, status, message, body.data)) {
      handleUnauthorizedApiError()
    }
    throw new ApiError(message, status, body.data)
  }

  return body
}
