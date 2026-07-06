export interface RateLimitRule {
  maxRequests: number
  windowMs: number
}

export interface RateLimitResult {
  allowed: boolean
  retryAfterSec: number
  current: number
  limit: number
  overloaded: boolean
}

interface BucketEntry {
  count: number
  expiresAt: number
  lastSeenAt: number
}

const BUCKETS = new Map<string, BucketEntry>()

const MAX_KEYS = 20000
const CLEANUP_INTERVAL_MS = 60_000

let cleanupTimer: ReturnType<typeof setInterval> | null = null

function ensureCleanupTimer(): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    cleanupExpired()
  }, CLEANUP_INTERVAL_MS)
  if (cleanupTimer.unref) {
    cleanupTimer.unref()
  }
}

function cleanupExpired(): void {
  const now = Date.now()
  const keys = Array.from(BUCKETS.keys())
  for (const key of keys) {
    const entry = BUCKETS.get(key)
    if (entry && entry.expiresAt <= now) {
      BUCKETS.delete(key)
    }
  }
}

function evictIfNeeded(): void {
  if (BUCKETS.size <= MAX_KEYS) return

  const now = Date.now()
  const keys = Array.from(BUCKETS.keys())

  for (const key of keys) {
    const entry = BUCKETS.get(key)
    if (entry && entry.expiresAt <= now) {
      BUCKETS.delete(key)
    }
  }

  if (BUCKETS.size <= MAX_KEYS) return

  const sortedKeys = Array.from(BUCKETS.entries())
    .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)
    .map(([key]) => key)

  const toRemove = BUCKETS.size - MAX_KEYS
  for (let i = 0; i < toRemove && i < sortedKeys.length; i++) {
    BUCKETS.delete(sortedKeys[i])
  }
}

export function rateLimit(key: string, rule: RateLimitRule): RateLimitResult {
  ensureCleanupTimer()
  evictIfNeeded()

  const now = Date.now()
  const entry = BUCKETS.get(key)

  if (entry && entry.expiresAt > now) {
    entry.lastSeenAt = now
    if (entry.count >= rule.maxRequests) {
      const retryAfterSec = Math.ceil((entry.expiresAt - now) / 1000)
      return {
        allowed: false,
        retryAfterSec,
        current: entry.count,
        limit: rule.maxRequests,
        overloaded: false
      }
    }
    entry.count++
    return {
      allowed: true,
      retryAfterSec: 0,
      current: entry.count,
      limit: rule.maxRequests,
      overloaded: false
    }
  }

  if (BUCKETS.size >= MAX_KEYS) {
    return {
      allowed: false,
      retryAfterSec: 30,
      current: 0,
      limit: rule.maxRequests,
      overloaded: true
    }
  }

  BUCKETS.set(key, {
    count: 1,
    expiresAt: now + rule.windowMs,
    lastSeenAt: now
  })

  return {
    allowed: true,
    retryAfterSec: 0,
    current: 1,
    limit: rule.maxRequests,
    overloaded: false
  }
}

export const LOGIN_REQUEST_RULE: RateLimitRule = {
  maxRequests: 60,
  windowMs: 60_000
}

export const LOGIN_FAILURE_RULE: RateLimitRule = {
  maxRequests: 20,
  windowMs: 10 * 60_000
}

export const CAPTCHA_GEN_RULE: RateLimitRule = {
  maxRequests: 10,
  windowMs: 5 * 60_000
}

export function resetMemoryLimiter(): void {
  BUCKETS.clear()
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
}
