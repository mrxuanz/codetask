import {
  AuthApplication,
  AuthError,
  composeAuthModule,
  type AuthModule,
  type BootstrapData,
  type CaptchaChallenge,
  type LoginOptions,
  type SessionIssue,
  sessionIssueToAuthData,
  type AuthData
} from '@codetask/server-core/modules/auth'
import type { AppDatabase } from '../db'
import { validateSetupCredentials } from '../../shared/auth/credentials-policy'
import { formatTurnErrorMessage } from '../../shared/turn-errors/turn-error'
import { AppError, code } from '../error'

function sqliteClient(db: AppDatabase): import('better-sqlite3').Database {
  const client = (db as AppDatabase & { $client?: import('better-sqlite3').Database }).$client
  if (!client) throw new Error('Database client is not available')
  return client
}

function credentialsPolicy(): { assertAllowed(username: string, password: string): void } {
  return {
    assertAllowed(username: string, password: string): void {
      const violation = validateSetupCredentials(username, password)
      if (!violation) return
      throw AuthError.badRequest(
        violation.code,
        formatTurnErrorMessage(violation.code, violation.params),
        violation.params ?? {}
      )
    }
  }
}

/**
 * Host adapter around the server-core Auth module (04 cutover).
 * Kept as SecureAuthService name for bootstrap / SecurityContext compatibility.
 */
export class SecureAuthService {
  readonly module: AuthModule
  private readonly app: AuthApplication

  constructor(db: AppDatabase, authSecret: string, clock: () => number = Date.now) {
    this.module = composeAuthModule({
      db: sqliteClient(db),
      authSecret,
      credentials: credentialsPolicy(),
      clock
    })
    this.app = this.module.app
  }

  async bootstrap(token?: string): Promise<BootstrapData> {
    return this.app.bootstrap(token)
  }

  async setup(username: string, password: string): Promise<AuthData> {
    return sessionIssueToAuthData(await this.app.setup(username, password))
  }

  async login(options: LoginOptions): Promise<AuthData> {
    return sessionIssueToAuthData(await this.app.login(options))
  }

  authenticateToken(token: string): ReturnType<AuthApplication['authenticateToken']> {
    return this.app.authenticateToken(token)
  }

  isSessionActive(sessionId: string, userId: string): boolean {
    return this.app.isSessionActive(sessionId, userId)
  }

  logout(token?: string): void {
    this.app.logout(token)
  }

  logoutAll(principal: Parameters<AuthApplication['logoutAll']>[0]): void {
    this.app.logoutAll(principal)
  }

  async changePassword(
    principal: Parameters<AuthApplication['changePassword']>[0],
    currentPassword: string,
    newPassword: string
  ): Promise<AuthData> {
    return sessionIssueToAuthData(
      await this.app.changePassword(principal, currentPassword, newPassword)
    )
  }

  generateCaptcha(clientIp: string): CaptchaChallenge {
    return this.app.generateCaptcha(clientIp)
  }

  verifyCaptchaForClient(id: string, answer: string, clientIp: string): boolean {
    return this.app.verifyCaptchaForClient(id, answer, clientIp)
  }

  cleanup(): void {
    this.app.cleanup()
  }
}

export function authErrorToAppError(error: AuthError): AppError {
  const numeric =
    error.httpStatus === 401
      ? code.UNAUTHORIZED
      : error.httpStatus === 403
        ? 40301
        : error.httpStatus === 409
          ? code.CONFLICT
          : error.httpStatus === 429
            ? 42901
            : error.httpStatus === 400
              ? code.BAD_REQUEST
              : code.INTERNAL
  return new AppError(
    numeric,
    error.message,
    {
      error: error.message,
      code: error.code,
      turnErrorCode: error.code,
      ...error.details
    },
    error.httpStatus
  )
}

export type { AuthData, BootstrapData, CaptchaChallenge, LoginOptions, SessionIssue }
