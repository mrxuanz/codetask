import {
  AuthError,
  normalizeAuthUsername,
  validateAuthPassword,
  validateAuthUsername
} from '../../domain/auth'
import type {
  AuthAuditRecord,
  AuthChallengeRecord,
  AuthSessionRecord,
  AuthThrottleRecord,
  AuthUserRecord,
  Clock,
  HumanChallengeGenerator,
  IdGenerator,
  PasswordHasher,
  SecureTokenService,
  SetupGrantVerifier,
  UnitOfWork
} from '../ports'

export interface SecureAuthPolicy {
  readonly requireSetupGrant: boolean
  readonly sessionTtlMs: number
  readonly sessionTouchIntervalMs: number
  readonly maxSessionsPerUser: number
  readonly requestWindowMs: number
  readonly maxLoginRequestsPerWindow: number
  readonly failureWindowMs: number
  readonly captchaAfterFailures: number
  readonly lockoutAfterFailures: number
  readonly lockoutScheduleMs: readonly number[]
  readonly challengeTtlMs: number
  readonly challengeMaxAttempts: number
  readonly maxActiveChallenges: number
  readonly maxChallengeRequestsPerWindow: number
  readonly cleanupThrottleAgeMs: number
}

export interface AuthSessionResult {
  readonly token: string
  readonly username: string
  readonly expiresAtMs: number
}

export interface AuthPrincipal {
  readonly userId: string
  readonly username: string
  readonly sessionId: string
  readonly expiresAtMs: number
}

export interface AuthBootstrapResult {
  readonly initialized: boolean
  readonly authenticated: boolean
  readonly username?: string
}

export interface AuthChallengeResult {
  readonly challengeId: string
  readonly publicPayload: string
  readonly expiresAtMs: number
}

export interface AuthCleanupSummary {
  readonly sessions: number
  readonly challenges: number
  readonly throttles: number
}

interface SecureAuthDependencies {
  readonly unitOfWork: UnitOfWork
  readonly passwordHasher: PasswordHasher
  readonly tokens: SecureTokenService
  readonly challenges: HumanChallengeGenerator
  readonly setupGrants: SetupGrantVerifier
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly policy: SecureAuthPolicy
}

interface LoginGateResult {
  readonly allowed: boolean
  readonly code?: 'auth.rate_limited' | 'auth.challenge_required' | 'auth.challenge_invalid'
  readonly retryAfterMs?: number
  readonly captchaRequired?: boolean
}

function assertPolicy(policy: SecureAuthPolicy): void {
  const positiveFields: ReadonlyArray<readonly [string, number]> = [
    ['sessionTtlMs', policy.sessionTtlMs],
    ['sessionTouchIntervalMs', policy.sessionTouchIntervalMs],
    ['maxSessionsPerUser', policy.maxSessionsPerUser],
    ['requestWindowMs', policy.requestWindowMs],
    ['maxLoginRequestsPerWindow', policy.maxLoginRequestsPerWindow],
    ['failureWindowMs', policy.failureWindowMs],
    ['captchaAfterFailures', policy.captchaAfterFailures],
    ['lockoutAfterFailures', policy.lockoutAfterFailures],
    ['challengeTtlMs', policy.challengeTtlMs],
    ['challengeMaxAttempts', policy.challengeMaxAttempts],
    ['maxActiveChallenges', policy.maxActiveChallenges],
    ['maxChallengeRequestsPerWindow', policy.maxChallengeRequestsPerWindow],
    ['cleanupThrottleAgeMs', policy.cleanupThrottleAgeMs]
  ]
  for (const [name, value] of positiveFields) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`auth.policy.${name}.invalid`)
    }
  }
  if (
    policy.lockoutScheduleMs.length === 0 ||
    policy.lockoutScheduleMs.some((value) => value <= 0)
  ) {
    throw new Error('auth.policy.lockoutScheduleMs.invalid')
  }
  if (policy.lockoutAfterFailures < policy.captchaAfterFailures) {
    throw new Error('auth.policy.lockout_threshold.invalid')
  }
}

function audit(input: Omit<AuthAuditRecord, 'createdAtMs'>, nowMs: number): AuthAuditRecord {
  return { ...input, createdAtMs: nowMs }
}

function freshThrottle(key: string, nowMs: number): AuthThrottleRecord {
  return {
    key,
    windowStartedAtMs: nowMs,
    requestCount: 0,
    failureCount: 0,
    captchaRequired: false,
    lockedUntilMs: null,
    updatedAtMs: nowMs
  }
}

function normalizeChallengeAnswer(answer: string): string {
  return answer.trim().toUpperCase()
}

export class SecureAuthService {
  private readonly policy: SecureAuthPolicy

  constructor(private readonly dependencies: SecureAuthDependencies) {
    assertPolicy(dependencies.policy)
    this.policy = Object.freeze({
      ...dependencies.policy,
      lockoutScheduleMs: Object.freeze([...dependencies.policy.lockoutScheduleMs])
    })
  }

  bootstrap(token?: string): AuthBootstrapResult {
    const user = this.dependencies.unitOfWork.transaction((transaction) =>
      transaction.auth.getUser()
    )
    if (!user) return { initialized: false, authenticated: false }
    if (!token) return { initialized: true, authenticated: false }

    const principal = this.tryAuthenticate(token)
    return principal
      ? { initialized: true, authenticated: true, username: principal.username }
      : { initialized: true, authenticated: false }
  }

  async setupAccount(input: {
    readonly username: string
    readonly password: string
    readonly setupGrant?: string
    readonly requestScope: string
  }): Promise<AuthSessionResult> {
    const username = input.username.trim()
    const normalizedUsername = normalizeAuthUsername(username)
    const nowMs = this.dependencies.clock.nowMs()
    const subjectDigest = this.dependencies.tokens.digest('auth-subject', normalizedUsername)
    const scopeDigest = this.scopeDigest(input.requestScope)

    const usernameViolation = validateAuthUsername(username)
    if (usernameViolation) {
      throw new AuthError('auth.username_invalid', { violation: usernameViolation })
    }
    const passwordViolation = validateAuthPassword(username, input.password)
    if (passwordViolation) {
      throw new AuthError('auth.password_policy_violation', { violation: passwordViolation })
    }
    if (
      this.policy.requireSetupGrant &&
      (!input.setupGrant || !this.dependencies.setupGrants.verify(input.setupGrant, nowMs))
    ) {
      this.appendAudit(
        audit(
          {
            eventType: 'account.setup',
            userId: null,
            subjectDigest,
            scopeDigest,
            success: false,
            reasonCode: 'auth.setup_grant_invalid'
          },
          nowMs
        )
      )
      throw new AuthError('auth.setup_grant_invalid')
    }

    const initialized = this.dependencies.unitOfWork.transaction(
      (transaction) => transaction.auth.getUser() !== null
    )
    if (initialized) throw new AuthError('auth.already_initialized')

    const passwordHash = await this.dependencies.passwordHasher.hash(input.password)
    const userId = this.dependencies.ids.generate()
    const session = this.createSession(userId, nowMs)
    const user: AuthUserRecord = {
      id: userId,
      username,
      normalizedUsername,
      passwordHash,
      passwordVersion: 1,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      disabledAtMs: null
    }

    try {
      this.dependencies.unitOfWork.transaction((transaction) => {
        if (transaction.auth.getUser()) throw new AuthError('auth.already_initialized')
        transaction.auth.insertUser(user)
        transaction.auth.insertSession(session.record)
        transaction.auth.appendAudit(
          audit(
            {
              eventType: 'account.setup',
              userId,
              subjectDigest,
              scopeDigest,
              success: true,
              reasonCode: 'auth.account_created'
            },
            nowMs
          )
        )
      })
    } catch (error: unknown) {
      if (error instanceof AuthError) throw error
      if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
        throw new AuthError('auth.already_initialized')
      }
      throw error
    }

    return {
      token: session.token,
      username,
      expiresAtMs: session.record.expiresAtMs
    }
  }

  async login(input: {
    readonly username: string
    readonly password: string
    readonly requestScope: string
    readonly challengeId?: string
    readonly challengeAnswer?: string
  }): Promise<AuthSessionResult> {
    const username = input.username.trim()
    if (!username || !input.password || input.password.length > 128 || username.length > 64) {
      throw new AuthError('auth.credentials_required')
    }

    const nowMs = this.dependencies.clock.nowMs()
    const normalizedUsername = normalizeAuthUsername(username)
    const scopeDigest = this.scopeDigest(input.requestScope)
    const subjectDigest = this.dependencies.tokens.digest('auth-subject', normalizedUsername)
    const requestKey = `request:${scopeDigest}`
    const failureKey = `failure:${scopeDigest}:${subjectDigest}`

    const gate = this.dependencies.unitOfWork.transaction((transaction): LoginGateResult => {
      const request = this.consumeRequest(
        transaction.auth.getThrottle(requestKey),
        requestKey,
        nowMs,
        this.policy.maxLoginRequestsPerWindow
      )
      transaction.auth.putThrottle(request.record)
      if (!request.allowed) {
        transaction.auth.appendAudit(
          audit(
            {
              eventType: 'session.login',
              userId: null,
              subjectDigest,
              scopeDigest,
              success: false,
              reasonCode: 'auth.rate_limited'
            },
            nowMs
          )
        )
        return {
          allowed: false,
          code: 'auth.rate_limited',
          retryAfterMs: request.retryAfterMs
        }
      }

      const failure = this.currentFailureThrottle(
        transaction.auth.getThrottle(failureKey),
        failureKey,
        nowMs
      )
      if (failure.lockedUntilMs !== null && failure.lockedUntilMs > nowMs) {
        transaction.auth.putThrottle(failure)
        return {
          allowed: false,
          code: 'auth.rate_limited',
          retryAfterMs: failure.lockedUntilMs - nowMs,
          captchaRequired: failure.captchaRequired
        }
      }

      if (failure.captchaRequired) {
        if (!input.challengeId || !input.challengeAnswer) {
          return { allowed: false, code: 'auth.challenge_required', captchaRequired: true }
        }
        const challenge = transaction.auth.getChallenge(input.challengeId, scopeDigest)
        if (
          !challenge ||
          challenge.consumedAtMs !== null ||
          challenge.expiresAtMs <= nowMs ||
          challenge.attempts >= challenge.maxAttempts
        ) {
          return { allowed: false, code: 'auth.challenge_invalid', captchaRequired: true }
        }
        const answerDigest = this.dependencies.tokens.digest(
          `auth-challenge:${challenge.id}`,
          normalizeChallengeAnswer(input.challengeAnswer)
        )
        const valid = this.dependencies.tokens.equalsDigest(answerDigest, challenge.answerDigest)
        const attempts = challenge.attempts + 1
        transaction.auth.putChallenge({
          ...challenge,
          attempts,
          consumedAtMs: valid || attempts >= challenge.maxAttempts ? nowMs : null
        })
        if (!valid) {
          return { allowed: false, code: 'auth.challenge_invalid', captchaRequired: true }
        }
      }

      return { allowed: true }
    })

    if (!gate.allowed) {
      throw new AuthError(gate.code ?? 'auth.rate_limited', {
        retryAfterMs: gate.retryAfterMs ?? 0,
        captchaRequired: gate.captchaRequired ?? false
      })
    }

    const user = this.dependencies.unitOfWork.transaction((transaction) =>
      transaction.auth.getUserByNormalizedUsername(normalizedUsername)
    )
    const verification = await this.dependencies.passwordHasher.verify(
      input.password,
      user?.disabledAtMs === null ? user.passwordHash : null
    )

    if (!user || user.disabledAtMs !== null || !verification.valid) {
      const failure = this.dependencies.unitOfWork.transaction((transaction) => {
        const next = this.recordFailure(transaction.auth.getThrottle(failureKey), failureKey, nowMs)
        transaction.auth.putThrottle(next)
        transaction.auth.appendAudit(
          audit(
            {
              eventType: 'session.login',
              userId: null,
              subjectDigest,
              scopeDigest,
              success: false,
              reasonCode: 'auth.invalid_credentials'
            },
            nowMs
          )
        )
        return next
      })
      throw new AuthError('auth.invalid_credentials', {
        captchaRequired: failure.captchaRequired,
        retryAfterMs:
          failure.lockedUntilMs !== null && failure.lockedUntilMs > nowMs
            ? failure.lockedUntilMs - nowMs
            : 0
      })
    }

    const replacementHash = verification.needsRehash
      ? await this.dependencies.passwordHasher.hash(input.password)
      : null
    const session = this.createSession(user.id, nowMs)

    this.dependencies.unitOfWork.transaction((transaction) => {
      const current = transaction.auth.getUserByNormalizedUsername(normalizedUsername)
      if (!current || current.passwordVersion !== user.passwordVersion) {
        throw new AuthError('auth.concurrent_update')
      }
      if (
        replacementHash &&
        !transaction.auth.updatePassword({
          userId: user.id,
          expectedVersion: user.passwordVersion,
          passwordHash: replacementHash,
          updatedAtMs: nowMs
        })
      ) {
        throw new AuthError('auth.concurrent_update')
      }
      transaction.auth.deleteThrottle(failureKey)
      transaction.auth.deleteChallengesForScope(scopeDigest)
      transaction.auth.insertSession(session.record)
      transaction.auth.revokeExcessSessions(
        user.id,
        this.policy.maxSessionsPerUser,
        nowMs,
        'session_limit'
      )
      transaction.auth.appendAudit(
        audit(
          {
            eventType: 'session.login',
            userId: user.id,
            subjectDigest,
            scopeDigest,
            success: true,
            reasonCode: 'auth.login_succeeded'
          },
          nowMs
        )
      )
    })

    return {
      token: session.token,
      username: user.username,
      expiresAtMs: session.record.expiresAtMs
    }
  }

  authenticate(token: string): AuthPrincipal {
    const principal = this.tryAuthenticate(token)
    if (!principal) throw new AuthError('auth.session_invalid')
    return principal
  }

  tryAuthenticate(token: string): AuthPrincipal | null {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) return null
    const nowMs = this.dependencies.clock.nowMs()
    const tokenDigest = this.dependencies.tokens.digest('auth-session', token)
    return this.dependencies.unitOfWork.transaction((transaction) => {
      const session = transaction.auth.getSessionByDigest(tokenDigest)
      if (!session || session.revokedAtMs !== null || session.expiresAtMs <= nowMs) {
        return null
      }
      const user = transaction.auth.getUser()
      if (!user || user.id !== session.userId || user.disabledAtMs !== null) return null
      if (nowMs - session.lastSeenAtMs >= this.policy.sessionTouchIntervalMs) {
        transaction.auth.touchSession(session.id, nowMs)
      }
      return {
        userId: user.id,
        username: user.username,
        sessionId: session.id,
        expiresAtMs: session.expiresAtMs
      }
    })
  }

  logout(token?: string): void {
    if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) return
    const nowMs = this.dependencies.clock.nowMs()
    const digest = this.dependencies.tokens.digest('auth-session', token)
    this.dependencies.unitOfWork.transaction((transaction) => {
      const session = transaction.auth.getSessionByDigest(digest)
      if (!session) return
      const revoked = transaction.auth.revokeSessionByDigest(digest, nowMs, 'logout')
      if (revoked) {
        transaction.auth.appendAudit(
          audit(
            {
              eventType: 'session.logout',
              userId: session.userId,
              subjectDigest: null,
              scopeDigest: null,
              success: true,
              reasonCode: 'auth.logout_succeeded'
            },
            nowMs
          )
        )
      }
    })
  }

  logoutAll(token: string): void {
    const principal = this.authenticate(token)
    const nowMs = this.dependencies.clock.nowMs()
    this.dependencies.unitOfWork.transaction((transaction) => {
      transaction.auth.revokeAllSessions(principal.userId, nowMs, 'logout_all')
      transaction.auth.appendAudit(
        audit(
          {
            eventType: 'session.logout_all',
            userId: principal.userId,
            subjectDigest: null,
            scopeDigest: null,
            success: true,
            reasonCode: 'auth.logout_all_succeeded'
          },
          nowMs
        )
      )
    })
  }

  async changePassword(input: {
    readonly token: string
    readonly currentPassword: string
    readonly newPassword: string
  }): Promise<AuthSessionResult> {
    const principal = this.authenticate(input.token)
    const user = this.dependencies.unitOfWork.transaction((transaction) =>
      transaction.auth.getUser()
    )
    if (!user || user.id !== principal.userId) throw new AuthError('auth.session_invalid')

    const violation = validateAuthPassword(user.username, input.newPassword)
    if (violation) {
      throw new AuthError('auth.password_policy_violation', { violation })
    }
    const current = await this.dependencies.passwordHasher.verify(
      input.currentPassword,
      user.passwordHash
    )
    if (!current.valid) throw new AuthError('auth.current_password_invalid')
    const reused = await this.dependencies.passwordHasher.verify(
      input.newPassword,
      user.passwordHash
    )
    if (reused.valid) throw new AuthError('auth.password_reused')

    const nowMs = this.dependencies.clock.nowMs()
    const passwordHash = await this.dependencies.passwordHasher.hash(input.newPassword)
    const session = this.createSession(user.id, nowMs)
    this.dependencies.unitOfWork.transaction((transaction) => {
      if (
        !transaction.auth.updatePassword({
          userId: user.id,
          expectedVersion: user.passwordVersion,
          passwordHash,
          updatedAtMs: nowMs
        })
      ) {
        throw new AuthError('auth.concurrent_update')
      }
      transaction.auth.revokeAllSessions(user.id, nowMs, 'password_changed')
      transaction.auth.insertSession(session.record)
      transaction.auth.appendAudit(
        audit(
          {
            eventType: 'account.password_changed',
            userId: user.id,
            subjectDigest: null,
            scopeDigest: null,
            success: true,
            reasonCode: 'auth.password_changed'
          },
          nowMs
        )
      )
    })
    return {
      token: session.token,
      username: user.username,
      expiresAtMs: session.record.expiresAtMs
    }
  }

  issueChallenge(requestScope: string): AuthChallengeResult {
    const nowMs = this.dependencies.clock.nowMs()
    const scopeDigest = this.scopeDigest(requestScope)
    const requestKey = `challenge:${scopeDigest}`
    const generated = this.dependencies.challenges.generate()
    if (!generated.answer || generated.publicPayload.length > 128 * 1024) {
      throw new Error('auth.challenge_generator.invalid')
    }
    const id = this.dependencies.ids.generate()
    const record: AuthChallengeRecord = {
      id,
      scopeKey: scopeDigest,
      answerDigest: this.dependencies.tokens.digest(
        `auth-challenge:${id}`,
        normalizeChallengeAnswer(generated.answer)
      ),
      attempts: 0,
      maxAttempts: this.policy.challengeMaxAttempts,
      expiresAtMs: nowMs + this.policy.challengeTtlMs,
      consumedAtMs: null,
      createdAtMs: nowMs
    }

    const accepted = this.dependencies.unitOfWork.transaction((transaction) => {
      const rate = this.consumeRequest(
        transaction.auth.getThrottle(requestKey),
        requestKey,
        nowMs,
        this.policy.maxChallengeRequestsPerWindow
      )
      transaction.auth.putThrottle(rate.record)
      if (!rate.allowed) return false
      transaction.auth.deleteChallengesForScope(scopeDigest)
      if (transaction.auth.countActiveChallenges(nowMs) >= this.policy.maxActiveChallenges) {
        return false
      }
      transaction.auth.insertChallenge(record)
      return true
    })
    if (!accepted) throw new AuthError('auth.rate_limited')
    return {
      challengeId: id,
      publicPayload: generated.publicPayload,
      expiresAtMs: record.expiresAtMs
    }
  }

  cleanup(): AuthCleanupSummary {
    const nowMs = this.dependencies.clock.nowMs()
    return this.dependencies.unitOfWork.transaction((transaction) =>
      transaction.auth.cleanup(nowMs, nowMs - this.policy.cleanupThrottleAgeMs)
    )
  }

  private scopeDigest(requestScope: string): string {
    const normalized = requestScope.trim()
    if (!normalized || normalized.length > 512) {
      throw new AuthError('auth.rate_limited')
    }
    return this.dependencies.tokens.digest('auth-scope', normalized)
  }

  private appendAudit(record: AuthAuditRecord): void {
    this.dependencies.unitOfWork.transaction((transaction) => {
      transaction.auth.appendAudit(record)
    })
  }

  private createSession(
    userId: string,
    nowMs: number
  ): { readonly token: string; readonly record: AuthSessionRecord } {
    const token = this.dependencies.tokens.generateToken(32)
    return {
      token,
      record: {
        id: this.dependencies.ids.generate(),
        userId,
        tokenDigest: this.dependencies.tokens.digest('auth-session', token),
        createdAtMs: nowMs,
        lastSeenAtMs: nowMs,
        expiresAtMs: nowMs + this.policy.sessionTtlMs,
        revokedAtMs: null,
        revokeReason: null
      }
    }
  }

  private consumeRequest(
    current: AuthThrottleRecord | null,
    key: string,
    nowMs: number,
    limit: number
  ): {
    readonly allowed: boolean
    readonly retryAfterMs: number
    readonly record: AuthThrottleRecord
  } {
    const record =
      !current || nowMs - current.windowStartedAtMs >= this.policy.requestWindowMs
        ? freshThrottle(key, nowMs)
        : current
    const nextCount = record.requestCount + 1
    return {
      allowed: nextCount <= limit,
      retryAfterMs:
        nextCount <= limit
          ? 0
          : Math.max(1, record.windowStartedAtMs + this.policy.requestWindowMs - nowMs),
      record: {
        ...record,
        requestCount: nextCount,
        updatedAtMs: nowMs
      }
    }
  }

  private currentFailureThrottle(
    current: AuthThrottleRecord | null,
    key: string,
    nowMs: number
  ): AuthThrottleRecord {
    if (!current || nowMs - current.windowStartedAtMs >= this.policy.failureWindowMs) {
      return freshThrottle(key, nowMs)
    }
    return current
  }

  private recordFailure(
    current: AuthThrottleRecord | null,
    key: string,
    nowMs: number
  ): AuthThrottleRecord {
    const record = this.currentFailureThrottle(current, key, nowMs)
    const failureCount = record.failureCount + 1
    const scheduleIndex = failureCount - this.policy.lockoutAfterFailures
    const delay =
      scheduleIndex < 0
        ? null
        : (this.policy.lockoutScheduleMs[
            Math.min(scheduleIndex, this.policy.lockoutScheduleMs.length - 1)
          ] ?? null)
    return {
      ...record,
      failureCount,
      captchaRequired: failureCount >= this.policy.captchaAfterFailures,
      lockedUntilMs: delay === null ? null : nowMs + delay,
      updatedAtMs: nowMs
    }
  }
}
