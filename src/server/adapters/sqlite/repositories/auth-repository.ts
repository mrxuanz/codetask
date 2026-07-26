import type Database from 'better-sqlite3'
import type {
  AuthAuditRecord,
  AuthChallengeRecord,
  AuthCleanupResult,
  AuthRepository,
  AuthSessionRecord,
  AuthThrottleRecord,
  AuthUserRecord
} from '../../../core/application/ports'

interface AuthUserRow {
  id: string
  username: string
  normalized_username: string
  password_hash: string
  password_version: number
  created_at_ms: number
  updated_at_ms: number
  disabled_at_ms: number | null
}

interface AuthSessionRow {
  id: string
  user_id: string
  token_digest: string
  created_at_ms: number
  last_seen_at_ms: number
  expires_at_ms: number
  revoked_at_ms: number | null
  revoke_reason: string | null
}

interface AuthThrottleRow {
  key: string
  window_started_at_ms: number
  request_count: number
  failure_count: number
  captcha_required: number
  locked_until_ms: number | null
  updated_at_ms: number
}

interface AuthChallengeRow {
  id: string
  scope_key: string
  answer_digest: string
  attempts: number
  max_attempts: number
  expires_at_ms: number
  consumed_at_ms: number | null
  created_at_ms: number
}

function mapUser(row: AuthUserRow | undefined): AuthUserRecord | null {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    normalizedUsername: row.normalized_username,
    passwordHash: row.password_hash,
    passwordVersion: row.password_version,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    disabledAtMs: row.disabled_at_ms
  }
}

function mapSession(row: AuthSessionRow | undefined): AuthSessionRecord | null {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    tokenDigest: row.token_digest,
    createdAtMs: row.created_at_ms,
    lastSeenAtMs: row.last_seen_at_ms,
    expiresAtMs: row.expires_at_ms,
    revokedAtMs: row.revoked_at_ms,
    revokeReason: row.revoke_reason
  }
}

function mapThrottle(row: AuthThrottleRow | undefined): AuthThrottleRecord | null {
  if (!row) return null
  return {
    key: row.key,
    windowStartedAtMs: row.window_started_at_ms,
    requestCount: row.request_count,
    failureCount: row.failure_count,
    captchaRequired: row.captcha_required === 1,
    lockedUntilMs: row.locked_until_ms,
    updatedAtMs: row.updated_at_ms
  }
}

function mapChallenge(row: AuthChallengeRow | undefined): AuthChallengeRecord | null {
  if (!row) return null
  return {
    id: row.id,
    scopeKey: row.scope_key,
    answerDigest: row.answer_digest,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    expiresAtMs: row.expires_at_ms,
    consumedAtMs: row.consumed_at_ms,
    createdAtMs: row.created_at_ms
  }
}

export class SqliteAuthRepository implements AuthRepository {
  constructor(private readonly database: Database.Database) {}

  getUser(): AuthUserRecord | null {
    return mapUser(
      this.database
        .prepare(
          `SELECT id, username, normalized_username, password_hash, password_version,
                  created_at_ms, updated_at_ms, disabled_at_ms
           FROM auth_users
           WHERE singleton_key = 1`
        )
        .get() as AuthUserRow | undefined
    )
  }

  getUserByNormalizedUsername(normalizedUsername: string): AuthUserRecord | null {
    return mapUser(
      this.database
        .prepare(
          `SELECT id, username, normalized_username, password_hash, password_version,
                  created_at_ms, updated_at_ms, disabled_at_ms
           FROM auth_users
           WHERE normalized_username = ?`
        )
        .get(normalizedUsername) as AuthUserRow | undefined
    )
  }

  insertUser(record: AuthUserRecord): void {
    this.database
      .prepare(
        `INSERT INTO auth_users
           (id, singleton_key, username, normalized_username, password_hash,
            password_version, created_at_ms, updated_at_ms, disabled_at_ms)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.username,
        record.normalizedUsername,
        record.passwordHash,
        record.passwordVersion,
        record.createdAtMs,
        record.updatedAtMs,
        record.disabledAtMs
      )
  }

  updatePassword(input: {
    readonly userId: string
    readonly expectedVersion: number
    readonly passwordHash: string
    readonly updatedAtMs: number
  }): boolean {
    return (
      this.database
        .prepare(
          `UPDATE auth_users
           SET password_hash = ?,
               password_version = password_version + 1,
               updated_at_ms = ?
           WHERE id = ? AND password_version = ?`
        )
        .run(input.passwordHash, input.updatedAtMs, input.userId, input.expectedVersion).changes ===
      1
    )
  }

  getSessionByDigest(tokenDigest: string): AuthSessionRecord | null {
    return mapSession(
      this.database
        .prepare(
          `SELECT id, user_id, token_digest, created_at_ms, last_seen_at_ms,
                  expires_at_ms, revoked_at_ms, revoke_reason
           FROM auth_sessions
           WHERE token_digest = ?`
        )
        .get(tokenDigest) as AuthSessionRow | undefined
    )
  }

  insertSession(record: AuthSessionRecord): void {
    this.database
      .prepare(
        `INSERT INTO auth_sessions
           (id, user_id, token_digest, created_at_ms, last_seen_at_ms,
            expires_at_ms, revoked_at_ms, revoke_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.userId,
        record.tokenDigest,
        record.createdAtMs,
        record.lastSeenAtMs,
        record.expiresAtMs,
        record.revokedAtMs,
        record.revokeReason
      )
  }

  touchSession(id: string, lastSeenAtMs: number): boolean {
    return (
      this.database
        .prepare(
          `UPDATE auth_sessions
           SET last_seen_at_ms = ?
           WHERE id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?`
        )
        .run(lastSeenAtMs, id, lastSeenAtMs).changes === 1
    )
  }

  revokeSessionByDigest(tokenDigest: string, revokedAtMs: number, reason: string): boolean {
    return (
      this.database
        .prepare(
          `UPDATE auth_sessions
           SET revoked_at_ms = ?, revoke_reason = ?
           WHERE token_digest = ? AND revoked_at_ms IS NULL`
        )
        .run(revokedAtMs, reason, tokenDigest).changes === 1
    )
  }

  revokeAllSessions(userId: string, revokedAtMs: number, reason: string): number {
    return this.database
      .prepare(
        `UPDATE auth_sessions
         SET revoked_at_ms = ?, revoke_reason = ?
         WHERE user_id = ? AND revoked_at_ms IS NULL`
      )
      .run(revokedAtMs, reason, userId).changes
  }

  revokeExcessSessions(
    userId: string,
    keepNewest: number,
    revokedAtMs: number,
    reason: string
  ): number {
    const result = this.database
      .prepare(
        `UPDATE auth_sessions
         SET revoked_at_ms = ?, revoke_reason = ?
         WHERE id IN (
           SELECT id
           FROM auth_sessions
           WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
           ORDER BY created_at_ms DESC, id DESC
           LIMIT -1 OFFSET ?
         )`
      )
      .run(revokedAtMs, reason, userId, revokedAtMs, keepNewest)
    return result.changes
  }

  getThrottle(key: string): AuthThrottleRecord | null {
    return mapThrottle(
      this.database
        .prepare(
          `SELECT key, window_started_at_ms, request_count, failure_count,
                  captcha_required, locked_until_ms, updated_at_ms
           FROM auth_throttles
           WHERE key = ?`
        )
        .get(key) as AuthThrottleRow | undefined
    )
  }

  putThrottle(record: AuthThrottleRecord): void {
    this.database
      .prepare(
        `INSERT INTO auth_throttles
           (key, window_started_at_ms, request_count, failure_count,
            captcha_required, locked_until_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           window_started_at_ms = excluded.window_started_at_ms,
           request_count = excluded.request_count,
           failure_count = excluded.failure_count,
           captcha_required = excluded.captcha_required,
           locked_until_ms = excluded.locked_until_ms,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        record.key,
        record.windowStartedAtMs,
        record.requestCount,
        record.failureCount,
        record.captchaRequired ? 1 : 0,
        record.lockedUntilMs,
        record.updatedAtMs
      )
  }

  deleteThrottle(key: string): boolean {
    return this.database.prepare(`DELETE FROM auth_throttles WHERE key = ?`).run(key).changes === 1
  }

  insertChallenge(record: AuthChallengeRecord): void {
    this.database
      .prepare(
        `INSERT INTO auth_challenges
           (id, scope_key, answer_digest, attempts, max_attempts,
            expires_at_ms, consumed_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.scopeKey,
        record.answerDigest,
        record.attempts,
        record.maxAttempts,
        record.expiresAtMs,
        record.consumedAtMs,
        record.createdAtMs
      )
  }

  getChallenge(id: string, scopeKey: string): AuthChallengeRecord | null {
    return mapChallenge(
      this.database
        .prepare(
          `SELECT id, scope_key, answer_digest, attempts, max_attempts,
                  expires_at_ms, consumed_at_ms, created_at_ms
           FROM auth_challenges
           WHERE id = ? AND scope_key = ?`
        )
        .get(id, scopeKey) as AuthChallengeRow | undefined
    )
  }

  putChallenge(record: AuthChallengeRecord): void {
    this.database
      .prepare(
        `UPDATE auth_challenges
         SET attempts = ?, consumed_at_ms = ?
         WHERE id = ? AND scope_key = ?`
      )
      .run(record.attempts, record.consumedAtMs, record.id, record.scopeKey)
  }

  deleteChallengesForScope(scopeKey: string): number {
    return this.database.prepare(`DELETE FROM auth_challenges WHERE scope_key = ?`).run(scopeKey)
      .changes
  }

  countActiveChallenges(nowMs: number): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM auth_challenges
         WHERE consumed_at_ms IS NULL AND expires_at_ms > ?`
      )
      .get(nowMs) as { count: number }
    return row.count
  }

  appendAudit(record: AuthAuditRecord): number {
    const result = this.database
      .prepare(
        `INSERT INTO auth_audit
           (event_type, user_id, subject_digest, scope_digest, success, reason_code, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.eventType,
        record.userId,
        record.subjectDigest,
        record.scopeDigest,
        record.success ? 1 : 0,
        record.reasonCode,
        record.createdAtMs
      )
    return Number(result.lastInsertRowid)
  }

  cleanup(nowMs: number, throttleBeforeMs: number): AuthCleanupResult {
    const sessions = this.database
      .prepare(
        `DELETE FROM auth_sessions
         WHERE expires_at_ms <= ? OR revoked_at_ms IS NOT NULL`
      )
      .run(nowMs).changes
    const challenges = this.database
      .prepare(
        `DELETE FROM auth_challenges
         WHERE expires_at_ms <= ? OR consumed_at_ms IS NOT NULL`
      )
      .run(nowMs).changes
    const throttles = this.database
      .prepare(`DELETE FROM auth_throttles WHERE updated_at_ms < ?`)
      .run(throttleBeforeMs).changes
    return { sessions, challenges, throttles }
  }
}
