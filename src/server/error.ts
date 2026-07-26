import { fail, type ApiResponse } from './response'
import { TURN_ERROR_DEFAULT_MESSAGES } from '../shared/turn-errors/codes.ts'
import { AuthError } from './core/domain/auth'
import { AuthSecurityCapacityError } from './core/application/ports'
import { ConversationError } from './core/domain/conversation'
import { DraftError } from './core/domain/draft'

export const code = {
  OK: 0,
  BAD_REQUEST: 40001,
  UNAUTHORIZED: 40101,
  NOT_FOUND: 40401,
  CONFLICT: 40901,
  GONE: 41001,
  INTERNAL: 50001,
  DB: 50002
} as const

const HTTP_STATUS_BY_CODE: Record<number, number> = {
  [code.OK]: 200,
  [code.BAD_REQUEST]: 400,
  [code.UNAUTHORIZED]: 401,
  [code.NOT_FOUND]: 404,
  [code.CONFLICT]: 409,
  [code.GONE]: 410,
  [code.INTERNAL]: 500,
  [code.DB]: 500
}

export function resolveHttpStatus(error: unknown): number {
  if (error instanceof AppError) {
    return error.httpStatus
  }
  if (error instanceof AuthError) {
    if (error.code === 'auth.rate_limited') return 429
    if (
      error.code === 'auth.already_initialized' ||
      error.code === 'auth.setup_required' ||
      error.code === 'auth.password_reused' ||
      error.code === 'auth.concurrent_update'
    ) {
      return 409
    }
    if (
      error.code === 'auth.invalid_credentials' ||
      error.code === 'auth.setup_grant_invalid' ||
      error.code === 'auth.challenge_required' ||
      error.code === 'auth.challenge_invalid' ||
      error.code === 'auth.session_invalid' ||
      error.code === 'auth.current_password_invalid'
    ) {
      return 401
    }
    return 400
  }
  if (error instanceof AuthSecurityCapacityError) return 429
  if (error instanceof ConversationError) {
    if (
      error.code === 'conversation.workspace_not_found' ||
      error.code === 'conversation.thread_not_found' ||
      error.code === 'conversation.turn_not_found'
    ) {
      return 404
    }
    if (
      error.code === 'conversation.workspace_exists' ||
      error.code === 'conversation.turn_in_progress'
    ) {
      return 409
    }
    if (
      error.code === 'conversation.provider_unavailable' ||
      error.code === 'conversation.provider_not_authenticated'
    ) {
      return 503
    }
    return 400
  }
  if (error instanceof DraftError) {
    if (
      error.code === 'draft.not_found' ||
      error.code === 'draft.attachment_not_found' ||
      error.code === 'draft.generation_not_found' ||
      error.code === 'draft.workspace_not_found'
    ) {
      return 404
    }
    if (
      error.code === 'draft.locked' ||
      error.code === 'draft.generation_in_progress' ||
      error.code === 'draft.revision_conflict' ||
      error.code === 'draft.settings_conflict' ||
      error.code === 'draft.confirm_conflict' ||
      error.code === 'draft.tree_not_ready' ||
      error.code === 'draft.tree_stale'
    ) {
      return 409
    }
    if (
      error.code === 'draft.provider_unavailable' ||
      error.code === 'draft.provider_not_authenticated'
    ) {
      return 503
    }
    return 400
  }
  return 500
}

export class AppError extends Error {
  readonly httpStatus: number

  constructor(
    public readonly status: number,
    message: string,
    public readonly data: Record<string, unknown> = { error: message },
    httpStatus?: number
  ) {
    super(message)
    this.name = 'AppError'
    this.httpStatus = httpStatus ?? HTTP_STATUS_BY_CODE[status] ?? 500
  }

  toResponse(): ApiResponse<Record<string, unknown>> {
    return fail(this.status, this.message, this.data)
  }

  static badRequest(
    message: string,
    turnErrorCode?: string,
    turnErrorParams?: Record<string, unknown>
  ): AppError {
    return new AppError(code.BAD_REQUEST, message, {
      error: message,
      ...(turnErrorCode ? { turnErrorCode, turnErrorParams } : {})
    })
  }

  static unauthorized(
    message?: string,
    turnErrorCode?: string,
    turnErrorParams?: Record<string, unknown>
  ): AppError {
    return new AppError(
      code.UNAUTHORIZED,
      message ?? TURN_ERROR_DEFAULT_MESSAGES['auth.unauthorized'],
      {
        error: message ?? TURN_ERROR_DEFAULT_MESSAGES['auth.unauthorized'],
        ...(turnErrorCode ? { turnErrorCode, turnErrorParams } : {})
      }
    )
  }

  static notFound(
    message: string,
    turnErrorCode?: string,
    turnErrorParams?: Record<string, unknown>
  ): AppError {
    return new AppError(code.NOT_FOUND, message, {
      error: message,
      ...(turnErrorCode ? { turnErrorCode, turnErrorParams } : {})
    })
  }

  static gone(
    message: string,
    turnErrorCode?: string,
    turnErrorParams?: Record<string, unknown>
  ): AppError {
    return new AppError(code.GONE, message, {
      error: message,
      ...(turnErrorCode ? { turnErrorCode, turnErrorParams } : {})
    })
  }

  static conflict(
    message: string,
    data?: Record<string, unknown>,
    turnErrorCode?: string,
    turnErrorParams?: Record<string, unknown>
  ): AppError {
    return new AppError(code.CONFLICT, message, {
      error: message,
      ...data,
      ...(turnErrorCode ? { turnErrorCode, turnErrorParams } : {})
    })
  }

  static internal(
    message: string,
    turnErrorCode?: string,
    turnErrorParams?: Record<string, unknown>
  ): AppError {
    return new AppError(code.INTERNAL, message, {
      error: message,
      ...(turnErrorCode ? { turnErrorCode, turnErrorParams } : {})
    })
  }

  static db(message: string): AppError {
    return new AppError(code.DB, message, { error: message })
  }
}

export function toErrorResponse(error: unknown): ApiResponse<Record<string, unknown> | null> {
  if (error instanceof AppError) {
    return error.toResponse()
  }
  if (error instanceof AuthError) {
    const httpStatus = resolveHttpStatus(error)
    const status =
      httpStatus === 401
        ? code.UNAUTHORIZED
        : httpStatus === 409
          ? code.CONFLICT
          : httpStatus === 429
            ? 42901
            : code.BAD_REQUEST
    return fail(status, error.code, { code: error.code, ...error.details })
  }
  if (error instanceof AuthSecurityCapacityError) {
    return fail(42901, 'auth.rate_limited', { code: 'auth.rate_limited', retryAfterMs: 1_000 })
  }
  if (error instanceof ConversationError) {
    const httpStatus = resolveHttpStatus(error)
    const status =
      httpStatus === 404
        ? code.NOT_FOUND
        : httpStatus === 409
          ? code.CONFLICT
          : httpStatus === 503
            ? 50301
            : code.BAD_REQUEST
    return fail(status, error.code, { code: error.code, ...error.details })
  }
  if (error instanceof DraftError) {
    const httpStatus = resolveHttpStatus(error)
    const status =
      httpStatus === 404
        ? code.NOT_FOUND
        : httpStatus === 409
          ? code.CONFLICT
          : httpStatus === 503
            ? 50301
            : code.BAD_REQUEST
    return fail(status, error.code, { code: error.code, ...error.details })
  }

  const message = error instanceof Error ? error.message : 'internal server error'
  return fail(code.INTERNAL, message, { error: message })
}

export function toErrorHttpResult(error: unknown): {
  body: ApiResponse<Record<string, unknown> | null>
  status: number
} {
  return {
    body: toErrorResponse(error),
    status: resolveHttpStatus(error)
  }
}
