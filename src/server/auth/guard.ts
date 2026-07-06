import { eq, and } from 'drizzle-orm'
import { getDb } from '../db'
import { authGuardState, authRateBucket, captchaChallenge } from '../db/schema'

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function windowStartSec(windowMinutes: number): number {
  const windowSec = windowMinutes * 60
  return Math.floor(Math.floor(Date.now() / 1000) / windowSec) * windowSec
}

export interface GuardResult {
  allowed: boolean
  captchaRequired: boolean
  lockedUntil: number | null
  retryAfterSec: number
}

const GUARD_ROW_ID = 1

function getOrCreateGuardRow(): typeof authGuardState.$inferSelect {
  const db = getDb()
  const row = db.select().from(authGuardState).where(eq(authGuardState.id, GUARD_ROW_ID)).get()

  if (row) return row

  db.insert(authGuardState)
    .values({
      id: GUARD_ROW_ID,
      failCount: 0,
      captchaRequired: 0,
      updatedAt: nowSec()
    })
    .run()

  return db.select().from(authGuardState).where(eq(authGuardState.id, GUARD_ROW_ID)).get()!
}

function determineGuardResult(row: typeof authGuardState.$inferSelect): GuardResult {
  const now = nowSec()

  if (row.lockedUntil && row.lockedUntil > now) {
    return {
      allowed: false,
      captchaRequired: false,
      lockedUntil: row.lockedUntil,
      retryAfterSec: row.lockedUntil - now
    }
  }

  return {
    allowed: true,
    captchaRequired: row.captchaRequired !== 0,
    lockedUntil: null,
    retryAfterSec: 0
  }
}

export function checkGuardState(): GuardResult {
  const row = getOrCreateGuardRow()
  return determineGuardResult(row)
}

export function recordLoginFailure(): void {
  const db = getDb()
  const row = getOrCreateGuardRow()
  const now = nowSec()
  const newFailCount = row.failCount + 1

  let captchaRequired = row.captchaRequired ? 1 : 0
  let lockedUntil: number | null = null

  if (newFailCount === 5) {
    captchaRequired = 1
  }

  if (newFailCount >= 6 && newFailCount <= 9) {
    captchaRequired = 1
    const delays = [1, 2, 5, 10]
    lockedUntil = now + delays[newFailCount - 6]
  }

  if (newFailCount >= 10 && newFailCount <= 14) {
    captchaRequired = 1
    lockedUntil = now + 15 * 60
  } else if (newFailCount >= 15) {
    captchaRequired = 1
    lockedUntil = now + 30 * 60
  }

  db.update(authGuardState)
    .set({
      failCount: newFailCount,
      lastFailedAt: now,
      lockedUntil,
      captchaRequired,
      updatedAt: now
    })
    .where(eq(authGuardState.id, GUARD_ROW_ID))
    .run()
}

export function resetGuardState(): void {
  const db = getDb()
  db.update(authGuardState)
    .set({
      failCount: 0,
      lastFailedAt: null,
      lockedUntil: null,
      captchaRequired: 0,
      updatedAt: nowSec()
    })
    .where(eq(authGuardState.id, GUARD_ROW_ID))
    .run()
}

export function recordRateBucket(bucketKey: string, windowMinutes: number): void {
  const db = getDb()
  const start = windowStartSec(windowMinutes)
  const now = nowSec()

  const existing = db
    .select()
    .from(authRateBucket)
    .where(and(eq(authRateBucket.bucketKey, bucketKey), eq(authRateBucket.bucketStart, start)))
    .get()

  if (existing) {
    db.update(authRateBucket)
      .set({
        failCount: existing.failCount + 1,
        lastSeenAt: now
      })
      .where(and(eq(authRateBucket.bucketKey, bucketKey), eq(authRateBucket.bucketStart, start)))
      .run()
  } else {
    db.insert(authRateBucket)
      .values({
        bucketKey,
        bucketStart: start,
        failCount: 1,
        lastSeenAt: now
      })
      .run()
  }
}

export function deleteCaptchaForScope(scopeKey: string): void {
  const db = getDb()
  db.delete(captchaChallenge).where(eq(captchaChallenge.scopeKey, scopeKey)).run()
}
