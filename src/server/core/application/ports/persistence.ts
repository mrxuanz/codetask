export interface AuthUserRecord {
  readonly id: string
  readonly username: string
  readonly normalizedUsername: string
  readonly passwordHash: string
  readonly passwordVersion: number
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly disabledAtMs: number | null
}

export interface AuthSessionRecord {
  readonly id: string
  readonly userId: string
  readonly tokenDigest: string
  readonly createdAtMs: number
  readonly lastSeenAtMs: number
  readonly expiresAtMs: number
  readonly revokedAtMs: number | null
  readonly revokeReason: string | null
}

export interface AuthThrottleRecord {
  readonly key: string
  readonly windowStartedAtMs: number
  readonly requestCount: number
  readonly failureCount: number
  readonly captchaRequired: boolean
  readonly lockedUntilMs: number | null
  readonly updatedAtMs: number
}

export interface AuthChallengeRecord {
  readonly id: string
  readonly scopeKey: string
  readonly answerDigest: string
  readonly attempts: number
  readonly maxAttempts: number
  readonly expiresAtMs: number
  readonly consumedAtMs: number | null
  readonly createdAtMs: number
}

export interface AuthAuditRecord {
  readonly eventType: string
  readonly userId: string | null
  readonly subjectDigest: string | null
  readonly scopeDigest: string | null
  readonly success: boolean
  readonly reasonCode: string
  readonly createdAtMs: number
}

export interface AuthCleanupResult {
  readonly sessions: number
  readonly challenges: number
  readonly throttles: number
}

export interface AuthRepository {
  getUser(): AuthUserRecord | null
  getUserByNormalizedUsername(normalizedUsername: string): AuthUserRecord | null
  insertUser(record: AuthUserRecord): void
  updatePassword(input: {
    readonly userId: string
    readonly expectedVersion: number
    readonly passwordHash: string
    readonly updatedAtMs: number
  }): boolean
  getSessionByDigest(tokenDigest: string): AuthSessionRecord | null
  insertSession(record: AuthSessionRecord): void
  touchSession(id: string, lastSeenAtMs: number): boolean
  revokeSessionByDigest(tokenDigest: string, revokedAtMs: number, reason: string): boolean
  revokeAllSessions(userId: string, revokedAtMs: number, reason: string): number
  revokeExcessSessions(
    userId: string,
    keepNewest: number,
    revokedAtMs: number,
    reason: string
  ): number
  getThrottle(key: string): AuthThrottleRecord | null
  putThrottle(record: AuthThrottleRecord): void
  deleteThrottle(key: string): boolean
  insertChallenge(record: AuthChallengeRecord): void
  getChallenge(id: string, scopeKey: string): AuthChallengeRecord | null
  putChallenge(record: AuthChallengeRecord): void
  deleteChallengesForScope(scopeKey: string): number
  countActiveChallenges(nowMs: number): number
  appendAudit(record: AuthAuditRecord): number
  cleanup(nowMs: number, throttleBeforeMs: number): AuthCleanupResult
}

export interface KernelTransaction {
  readonly auth: AuthRepository
}

export interface UnitOfWork {
  transaction<T>(work: (transaction: KernelTransaction) => T): T
}
