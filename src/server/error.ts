import { fail, type ApiResponse } from './response'
import { TURN_ERROR_DEFAULT_MESSAGES } from '@codetask/contracts/turn-errors/codes'

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
  return 500
}

export class AppError extends Error {
  readonly httpStatus: number
  readonly publicMessage: string
  readonly internalCause?: unknown

  constructor(
    public readonly status: number,
    publicMessage: string,
    public readonly data: Record<string, unknown> = { error: publicMessage },
    httpStatus?: number,
    internalCause?: unknown
  ) {
    super(internalCause instanceof Error ? internalCause.message : publicMessage)
    this.name = 'AppError'
    this.publicMessage = publicMessage
    this.internalCause = internalCause
    this.httpStatus = httpStatus ?? HTTP_STATUS_BY_CODE[status] ?? 500
  }

  toResponse(): ApiResponse<Record<string, unknown>> {
    return fail(this.status, this.publicMessage, this.data)
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
    internalCause: unknown,
    turnErrorCode?: string,
    turnErrorParams?: Record<string, unknown>
  ): AppError {
    const publicMessage = 'Internal server error'
    return new AppError(
      code.INTERNAL,
      publicMessage,
      {
        error: publicMessage,
        ...(turnErrorCode ? { turnErrorCode, turnErrorParams } : {})
      },
      500,
      internalCause
    )
  }

  static db(internalCause: unknown): AppError {
    const publicMessage = 'Database operation failed'
    return new AppError(code.DB, publicMessage, { error: publicMessage }, 500, internalCause)
  }
}

export function toErrorResponse(
  error: unknown,
  requestId = 'unknown'
): ApiResponse<Record<string, unknown> | null> {
  if (error instanceof AppError) {
    return fail(error.status, error.publicMessage, error.data, requestId)
  }

  return fail(code.INTERNAL, 'Internal server error', {}, requestId)
}

export function toErrorHttpResult(
  error: unknown,
  requestId = 'unknown'
): {
  body: ApiResponse<Record<string, unknown> | null>
  status: number
} {
  return {
    body: toErrorResponse(error, requestId),
    status: resolveHttpStatus(error)
  }
}
