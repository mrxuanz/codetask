import type { SettingsErrorCode } from '@codetask/contracts'

export class SettingsError extends Error {
  readonly code: SettingsErrorCode | string
  readonly httpStatus: number
  readonly details: Record<string, unknown>

  constructor(
    code: SettingsErrorCode | string,
    message: string,
    httpStatus: number,
    details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'SettingsError'
    this.code = code
    this.httpStatus = httpStatus
    this.details = details
  }

  static badRequest(
    code: SettingsErrorCode | string,
    message: string,
    details: Record<string, unknown> = {}
  ): SettingsError {
    return new SettingsError(code, message, 400, { code, ...details })
  }

  static conflict(
    code: SettingsErrorCode | string,
    message: string,
    details: Record<string, unknown> = {}
  ): SettingsError {
    return new SettingsError(code, message, 409, { code, ...details })
  }

  static notFound(
    code: SettingsErrorCode | string,
    message: string,
    details: Record<string, unknown> = {}
  ): SettingsError {
    return new SettingsError(code, message, 404, { code, ...details })
  }
}
