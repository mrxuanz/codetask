import { randomUUID, timingSafeEqual } from 'crypto'
import { eq } from 'drizzle-orm'
import { AppError } from '../error'
import { getCutoverMarker, type SchemaGeneration } from '../application/cutover-state'
import { getDb } from '../db'
import { authState } from '../db/schema'
import { assertSetupCredentialsAllowed } from './credentials-policy'
import { hashPassword, verifyPassword, DUMMY_HASH } from './password'
import { timingSafeStringEqual } from './timing-safe'
import {
  checkGuardState,
  recordLoginFailure,
  resetGuardState,
  recordRateBucket,
  deleteCaptchaForScope
} from './guard'
import { verifyCaptcha } from './captcha'
import { rateLimit, LOGIN_REQUEST_RULE, LOGIN_FAILURE_RULE } from './memory-limiter'
import { hashIp, bucketKeyForIp, scopeKeyForLogin } from './client-ip'

const AUTH_ROW_ID = 1
const SESSION_TTL_SEC = 4 * 60 * 60

export interface BootstrapData {
  initialized: boolean
  authenticated: boolean
  username?: string
  controlPlaneGeneration?: SchemaGeneration | null
}

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
  authSecret: string
}

function sessionExpiresAt(): number {
  return Math.floor(Date.now() / 1000) + SESSION_TTL_SEC
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

async function getAuthRow(): Promise<typeof authState.$inferSelect | null> {
  const db = getDb()
  const rows = await db.select().from(authState).where(eq(authState.id, AUTH_ROW_ID)).limit(1)
  return rows[0] ?? null
}

function readControlPlaneGeneration(): SchemaGeneration | null {
  try {
    const client = (getDb() as ReturnType<typeof getDb> & { $client?: { prepare: (sql: string) => { get: () => unknown } } }).$client
    if (!client) return null
    const row = client
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'control_jobs'`)
      .get() as { ok: number } | undefined
    if (!row) return null
    return getCutoverMarker()
  } catch {
    return null
  }
}

export async function getBootstrap(token?: string): Promise<BootstrapData> {
  const controlPlaneGeneration = readControlPlaneGeneration()
  const row = await getAuthRow()
  if (!row) {
    return { initialized: false, authenticated: false, controlPlaneGeneration }
  }

  if (!token) {
    return { initialized: true, authenticated: false, controlPlaneGeneration }
  }

  const sessionTokenValid =
    row.sessionToken &&
    token &&
    row.sessionToken.length === token.length &&
    timingSafeEqual(Buffer.from(row.sessionToken), Buffer.from(token)) &&
    row.sessionExpiresAt !== null &&
    row.sessionExpiresAt > nowSec()

  if (!sessionTokenValid) {
    return { initialized: true, authenticated: false, controlPlaneGeneration }
  }

  return {
    initialized: true,
    authenticated: true,
    username: row.username,
    controlPlaneGeneration
  }
}

export async function setupAccount(username: string, password: string): Promise<AuthData> {
  const trimmedUsername = username.trim()
  const trimmedPassword = password.trim()
  if (!trimmedUsername || !trimmedPassword) {
    throw AppError.badRequest(
      'Username and password are required',
      'auth.username_password_required'
    )
  }

  assertSetupCredentialsAllowed(trimmedUsername, trimmedPassword)

  const existing = await getAuthRow()
  if (existing) {
    throw AppError.badRequest('Account already initialized', 'auth.already_initialized')
  }

  const token = randomUUID()
  const expiresAt = sessionExpiresAt()
  const db = getDb()

  await db.insert(authState).values({
    id: AUTH_ROW_ID,
    username: trimmedUsername,
    passwordHash: await hashPassword(trimmedPassword),
    sessionToken: token,
    sessionExpiresAt: expiresAt,
    createdAt: nowSec()
  })

  return { token, username: trimmedUsername, expires_at: expiresAt }
}

export async function loginAccount(opts: LoginOptions): Promise<AuthData> {
  const trimmed = opts.username.trim()
  if (!trimmed || !opts.password) {
    throw AppError.badRequest(
      'Username and password are required',
      'auth.username_password_required'
    )
  }

  const ipHash = hashIp(opts.authSecret, opts.clientIp)

  const reqLimit = rateLimit(bucketKeyForIp(ipHash) + ':req', LOGIN_REQUEST_RULE)
  if (!reqLimit.allowed) {
    throw new AppError(
      40101,
      reqLimit.overloaded ? 'Service overloaded' : 'Too many requests',
      { retryAfterSec: reqLimit.retryAfterSec },
      429
    )
  }

  const guard = checkGuardState()
  if (!guard.allowed && guard.lockedUntil) {
    throw new AppError(40101, 'Account temporarily locked', {
      lockedUntil: guard.lockedUntil,
      retryAfterSec: guard.retryAfterSec
    })
  }

  if (guard.captchaRequired) {
    if (!opts.captchaId || !opts.captchaAnswer) {
      throw new AppError(40101, 'Captcha required', { captchaRequired: true })
    }

    const captchaResult = await verifyCaptcha(
      opts.authSecret,
      opts.captchaId,
      opts.captchaAnswer,
      scopeKeyForLogin(ipHash)
    )
    if (!captchaResult.valid) {
      throw new AppError(40101, captchaResult.error ?? 'Invalid captcha', {
        captchaRequired: true
      })
    }
  }

  const row = await getAuthRow()
  if (!row) {
    await verifyPassword(opts.password, DUMMY_HASH)
    recordLoginFailure()
    recordRateBucket(bucketKeyForIp(ipHash), 10)
    throw AppError.badRequest('Account setup required', 'auth.setup_required')
  }

  const usernameOk = row.username === trimmed
  const passwordOk = await verifyPassword(opts.password, row.passwordHash)

  if (!usernameOk || !passwordOk) {
    recordLoginFailure()
    recordRateBucket(bucketKeyForIp(ipHash), 10)

    const failLimit = rateLimit(bucketKeyForIp(ipHash) + ':fail', LOGIN_FAILURE_RULE)
    const updatedGuard = checkGuardState()
    if (!failLimit.allowed || !updatedGuard.allowed) {
      throw new AppError(
        40101,
        'Too many login failures',
        {
          captchaRequired: updatedGuard.captchaRequired,
          lockedUntil: updatedGuard.lockedUntil,
          retryAfterSec: updatedGuard.retryAfterSec
        },
        429
      )
    }

    throw new AppError(40101, 'Invalid username or password', {
      captchaRequired: updatedGuard.captchaRequired,
      retryAfterSec: updatedGuard.retryAfterSec
    })
  }

  resetGuardState()
  deleteCaptchaForScope(scopeKeyForLogin(ipHash))

  const token = randomUUID()
  const expiresAt = sessionExpiresAt()
  const db = getDb()

  await db
    .update(authState)
    .set({ sessionToken: token, sessionExpiresAt: expiresAt })
    .where(eq(authState.id, AUTH_ROW_ID))

  return { token, username: trimmed, expires_at: expiresAt }
}

export async function findSessionUsername(token: string): Promise<string | null> {
  const row = await getAuthRow()
  if (!row?.sessionToken || !timingSafeStringEqual(row.sessionToken, token)) return null
  if (!row.sessionExpiresAt || row.sessionExpiresAt <= nowSec()) return null
  return row.username
}

/** Revoke the current session (single-user auth_state row). */
export async function logoutAccount(token?: string): Promise<void> {
  const row = await getAuthRow()
  if (!row) return
  if (token && row.sessionToken && !timingSafeStringEqual(row.sessionToken, token)) {
    return
  }
  const db = getDb()
  await db
    .update(authState)
    .set({ sessionToken: null, sessionExpiresAt: null })
    .where(eq(authState.id, AUTH_ROW_ID))
}
