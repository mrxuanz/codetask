import { randomBytes, timingSafeEqual } from 'crypto'
import type { AuthUserRecord } from '../domain/account.ts'
import type { AuthPrincipal } from '../domain/actor.ts'
import { AuthError } from '../domain/auth-errors.ts'
import { LoginPolicy, normalizeUsername } from '../domain/login-policy.ts'
import type { AuthRepository, AuthThrottleRecord } from '../ports/auth-repository.ts'
import type { Clock, PasswordHasher, TokenDigester } from '../ports/password-hasher.ts'

export type BootstrapData = {
  initialized: boolean
  authenticated: boolean
  username?: string
  actor?: {
    userId: string
    username: string
    sessionExpiresAt: number
  }
}

export type SessionIssue = {
  token: string
  userId: string
  username: string
  sessionId: string
  expiresAt: number
}

export type LoginOptions = {
  username: string
  password: string
  captchaId?: string
  captchaAnswer?: string
  clientIp: string
}

export type CaptchaChallenge = {
  challengeId: string
  image: string
}

export type CredentialsPolicy = {
  assertAllowed(username: string, password: string): void
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function randomCaptchaCode(): string {
  const bytes = randomBytes(5)
  return Array.from(bytes, (byte) => LoginPolicy.captchaCharset[byte % LoginPolicy.captchaCharset.length]).join(
    ''
  )
}

function captchaSvg(code: string): string {
  const glyphs = Array.from(code, (character, index) => {
    const x = 22 + index * 31
    const y = 37 + Math.sin(index * 1.7) * 6
    const rotation = Math.round(Math.sin(index * 2.1) * 13)
    return `<text x="${x}" y="${y}" transform="rotate(${rotation},${x},${y})" font-size="27" font-family="monospace" fill="#333">${character}</text>`
  }).join('')
  const lines = Array.from({ length: 7 }, (_, index) => {
    const y = 8 + index * 8
    return `<line x1="0" y1="${y}" x2="180" y2="${60 - y / 2}" stroke="#ddd" stroke-width="1"/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="60" viewBox="0 0 180 60"><rect width="100%" height="100%" fill="#f9f9f9"/>${lines}${glyphs}</svg>`
}

export class AuthApplication {
  constructor(
    readonly store: AuthRepository,
    private readonly passwords: PasswordHasher,
    private readonly digester: TokenDigester,
    private readonly credentials: CredentialsPolicy,
    private readonly clock: Clock = { nowMs: () => Date.now() }
  ) {}

  private nowMs(): number {
    return this.clock.nowMs()
  }

  private tokenDigest(token: string): string {
    return this.digester.digest('session', token)
  }

  private issueSession(user: AuthUserRecord): SessionIssue {
    const nowMs = this.nowMs()
    const expiresAtMs = nowMs + LoginPolicy.sessionTtlMs
    const token = randomBytes(32).toString('base64url')
    const session = this.store.createSession({
      userId: user.id,
      tokenDigest: this.tokenDigest(token),
      nowMs,
      expiresAtMs,
      maximumSessions: LoginPolicy.maximumSessions
    })
    return {
      token,
      userId: user.id,
      username: user.username,
      sessionId: session.id,
      expiresAt: Math.floor(expiresAtMs / 1000)
    }
  }

  async bootstrap(token?: string): Promise<BootstrapData> {
    const user = this.store.getUser()
    if (!user) {
      return { initialized: false, authenticated: false }
    }
    const principal = token ? this.authenticateToken(token) : null
    if (!principal) {
      return { initialized: true, authenticated: false }
    }
    return {
      initialized: true,
      authenticated: true,
      username: principal.username,
      actor: {
        userId: principal.userId,
        username: principal.username,
        sessionExpiresAt: Math.floor(principal.expiresAtMs / 1000)
      }
    }
  }

  async setup(username: string, password: string): Promise<SessionIssue> {
    const trimmedUsername = username.trim()
    const trimmedPassword = password.trim()
    if (!trimmedUsername || !trimmedPassword) {
      throw AuthError.badRequest(
        'auth.username_password_required',
        'Username and password are required'
      )
    }
    this.credentials.assertAllowed(trimmedUsername, trimmedPassword)
    if (this.store.getUser()) {
      throw AuthError.conflict('auth.already_initialized', 'Account already initialized')
    }

    const nowMs = this.nowMs()
    let user: AuthUserRecord
    try {
      user = this.store.createUser({
        username: trimmedUsername,
        normalizedUsername: normalizeUsername(trimmedUsername),
        passwordHash: await this.passwords.hash(trimmedPassword),
        nowMs
      })
    } catch (error) {
      if (this.store.getUser()) {
        throw AuthError.conflict('auth.already_initialized', 'Account already initialized')
      }
      throw error
    }
    const result = this.issueSession(user)
    this.store.audit({
      eventType: 'account.setup',
      userId: user.id,
      subjectDigest: this.digester.digest('username', user.normalizedUsername),
      success: true,
      nowMs
    })
    return result
  }

  private loginThrottle(key: string, nowMs: number): AuthThrottleRecord {
    const current = this.store.getThrottle(key)
    if (!current || nowMs - current.windowStartedAtMs >= LoginPolicy.throttleWindowMs) {
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
    return current
  }

  private recordLoginFailure(
    throttle: AuthThrottleRecord,
    audit: { userId?: string; subjectDigest: string; scopeDigest: string; reasonCode: string },
    nowMs: number
  ): never {
    throttle.failureCount += 1
    throttle.captchaRequired = throttle.failureCount >= LoginPolicy.captchaAfterFailures
    if (throttle.failureCount >= LoginPolicy.lockAfterFailures) {
      throttle.lockedUntilMs = nowMs + LoginPolicy.lockDurationMs
    }
    throttle.updatedAtMs = nowMs
    this.store.putThrottle(throttle)
    this.store.audit({
      eventType: 'session.login',
      ...(audit.userId ? { userId: audit.userId } : {}),
      subjectDigest: audit.subjectDigest,
      scopeDigest: audit.scopeDigest,
      success: false,
      reasonCode: audit.reasonCode,
      nowMs
    })

    if (throttle.lockedUntilMs) {
      throw AuthError.rateLimited('auth.account_locked', 'Too many login failures', {
        captchaRequired: true,
        lockedUntil: Math.floor(throttle.lockedUntilMs / 1000),
        retryAfterSec: Math.ceil((throttle.lockedUntilMs - nowMs) / 1000)
      })
    }
    throw new AuthError('auth.invalid_credentials', 'Invalid username or password', 401, {
      code: 'auth.invalid_credentials',
      captchaRequired: throttle.captchaRequired
    })
  }

  async login(options: LoginOptions): Promise<SessionIssue> {
    const normalizedUsername = normalizeUsername(options.username)
    if (!normalizedUsername || !options.password) {
      throw AuthError.badRequest(
        'auth.username_password_required',
        'Username and password are required'
      )
    }

    const nowMs = this.nowMs()
    const subjectDigest = this.digester.digest('username', normalizedUsername)
    const scopeDigest = this.digester.digest('ip', options.clientIp)
    const throttleKey = `login:${scopeDigest}:${subjectDigest}`
    const throttle = this.loginThrottle(throttleKey, nowMs)
    throttle.requestCount += 1
    throttle.updatedAtMs = nowMs
    this.store.putThrottle(throttle)

    if (throttle.requestCount > LoginPolicy.loginRequestLimit) {
      throw AuthError.rateLimited('auth.rate_limited', 'Too many requests', {
        retryAfterSec: Math.ceil(
          (throttle.windowStartedAtMs + LoginPolicy.throttleWindowMs - nowMs) / 1000
        )
      })
    }
    if (throttle.lockedUntilMs && throttle.lockedUntilMs > nowMs) {
      throw AuthError.rateLimited('auth.account_locked', 'Account temporarily locked', {
        captchaRequired: true,
        lockedUntil: Math.floor(throttle.lockedUntilMs / 1000),
        retryAfterSec: Math.ceil((throttle.lockedUntilMs - nowMs) / 1000)
      })
    }

    const captchaScope = `login:${scopeDigest}`
    if (throttle.captchaRequired) {
      if (!options.captchaId || !options.captchaAnswer) {
        throw new AuthError('auth.captcha_required', 'Captcha required', 401, {
          code: 'auth.captcha_required',
          captchaRequired: true
        })
      }
      if (!this.verifyCaptcha(options.captchaId, options.captchaAnswer, captchaScope)) {
        return this.recordLoginFailure(
          throttle,
          { subjectDigest, scopeDigest, reasonCode: 'captcha_invalid' },
          nowMs
        )
      }
    }

    const user = this.store.getUser()
    const passwordValid = user
      ? await this.passwords.verify(options.password, user.passwordHash)
      : await this.passwords.verify(options.password, this.passwords.dummyHash)
    const usernameValid = user?.normalizedUsername === normalizedUsername

    if (!user || !usernameValid || !passwordValid || user.disabledAtMs !== null) {
      return this.recordLoginFailure(
        throttle,
        {
          ...(user ? { userId: user.id } : {}),
          subjectDigest,
          scopeDigest,
          reasonCode: user ? 'credentials_invalid' : 'account_missing'
        },
        nowMs
      )
    }

    this.store.deleteThrottle(throttleKey)
    this.store.deleteChallengeForScope(captchaScope)
    const result = this.issueSession(user)
    this.store.audit({
      eventType: 'session.login',
      userId: user.id,
      subjectDigest,
      scopeDigest,
      success: true,
      nowMs
    })
    return result
  }

  authenticateToken(token: string): AuthPrincipal | null {
    if (!token.trim()) return null
    return this.store.findActiveSession(this.tokenDigest(token), this.nowMs())
  }

  isSessionActive(sessionId: string, userId: string): boolean {
    return this.store.isSessionActive(sessionId, userId, this.nowMs())
  }

  logout(token?: string): void {
    if (!token) return
    const nowMs = this.nowMs()
    const principal = this.authenticateToken(token)
    this.store.revokeSession(this.tokenDigest(token), nowMs, 'logout')
    this.store.audit({
      eventType: 'session.logout',
      ...(principal ? { userId: principal.userId } : {}),
      success: principal !== null,
      ...(!principal ? { reasonCode: 'session_missing' } : {}),
      nowMs
    })
  }

  logoutAll(principal: AuthPrincipal): void {
    const nowMs = this.nowMs()
    this.store.revokeUserSessions(principal.userId, nowMs, 'logout_all')
    this.store.audit({
      eventType: 'session.logout_all',
      userId: principal.userId,
      success: true,
      nowMs
    })
  }

  async changePassword(
    principal: AuthPrincipal,
    currentPassword: string,
    newPassword: string
  ): Promise<SessionIssue> {
    const user = this.store.getUser()
    if (!user || user.id !== principal.userId) {
      throw AuthError.unauthorized('Invalid or expired session', 'auth.session_expired')
    }
    if (!(await this.passwords.verify(currentPassword, user.passwordHash))) {
      throw AuthError.badRequest('auth.current_password_invalid', 'Current password is incorrect')
    }
    this.credentials.assertAllowed(user.username, newPassword)
    const nowMs = this.nowMs()
    this.store.updatePassword(user.id, await this.passwords.hash(newPassword.trim()), nowMs)
    this.store.revokeUserSessions(user.id, nowMs, 'password_changed')
    const updated = this.store.getUser()
    if (!updated) {
      throw new AuthError('auth.not_initialized', 'Account disappeared', 500, {
        code: 'auth.not_initialized'
      })
    }
    this.store.audit({
      eventType: 'account.password_changed',
      userId: user.id,
      success: true,
      nowMs
    })
    return this.issueSession(updated)
  }

  generateCaptcha(clientIp: string): CaptchaChallenge {
    const nowMs = this.nowMs()
    const scopeDigest = this.digester.digest('ip', clientIp)
    const throttleKey = `captcha:${scopeDigest}`
    const current = this.store.getThrottle(throttleKey)
    const throttle =
      !current || nowMs - current.windowStartedAtMs >= LoginPolicy.captchaRequestWindowMs
        ? {
            key: throttleKey,
            windowStartedAtMs: nowMs,
            requestCount: 0,
            failureCount: 0,
            captchaRequired: false,
            lockedUntilMs: null,
            updatedAtMs: nowMs
          }
        : current
    throttle.requestCount += 1
    throttle.updatedAtMs = nowMs
    this.store.putThrottle(throttle)
    if (throttle.requestCount > LoginPolicy.captchaRequestLimit) {
      throw AuthError.rateLimited('auth.rate_limited', 'Too many captcha requests')
    }

    const id = `cpt_${randomBytes(12).toString('hex')}`
    const code = randomCaptchaCode()
    const scopeKey = `login:${scopeDigest}`
    this.store.replaceChallenge({
      id,
      scopeKey,
      answerDigest: this.digester.digest('captcha', `${id}:${code.toLowerCase()}`),
      maxAttempts: LoginPolicy.captchaMaxAttempts,
      expiresAtMs: nowMs + LoginPolicy.captchaTtlMs,
      nowMs
    })
    const svg = captchaSvg(code)
    return {
      challengeId: id,
      image: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    }
  }

  private verifyCaptcha(id: string, answer: string, scopeKey: string): boolean {
    const nowMs = this.nowMs()
    const challenge = this.store.getChallenge(id, scopeKey)
    if (
      !challenge ||
      challenge.consumedAtMs !== null ||
      challenge.expiresAtMs <= nowMs ||
      challenge.attempts >= challenge.maxAttempts
    ) {
      return false
    }
    const actual = this.digester.digest('captcha', `${id}:${answer.trim().toLowerCase()}`)
    const valid = safeEqual(actual, challenge.answerDigest)
    this.store.recordChallengeAttempt(id, valid ? nowMs : undefined)
    return valid
  }

  verifyCaptchaForClient(id: string, answer: string, clientIp: string): boolean {
    return this.verifyCaptcha(id, answer, `login:${this.digester.digest('ip', clientIp)}`)
  }

  cleanup(): void {
    this.store.cleanup(this.nowMs())
  }
}

/** Browser/host session payload returned by setup/login. */
export type AuthData = {
  token: string
  username: string
  expires_at: number
  userId: string
  sessionId: string
}

export function sessionIssueToAuthData(issue: SessionIssue): AuthData {
  return {
    token: issue.token,
    username: issue.username,
    expires_at: issue.expiresAt,
    userId: issue.userId,
    sessionId: issue.sessionId
  }
}
