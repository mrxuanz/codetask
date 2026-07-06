import { fail, type ApiResponse } from './response'
import { TURN_ERROR_DEFAULT_MESSAGES } from '../shared/turn-errors/codes.ts'

export const code = {
  OK: 0,
  BAD_REQUEST: 40001,
  UNAUTHORIZED: 40101,
  NOT_FOUND: 40401,
  CONFLICT: 40901,
  INTERNAL: 50001,
  DB: 50002
} as const

const HTTP_STATUS_BY_CODE: Record<number, number> = {
  [code.OK]: 200,
  [code.BAD_REQUEST]: 400,
  [code.UNAUTHORIZED]: 401,
  [code.NOT_FOUND]: 404,
  [code.CONFLICT]: 409,
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
