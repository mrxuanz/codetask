/**
 * HTTP route wrapper — Route does **only four duties** (重构.md §11.1):
 *
 * 1. **Auth boundary** — authenticate the caller; reject unauthenticated requests.
 * 2. **Schema parse** — validate/parse input (params/query/body/headers).
 * 3. **Call command/query** — invoke application Command or Query; no SQL / SM / Provider.
 * 4. **Map DTO/error** — map CommandResult / ApplicationError to HTTP envelope.
 *
 * Routes must not: write tables, migrate state, call Providers, build prompts,
 * run recovery, or generate SSE events.
 */
import type { ApplicationError, CommandResult, QueryResult } from '../../core/application/results'

/** Numeric API status codes aligned with docs/refactor/fixtures/api/error-codes.md */
export const apiStatus = {
  OK: 0,
  BAD_REQUEST: 40001,
  UNAUTHORIZED: 40101,
  NOT_FOUND: 40401,
  CONFLICT: 40901,
  GONE: 41001,
  INTERNAL: 50001
} as const

export type ApiStatusCode = (typeof apiStatus)[keyof typeof apiStatus]

export type HttpRequest = {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly params?: Readonly<Record<string, string | undefined>>
  readonly query?: Readonly<Record<string, string | undefined>>
  readonly body?: unknown
}

export type HttpSuccess<T> = {
  readonly ok: true
  readonly httpStatus: number
  readonly body: {
    readonly success: true
    readonly status: typeof apiStatus.OK
    readonly message: 'success'
    readonly data: T
    readonly extra: Record<string, never>
  }
  readonly headers?: Readonly<Record<string, string>>
}

export type HttpFailure = {
  readonly ok: false
  readonly httpStatus: number
  readonly body: {
    readonly success: false
    readonly status: ApiStatusCode
    readonly message: string
    readonly data: {
      readonly error: string
      readonly turnErrorCode?: string
      readonly turnErrorParams?: Readonly<Record<string, unknown>>
    }
    readonly extra: Record<string, never>
  }
  readonly headers?: Readonly<Record<string, string>>
}

export type HttpResult<T> = HttpSuccess<T> | HttpFailure

export type AuthContext = {
  readonly username: string
  readonly requestId: string
}

export class RouteAuthError extends Error {
  readonly code = 'auth.unauthorized' as const
  constructor(message = 'Not signed in') {
    super(message)
    this.name = 'RouteAuthError'
  }
}

export class RouteSchemaError extends Error {
  readonly code = 'contract.invalid_payload' as const
  constructor(
    message = 'Invalid payload',
    readonly field?: string
  ) {
    super(message)
    this.name = 'RouteSchemaError'
  }
}

/**
 * Duty 1 — Auth boundary stub.
 * Production composition may replace with real session verification.
 */
export function assertAuthBoundary(headers: HttpRequest['headers']): AuthContext {
  const authorization = headers.authorization ?? headers.Authorization
  if (!authorization || !authorization.trim()) {
    throw new RouteAuthError()
  }
  const token = authorization.replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    throw new RouteAuthError()
  }
  const requestId = headers['x-request-id'] ?? headers['X-Request-Id'] ?? 'req-stub'
  // Stub: treat non-empty bearer token as authenticated username placeholder.
  return { username: token === '<session-token>' ? 'demo' : token.slice(0, 64), requestId }
}

/**
 * Duty 2 — Schema parse stub.
 * Callers supply a narrow parser; this wrapper only enforces “parser ran”.
 */
export function parseSchema<T>(
  parse: () => T
): T {
  try {
    return parse()
  } catch (error: unknown) {
    if (error instanceof RouteSchemaError) throw error
    const message = error instanceof Error ? error.message : 'Invalid payload'
    throw new RouteSchemaError(message)
  }
}

/** Read Idempotency-Key (or idempotency-key) from headers. */
export function readIdempotencyKey(headers: HttpRequest['headers']): string | undefined {
  const raw =
    headers['idempotency-key'] ??
    headers['Idempotency-Key'] ??
    headers.idempotencyKey
  if (raw === undefined || raw === null) return undefined
  const key = String(raw).trim()
  return key.length > 0 ? key : undefined
}

/** Require Idempotency-Key for mutating commands. */
export function requireIdempotencyKey(headers: HttpRequest['headers']): string {
  const key = readIdempotencyKey(headers)
  if (!key) {
    throw new RouteSchemaError('Idempotency-Key header is required', 'Idempotency-Key')
  }
  return key
}

export function mapErrorCodeToHttp(code: string): {
  readonly httpStatus: number
  readonly status: ApiStatusCode
} {
  if (code === 'auth.unauthorized' || code.startsWith('auth.')) {
    return { httpStatus: 401, status: apiStatus.UNAUTHORIZED }
  }
  if (
    code.endsWith('.not_found') ||
    code === 'job.not_found' ||
    code === 'draft.not_found' ||
    code === 'plan.not_found' ||
    code === 'thread.not_found'
  ) {
    return { httpStatus: 404, status: apiStatus.NOT_FOUND }
  }
  if (
    code === 'revision.conflict' ||
    code === 'job.revision_conflict' ||
    code === 'idempotency.conflict' ||
    code === 'idempotency_key_reused' ||
    code === 'job.action_not_allowed' ||
    code === 'plan.confirm_conflict' ||
    code === 'draft.conflict'
  ) {
    return { httpStatus: 409, status: apiStatus.CONFLICT }
  }
  if (code === 'api.legacy_blocked' || code.endsWith('.gone')) {
    return { httpStatus: 410, status: apiStatus.GONE }
  }
  if (code === 'contract.invalid_payload' || code.includes('invalid') || code.endsWith('.not_confirmed')) {
    return { httpStatus: 400, status: apiStatus.BAD_REQUEST }
  }
  return { httpStatus: 400, status: apiStatus.BAD_REQUEST }
}

/**
 * Duty 4 — Map ApplicationError → legacy HTTP failure envelope.
 */
export function mapApplicationError(error: ApplicationError): HttpFailure {
  const mapped = mapErrorCodeToHttp(error.code)
  return {
    ok: false,
    httpStatus: mapped.httpStatus,
    body: {
      success: false,
      status: mapped.status,
      message: error.message,
      data: {
        error: error.message,
        turnErrorCode: error.code
      },
      extra: {}
    }
  }
}

export function mapThrownRouteError(error: unknown): HttpFailure {
  if (error instanceof RouteAuthError) {
    return mapApplicationError({ code: error.code, message: error.message })
  }
  if (error instanceof RouteSchemaError) {
    return mapApplicationError({ code: error.code, message: error.message })
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    'message' in error &&
    typeof (error as ApplicationError).code === 'string' &&
    typeof (error as ApplicationError).message === 'string'
  ) {
    return mapApplicationError(error as ApplicationError)
  }
  const message = error instanceof Error ? error.message : 'Internal error'
  return {
    ok: false,
    httpStatus: 500,
    body: {
      success: false,
      status: apiStatus.INTERNAL,
      message,
      data: { error: message },
      extra: {}
    }
  }
}

export function mapCommandResult<T>(result: CommandResult<T> | QueryResult<T>): HttpResult<T> {
  if (result.ok) {
    return {
      ok: true,
      httpStatus: 200,
      body: {
        success: true,
        status: apiStatus.OK,
        message: 'success',
        data: result.value,
        extra: {}
      }
    }
  }
  return mapApplicationError(result.error)
}

/**
 * Compose the four duties for a single request.
 * Duty 3 is the `invoke` callback (Command/Query only).
 */
export async function handleRoute<TInput, TOutput>(
  request: HttpRequest,
  options: {
    readonly parse: (auth: AuthContext, request: HttpRequest) => TInput
    readonly invoke: (input: TInput, auth: AuthContext) => Promise<CommandResult<TOutput> | QueryResult<TOutput>>
    readonly mapSuccess?: (value: TOutput) => unknown
  }
): Promise<HttpResult<unknown>> {
  try {
    const auth = assertAuthBoundary(request.headers)
    const input = parseSchema(() => options.parse(auth, request))
    const result = await options.invoke(input, auth)
    if (!result.ok) {
      return mapApplicationError(result.error)
    }
    const data = options.mapSuccess ? options.mapSuccess(result.value) : result.value
    return {
      ok: true,
      httpStatus: 200,
      body: {
        success: true,
        status: apiStatus.OK,
        message: 'success',
        data,
        extra: {}
      }
    }
  } catch (error: unknown) {
    return mapThrownRouteError(error)
  }
}
