import { Type, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { authHeaders } from '@renderer/auth/token'
import {
  handleUnauthorizedApiError,
  shouldClearSessionOnApiError
} from '@renderer/auth/sessionRedirect'
import type { ApiResponse, ApiSuccess } from './types'

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
  readonly requestId: string | undefined
  readonly details: Record<string, unknown> | undefined
  readonly retryable: boolean

  constructor(
    message: string,
    httpStatus: number,
    data: unknown,
    code?: string,
    extras?: { requestId?: string; details?: Record<string, unknown>; retryable?: boolean }
  ) {
    super(message)
    this.status = httpStatus
    this.httpStatus = httpStatus
    this.code = code ?? extractBusinessCode(data, message)
    this.data = data
    this.requestId = extras?.requestId
    this.details = extras?.details
    this.retryable = extras?.retryable ?? httpStatus >= 500
  }
}

const WireApiResponseSchema = Type.Object({
  success: Type.Boolean(),
  data: Type.Optional(Type.Unknown()),
  requestId: Type.String(),
  error: Type.Optional(
    Type.Object({
      code: Type.String(),
      message: Type.String(),
      details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      retryable: Type.Optional(Type.Boolean())
    })
  )
})

function extractBusinessCode(data: unknown, message: string): string {
  if (data !== null && typeof data === 'object') {
    const record = data as { code?: unknown; turnErrorCode?: unknown }
    if (typeof record.code === 'string' && record.code.length > 0) {
      return record.code
    }
    if (typeof record.turnErrorCode === 'string' && record.turnErrorCode.length > 0) {
      return record.turnErrorCode
    }
  }
  if (/^[a-z][a-z0-9_.]*$/.test(message)) {
    return message
  }
  return message
}

export type ApiCallOptions = RequestInit & {
  /** Optional TypeBox schema for runtime validation of `data`. */
  schema?: TSchema
}

/**
 * Fetch JSON API. Throws ApiError on transport/business failure.
 * On success, returns ApiSuccess only (callers may freely use `.data`).
 */
export async function api<T>(path: string, init: ApiCallOptions = {}): Promise<ApiSuccess<T>> {
  const { schema, ...requestInit } = init
  const headers = new Headers(requestInit.headers)
  for (const [name, value] of Object.entries(authHeaders() as Record<string, string>)) {
    headers.set(name, value)
  }
  if (
    requestInit.body !== undefined &&
    !(requestInit.body instanceof FormData) &&
    !headers.has('Content-Type')
  ) {
    headers.set('Content-Type', 'application/json')
  }
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json')
  }

  const res = await fetch(path, { ...requestInit, headers, credentials: 'same-origin' })
  const raw = await res.text()
  let parsed: unknown
  try {
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    throw new ApiError(raw || `request failed with HTTP ${res.status}`, res.status, { raw })
  }

  if (!Value.Check(WireApiResponseSchema, parsed)) {
    throw new ApiError(raw || 'invalid API response', res.status, parsed, 'api.invalid_response')
  }

  const body = parsed as ApiResponse<T>

  if (!res.ok || !body.success) {
    const failure = body.success ? null : body
    const message = failure?.error.message || `request failed with HTTP ${res.status}`
    const code = failure?.error.code || extractBusinessCode(failure?.error.details, message)
    if (shouldClearSessionOnApiError(res.status, res.status, message, failure?.error.details)) {
      handleUnauthorizedApiError()
    }
    throw new ApiError(message, res.status, failure?.error.details ?? failure?.error, code, {
      requestId: body.requestId,
      details: failure?.error.details,
      retryable: (failure?.error as { retryable?: boolean } | undefined)?.retryable
    })
  }

  if (schema && !Value.Check(schema, body.data)) {
    throw new ApiError(
      'API response failed schema validation',
      res.status,
      body.data,
      'api.schema_mismatch',
      { requestId: body.requestId }
    )
  }

  return body
}
