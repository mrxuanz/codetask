import { randomBytes, timingSafeEqual } from 'crypto'
import { AppError } from '../error'
import type { AppDatabase } from '../db'
import { getCutoverMarker, type SchemaGeneration } from '../application/cutover-state'
import { assertSetupCredentialsAllowed } from './credentials-policy'
import { DUMMY_HASH, hashPassword, verifyPassword } from './password'
import { hmacAuthSecret } from './secret'
import {
  SqliteAuthStore,
  type AuthPrincipal,
  type AuthThrottleRecord,
  type AuthUserRecord
} from './store'

const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const MAXIMUM_SESSIONS = 10
const THROTTLE_WINDOW_MS = 15 * 60 * 1000
const LOGIN_REQUEST_LIMIT = 30
const CAPTCHA_AFTER_FAILURES = 3
const LOCK_AFTER_FAILURES = 8
const LOCK_DURATION_MS = 15 * 60 * 1000
const CAPTCHA_TTL_MS = 5 * 60 * 1000
const CAPTCHA_MAX_ATTEMPTS = 3
const CAPTCHA_REQUEST_WINDOW_MS = 60 * 1000
const CAPTCHA_REQUEST_LIMIT = 10
const CAPTCHA_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export interface BootstrapData {
  initialized: boolean
  authenticated: boolean
  username?: string
  controlPlaneGeneration?: SchemaGeneration | null
}

/**
 * `token` remains an API-client compatibility field. The renderer deliberately ignores it and
 * uses the HttpOnly session cookie issued by the HTTP adapter.
 */
export interface AuthData {
  token: string
  username: string
  expires_at: number
}

export interface LoginOptions {
  username: string
  password: string
  captchaId?: string
  captchaAnswer?: string
  clientIp: string
}

export interface CaptchaChallenge {
  challengeId: string
  image: string
}

function normalizeUsername(username: string): string {
  return username.trim().normalize('NFKC').toLocaleLowerCase('en-US')
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function randomCaptchaCode(): string {
  const bytes = randomBytes(5)
  return Array.from(bytes, (byte) => CAPTCHA_CHARSET[byte % CAPTCHA_CHARSET.length]).join('')
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

export class SecureAuthService {
  readonly store: SqliteAuthStore

  constructor(
    db: AppDatabase,
    private readonly authSecret: string,
    private readonly clock: () => number = Date.now
  ) {
    this.store = new SqliteAuthStore(db)
  }

  private nowMs(): number {
    return this.clock()
  }

  private digest(kind: string, value: string): string {
    return hmacAuthSecret(this.authSecret, `${kind}:`, value)
  }

  private tokenDigest(token: string): string {
    return this.digest('session', token)
  }

  private issueSession(user: AuthUserRecord): AuthData {
    const nowMs = this.nowMs()
    const expiresAtMs = nowMs + SESSION_TTL_MS
    const token = randomBytes(32).toString('base64url')
    this.store.createSession({
      userId: user.id,
      tokenDigest: this.tokenDigest(token),
      nowMs,
      expiresAtMs,
      maximumSessions: MAXIMUM_SESSIONS
    })
    return {
      token,
      username: user.username,
      expires_at: Math.floor(expiresAtMs / 1000)
    }
  }

  private readControlPlaneGeneration(): SchemaGeneration | null {
    try {
      return getCutoverMarker()
    } catch {
      return null
    }
  }

  async bootstrap(token?: string): Promise<BootstrapData> {
    const user = this.store.getUser()
    const controlPlaneGeneration = this.readControlPlaneGeneration()
    if (!user) {
      return { initialized: false, authenticated: false, controlPlaneGeneration }
    }
    const principal = token ? this.authenticateToken(token) : null
    return {
      initialized: true,
      authenticated: principal !== null,
      ...(principal ? { username: principal.username } : {}),
      controlPlaneGeneration
    }
  }

  async setup(username: string, password: string): Promise<AuthData> {
    const trimmedUsername = username.trim()
    const trimmedPassword = password.trim()
    if (!trimmedUsername || !trimmedPassword) {
      throw AppError.badRequest(
        'Username and password are required',
        'auth.username_password_required'
      )
    }
    assertSetupCredentialsAllowed(trimmedUsername, trimmedPassword)
    if (this.store.getUser()) {
      throw AppError.badRequest('Account already initialized', 'auth.already_initialized')
    }

    const nowMs = this.nowMs()
    let user: AuthUserRecord
    try {
      user = this.store.createUser({
        username: trimmedUsername,
        normalizedUsername: normalizeUsername(trimmedUsername),
        passwordHash: await hashPassword(trimmedPassword),
        nowMs
      })
    } catch (error) {
      if (this.store.getUser()) {
        throw AppError.badRequest('Account already initialized', 'auth.already_initialized')
      }
      throw error
    }
    const result = this.issueSession(user)
    this.store.audit({
      eventType: 'account.setup',
      userId: user.id,
      subjectDigest: this.digest('username', user.normalizedUsername),
      success: true,
      nowMs
    })
    return result
  }

  private loginThrottle(key: string, nowMs: number): AuthThrottleRecord {
    const current = this.store.getThrottle(key)
    if (!current || nowMs - current.windowStartedAtMs >= THROTTLE_WINDOW_MS) {
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
    throttle.captchaRequired = throttle.failureCount >= CAPTCHA_AFTER_FAILURES
    if (throttle.failureCount >= LOCK_AFTER_FAILURES) {
      throttle.lockedUntilMs = nowMs + LOCK_DURATION_MS
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
      throw new AppError(
        40101,
        'Too many login failures',
        {
          captchaRequired: true,
          lockedUntil: Math.floor(throttle.lockedUntilMs / 1000),
          retryAfterSec: Math.ceil((throttle.lockedUntilMs - nowMs) / 1000)
        },
        429
      )
    }
    throw new AppError(40101, 'Invalid username or password', {
      captchaRequired: throttle.captchaRequired
    })
  }

  async login(options: LoginOptions): Promise<AuthData> {
    const normalizedUsername = normalizeUsername(options.username)
    if (!normalizedUsername || !options.password) {
      throw AppError.badRequest(
        'Username and password are required',
        'auth.username_password_required'
      )
    }

    const nowMs = this.nowMs()
    const subjectDigest = this.digest('username', normalizedUsername)
    const scopeDigest = this.digest('ip', options.clientIp)
    const throttleKey = `login:${scopeDigest}:${subjectDigest}`
    const throttle = this.loginThrottle(throttleKey, nowMs)
    throttle.requestCount += 1
    throttle.updatedAtMs = nowMs
    this.store.putThrottle(throttle)

    if (throttle.requestCount > LOGIN_REQUEST_LIMIT) {
      throw new AppError(
        40101,
        'Too many requests',
        {
          retryAfterSec: Math.ceil((throttle.windowStartedAtMs + THROTTLE_WINDOW_MS - nowMs) / 1000)
        },
        429
      )
    }
    if (throttle.lockedUntilMs && throttle.lockedUntilMs > nowMs) {
      throw new AppError(
        40101,
        'Account temporarily locked',
        {
          captchaRequired: true,
          lockedUntil: Math.floor(throttle.lockedUntilMs / 1000),
          retryAfterSec: Math.ceil((throttle.lockedUntilMs - nowMs) / 1000)
        },
        429
      )
    }

    const captchaScope = `login:${scopeDigest}`
    if (throttle.captchaRequired) {
      if (!options.captchaId || !options.captchaAnswer) {
        throw new AppError(40101, 'Captcha required', { captchaRequired: true })
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
      ? await verifyPassword(options.password, user.passwordHash)
      : await verifyPassword(options.password, DUMMY_HASH)
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
  ): Promise<AuthData> {
    const user = this.store.getUser()
    if (!user || user.id !== principal.userId) {
      throw AppError.unauthorized('Invalid or expired session')
    }
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw AppError.badRequest('Current password is incorrect', 'auth.current_password_invalid')
    }
    assertSetupCredentialsAllowed(user.username, newPassword)
    const nowMs = this.nowMs()
    this.store.updatePassword(user.id, await hashPassword(newPassword.trim()), nowMs)
    this.store.revokeUserSessions(user.id, nowMs, 'password_changed')
    const updated = this.store.getUser()
    if (!updated) throw AppError.internal('Account disappeared', 'auth.account_missing')
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
    const scopeDigest = this.digest('ip', clientIp)
    const throttleKey = `captcha:${scopeDigest}`
    const current = this.store.getThrottle(throttleKey)
    const throttle =
      !current || nowMs - current.windowStartedAtMs >= CAPTCHA_REQUEST_WINDOW_MS
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
    if (throttle.requestCount > CAPTCHA_REQUEST_LIMIT) {
      throw new AppError(40101, 'Too many captcha requests', {}, 429)
    }

    const id = `cpt_${randomBytes(12).toString('hex')}`
    const code = randomCaptchaCode()
    const scopeKey = `login:${scopeDigest}`
    this.store.replaceChallenge({
      id,
      scopeKey,
      answerDigest: this.digest('captcha', `${id}:${code.toLowerCase()}`),
      maxAttempts: CAPTCHA_MAX_ATTEMPTS,
      expiresAtMs: nowMs + CAPTCHA_TTL_MS,
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
    const actual = this.digest('captcha', `${id}:${answer.trim().toLowerCase()}`)
    const valid = safeEqual(actual, challenge.answerDigest)
    this.store.recordChallengeAttempt(id, valid ? nowMs : undefined)
    return valid
  }

  verifyCaptchaForClient(id: string, answer: string, clientIp: string): boolean {
    return this.verifyCaptcha(id, answer, `login:${this.digest('ip', clientIp)}`)
  }

  cleanup(): void {
    this.store.cleanup(this.nowMs())
  }
}
