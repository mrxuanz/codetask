import type { Clock, IdGenerator } from '../../core/application/ports'
import { timingSafeEqual } from 'node:crypto'
import { SecureAuthService, type SecureAuthPolicy } from '../../core/application/auth'
import {
  HmacSetupGrantService,
  HmacTokenService,
  NodePasswordHasher,
  NodeSecureIdGenerator,
  SvgHumanChallengeGenerator
} from '../../adapters/security'
import { KernelSqliteDatabase, SqliteUnitOfWork } from '../../adapters/sqlite'

export const DEFAULT_SECURE_AUTH_POLICY: SecureAuthPolicy = Object.freeze({
  requireSetupGrant: true,
  sessionTtlMs: 12 * 60 * 60 * 1_000,
  sessionTouchIntervalMs: 60 * 1_000,
  maxSessionsPerUser: 8,
  requestWindowMs: 60 * 1_000,
  maxLoginRequestsPerWindow: 60,
  failureWindowMs: 30 * 60 * 1_000,
  captchaAfterFailures: 3,
  lockoutAfterFailures: 5,
  lockoutScheduleMs: Object.freeze([
    5 * 1_000,
    15 * 1_000,
    60 * 1_000,
    5 * 60 * 1_000,
    30 * 60 * 1_000
  ]),
  challengeTtlMs: 5 * 60 * 1_000,
  challengeMaxAttempts: 3,
  maxActiveChallenges: 1_000,
  maxChallengeRequestsPerWindow: 10,
  cleanupThrottleAgeMs: 24 * 60 * 60 * 1_000
})

class SystemClock implements Clock {
  nowMs(): number {
    return Date.now()
  }
}

function secretBytes(secret: Uint8Array | string): Uint8Array {
  if (typeof secret !== 'string') return Buffer.from(secret)
  if (/^[a-f0-9]{64}$/i.test(secret)) return Buffer.from(secret, 'hex')
  return Buffer.from(secret, 'utf8')
}

export function createSetupGrantService(authSecret: Uint8Array | string): HmacSetupGrantService {
  return new HmacSetupGrantService(secretBytes(authSecret))
}

export interface SecureAuthModule {
  readonly service: SecureAuthService
  readonly setupGrants: HmacSetupGrantService
  issueSetupGrant(): { readonly grant: string; readonly expiresAtMs: number }
  csrfToken(sessionToken: string): string
  verifyCsrfToken(sessionToken: string, csrfToken: string): boolean
  startCleanup(intervalMs?: number): void
  dispose(): void
}

export function createSecureAuthModule(input: {
  readonly database: KernelSqliteDatabase
  readonly authSecret: Uint8Array | string
  readonly mode: 'desktop' | 'server'
  readonly clock?: Clock
  readonly ids?: IdGenerator
  readonly policy?: Partial<SecureAuthPolicy>
}): SecureAuthModule {
  const clock = input.clock ?? new SystemClock()
  const secret = secretBytes(input.authSecret)
  const setupGrants = createSetupGrantService(secret)
  const tokenService = new HmacTokenService(secret)
  const policy: SecureAuthPolicy = Object.freeze({
    ...DEFAULT_SECURE_AUTH_POLICY,
    ...input.policy,
    requireSetupGrant: input.policy?.requireSetupGrant ?? input.mode === 'server',
    lockoutScheduleMs: Object.freeze([
      ...(input.policy?.lockoutScheduleMs ?? DEFAULT_SECURE_AUTH_POLICY.lockoutScheduleMs)
    ])
  })
  const service = new SecureAuthService({
    unitOfWork: new SqliteUnitOfWork(input.database),
    passwordHasher: new NodePasswordHasher(),
    tokens: tokenService,
    challenges: new SvgHumanChallengeGenerator(),
    setupGrants,
    clock,
    ids: input.ids ?? new NodeSecureIdGenerator(),
    policy
  })
  let cleanupTimer: ReturnType<typeof setInterval> | null = null

  return {
    service,
    setupGrants,
    issueSetupGrant(): { readonly grant: string; readonly expiresAtMs: number } {
      return setupGrants.issue(clock.nowMs())
    },
    csrfToken(sessionToken: string): string {
      return tokenService.digest('auth-csrf', sessionToken)
    },
    verifyCsrfToken(sessionToken: string, csrfToken: string): boolean {
      if (!/^[a-f0-9]{64}$/.test(csrfToken)) return false
      const expected = Buffer.from(tokenService.digest('auth-csrf', sessionToken), 'hex')
      const actual = Buffer.from(csrfToken, 'hex')
      return actual.length === expected.length && timingSafeEqual(actual, expected)
    },
    startCleanup(intervalMs = 5 * 60 * 1_000): void {
      if (cleanupTimer) return
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 10_000) {
        throw new Error('auth.cleanup_interval.invalid')
      }
      cleanupTimer = setInterval(() => {
        service.cleanup()
      }, intervalMs)
      cleanupTimer.unref?.()
    },
    dispose(): void {
      if (!cleanupTimer) return
      clearInterval(cleanupTimer)
      cleanupTimer = null
    }
  }
}
