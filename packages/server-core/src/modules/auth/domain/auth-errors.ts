import type { AuthErrorCode } from '@codetask/contracts'

export class AuthError extends Error {
  readonly code: AuthErrorCode | string
  readonly httpStatus: number
  readonly details: Record<string, unknown>

  constructor(
    code: AuthErrorCode | string,
    message: string,
    httpStatus: number,
    details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'AuthError'
    this.code = code
    this.httpStatus = httpStatus
    this.details = details
  }

  static unauthorized(message = 'Authentication required', code = 'auth.unauthorized'): AuthError {
    return new AuthError(code, message, 401, { code })
  }

  static badRequest(code: string, message: string, details: Record<string, unknown> = {}): AuthError {
    return new AuthError(code, message, 400, { code, ...details })
  }

  static conflict(code: string, message: string, details: Record<string, unknown> = {}): AuthError {
    return new AuthError(code, message, 409, { code, ...details })
  }

  static forbidden(code: string, message: string, details: Record<string, unknown> = {}): AuthError {
    return new AuthError(code, message, 403, { code, ...details })
  }

  static rateLimited(
    code: string,
    message: string,
    details: Record<string, unknown> = {}
  ): AuthError {
    return new AuthError(code, message, 429, { code, ...details })
  }
}
