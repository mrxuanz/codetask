import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { AuthPrincipal } from '../domain/actor.ts'
import type { AuthUserRecord } from '../domain/account.ts'
import { LoginPolicy } from '../domain/login-policy.ts'
import type {
  AuthChallengeRecord,
  AuthRepository,
  AuthThrottleRecord
} from '../ports/auth-repository.ts'

/**
 * SQLite adapter for authentication. Policy and HTTP concerns live elsewhere.
 */
export class SqliteAuthRepository implements AuthRepository {
  constructor(private readonly client: Database.Database) {}

  getUser(): AuthUserRecord | null {
    return (
      (this.client
        .prepare(
          `SELECT id, username, normalized_username AS normalizedUsername,
                  password_hash AS passwordHash, password_version AS passwordVersion,
                  disabled_at_ms AS disabledAtMs
             FROM auth_users WHERE singleton_key = 1 LIMIT 1`
        )
        .get() as AuthUserRecord | undefined) ?? null
    )
  }

  createUser(input: {
    username: string
    normalizedUsername: string
    passwordHash: string
    nowMs: number
  }): AuthUserRecord {
    const id = randomUUID()
    this.client
      .prepare(
        `INSERT INTO auth_users (
           id, singleton_key, username, normalized_username, password_hash,
           password_version, created_at_ms, updated_at_ms
         ) VALUES (?, 1, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        id,
        input.username,
        input.normalizedUsername,
        input.passwordHash,
        input.nowMs,
        input.nowMs
      )
    return {
      id,
      username: input.username,
      normalizedUsername: input.normalizedUsername,
      passwordHash: input.passwordHash,
      passwordVersion: 1,
      disabledAtMs: null
    }
  }

  updatePassword(userId: string, passwordHash: string, nowMs: number): void {
    this.client
      .prepare(
        `UPDATE auth_users
            SET password_hash = ?, password_version = password_version + 1, updated_at_ms = ?
          WHERE id = ?`
      )
      .run(passwordHash, nowMs, userId)
  }

  createSession(input: {
    userId: string
    tokenDigest: string
    nowMs: number
    expiresAtMs: number
    maximumSessions: number
  }): { id: string } {
    const id = randomUUID()
    this.client.transaction(() => {
      this.client
        .prepare(
          `UPDATE auth_sessions
              SET revoked_at_ms = ?, revoke_reason = 'session_limit'
            WHERE id IN (
              SELECT id FROM auth_sessions
               WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
               ORDER BY last_seen_at_ms DESC
               LIMIT -1 OFFSET ?
            )`
        )
        .run(input.nowMs, input.userId, input.nowMs, Math.max(0, input.maximumSessions - 1))
      this.client
        .prepare(
          `INSERT INTO auth_sessions (
             id, user_id, token_digest, created_at_ms, last_seen_at_ms, expires_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.userId, input.tokenDigest, input.nowMs, input.nowMs, input.expiresAtMs)
    })()
    return { id }
  }

  findActiveSession(tokenDigest: string, nowMs: number): AuthPrincipal | null {
    const row = this.client
      .prepare(
        `SELECT u.id AS userId, u.username, s.id AS sessionId,
                s.expires_at_ms AS expiresAtMs, s.last_seen_at_ms AS lastSeenAtMs
           FROM auth_sessions s
           JOIN auth_users u ON u.id = s.user_id
          WHERE s.token_digest = ?
            AND s.revoked_at_ms IS NULL
            AND s.expires_at_ms > ?
            AND u.disabled_at_ms IS NULL
          LIMIT 1`
      )
      .get(tokenDigest, nowMs) as (AuthPrincipal & { lastSeenAtMs: number }) | undefined
    if (!row) return null
    if (nowMs - row.lastSeenAtMs >= LoginPolicy.lastSeenThrottleMs) {
      this.client
        .prepare(`UPDATE auth_sessions SET last_seen_at_ms = ? WHERE id = ?`)
        .run(nowMs, row.sessionId)
    }
    return {
      userId: row.userId,
      username: row.username,
      sessionId: row.sessionId,
      expiresAtMs: row.expiresAtMs
    }
  }

  isSessionActive(sessionId: string, userId: string, nowMs: number): boolean {
    const row = this.client
      .prepare(
        `SELECT 1 AS ok FROM auth_sessions
          WHERE id = ? AND user_id = ?
            AND revoked_at_ms IS NULL AND expires_at_ms > ?
          LIMIT 1`
      )
      .get(sessionId, userId, nowMs) as { ok: number } | undefined
    return Boolean(row)
  }

  revokeSession(tokenDigest: string, nowMs: number, reason: string): void {
    this.client
      .prepare(
        `UPDATE auth_sessions SET revoked_at_ms = ?, revoke_reason = ?
          WHERE token_digest = ? AND revoked_at_ms IS NULL`
      )
      .run(nowMs, reason, tokenDigest)
  }

  revokeUserSessions(userId: string, nowMs: number, reason: string): void {
    this.client
      .prepare(
        `UPDATE auth_sessions SET revoked_at_ms = ?, revoke_reason = ?
          WHERE user_id = ? AND revoked_at_ms IS NULL`
      )
      .run(nowMs, reason, userId)
  }

  getThrottle(key: string): AuthThrottleRecord | null {
    const row = this.client
      .prepare(
        `SELECT key, window_started_at_ms AS windowStartedAtMs,
                request_count AS requestCount, failure_count AS failureCount,
                captcha_required AS captchaRequired, locked_until_ms AS lockedUntilMs,
                updated_at_ms AS updatedAtMs
           FROM auth_throttles WHERE key = ?`
      )
      .get(key) as
      | (Omit<AuthThrottleRecord, 'captchaRequired'> & {
          captchaRequired: number
        })
      | undefined
    return row ? { ...row, captchaRequired: row.captchaRequired === 1 } : null
  }

  putThrottle(row: AuthThrottleRecord): void {
    this.client
      .prepare(
        `INSERT INTO auth_throttles (
           key, window_started_at_ms, request_count, failure_count,
           captcha_required, locked_until_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           window_started_at_ms = excluded.window_started_at_ms,
           request_count = excluded.request_count,
           failure_count = excluded.failure_count,
           captcha_required = excluded.captcha_required,
           locked_until_ms = excluded.locked_until_ms,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        row.key,
        row.windowStartedAtMs,
        row.requestCount,
        row.failureCount,
        row.captchaRequired ? 1 : 0,
        row.lockedUntilMs,
        row.updatedAtMs
      )
  }

  deleteThrottle(key: string): void {
    this.client.prepare(`DELETE FROM auth_throttles WHERE key = ?`).run(key)
  }

  replaceChallenge(input: {
    id: string
    scopeKey: string
    answerDigest: string
    maxAttempts: number
    expiresAtMs: number
    nowMs: number
  }): void {
    this.client.transaction(() => {
      this.client.prepare(`DELETE FROM auth_challenges WHERE scope_key = ?`).run(input.scopeKey)
      this.client
        .prepare(
          `INSERT INTO auth_challenges (
             id, scope_key, answer_digest, attempts, max_attempts,
             expires_at_ms, consumed_at_ms, created_at_ms
           ) VALUES (?, ?, ?, 0, ?, ?, NULL, ?)`
        )
        .run(
          input.id,
          input.scopeKey,
          input.answerDigest,
          input.maxAttempts,
          input.expiresAtMs,
          input.nowMs
        )
    })()
  }

  getChallenge(id: string, scopeKey: string): AuthChallengeRecord | null {
    return (
      (this.client
        .prepare(
          `SELECT id, scope_key AS scopeKey, answer_digest AS answerDigest,
                  attempts, max_attempts AS maxAttempts, expires_at_ms AS expiresAtMs,
                  consumed_at_ms AS consumedAtMs
             FROM auth_challenges WHERE id = ? AND scope_key = ? LIMIT 1`
        )
        .get(id, scopeKey) as AuthChallengeRecord | undefined) ?? null
    )
  }

  recordChallengeAttempt(id: string, consumedAtMs?: number): void {
    this.client
      .prepare(
        `UPDATE auth_challenges
            SET attempts = attempts + 1, consumed_at_ms = COALESCE(?, consumed_at_ms)
          WHERE id = ?`
      )
      .run(consumedAtMs ?? null, id)
  }

  deleteChallengeForScope(scopeKey: string): void {
    this.client.prepare(`DELETE FROM auth_challenges WHERE scope_key = ?`).run(scopeKey)
  }

  audit(input: {
    eventType: string
    userId?: string
    subjectDigest?: string
    scopeDigest?: string
    success: boolean
    reasonCode?: string
    nowMs: number
  }): void {
    this.client
      .prepare(
        `INSERT INTO auth_audit (
           event_type, user_id, subject_digest, scope_digest, success, reason_code, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.eventType,
        input.userId ?? null,
        input.subjectDigest ?? null,
        input.scopeDigest ?? null,
        input.success ? 1 : 0,
        input.reasonCode ?? null,
        input.nowMs
      )
  }

  cleanup(nowMs: number): void {
    this.client.transaction(() => {
      this.client
        .prepare(
          `DELETE FROM auth_challenges
            WHERE expires_at_ms <= ? OR consumed_at_ms IS NOT NULL`
        )
        .run(nowMs)
      this.client
        .prepare(
          `DELETE FROM auth_sessions
            WHERE expires_at_ms <= ? OR (revoked_at_ms IS NOT NULL AND revoked_at_ms <= ?)`
        )
        .run(nowMs, nowMs - 24 * 60 * 60 * 1000)
      this.client
        .prepare(`DELETE FROM auth_throttles WHERE updated_at_ms <= ?`)
        .run(nowMs - 24 * 60 * 60 * 1000)
      this.client
        .prepare(`DELETE FROM auth_audit WHERE created_at_ms <= ?`)
        .run(nowMs - 90 * 24 * 60 * 60 * 1000)
    })()
  }
}
