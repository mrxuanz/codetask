import type { AuthPrincipal } from '../domain/actor.ts'
import type { AuthUserRecord } from '../domain/account.ts'

export type AuthThrottleRecord = {
  key: string
  windowStartedAtMs: number
  requestCount: number
  failureCount: number
  captchaRequired: boolean
  lockedUntilMs: number | null
  updatedAtMs: number
}

export type AuthChallengeRecord = {
  id: string
  scopeKey: string
  answerDigest: string
  attempts: number
  maxAttempts: number
  expiresAtMs: number
  consumedAtMs: number | null
}

export interface AuthRepository {
  getUser(): AuthUserRecord | null
  createUser(input: {
    username: string
    normalizedUsername: string
    passwordHash: string
    nowMs: number
  }): AuthUserRecord
  updatePassword(userId: string, passwordHash: string, nowMs: number): void
  createSession(input: {
    userId: string
    tokenDigest: string
    nowMs: number
    expiresAtMs: number
    maximumSessions: number
  }): { id: string }
  findActiveSession(tokenDigest: string, nowMs: number): AuthPrincipal | null
  isSessionActive(sessionId: string, userId: string, nowMs: number): boolean
  revokeSession(tokenDigest: string, nowMs: number, reason: string): void
  revokeUserSessions(userId: string, nowMs: number, reason: string): void
  getThrottle(key: string): AuthThrottleRecord | null
  putThrottle(row: AuthThrottleRecord): void
  deleteThrottle(key: string): void
  replaceChallenge(input: {
    id: string
    scopeKey: string
    answerDigest: string
    maxAttempts: number
    expiresAtMs: number
    nowMs: number
  }): void
  getChallenge(id: string, scopeKey: string): AuthChallengeRecord | null
  recordChallengeAttempt(id: string, consumedAtMs?: number): void
  deleteChallengeForScope(scopeKey: string): void
  audit(input: {
    eventType: string
    userId?: string
    subjectDigest?: string
    scopeDigest?: string
    success: boolean
    reasonCode?: string
    nowMs: number
  }): void
  cleanup(nowMs: number): void
}
