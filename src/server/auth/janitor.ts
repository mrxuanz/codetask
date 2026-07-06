import { lte, or, isNotNull } from 'drizzle-orm'
import { getDb } from '../db'
import { captchaChallenge, authRateBucket } from '../db/schema'
import Database from 'better-sqlite3'

const CAPTCHA_MAX = 1000
const RATE_BUCKET_MAX = 50000
const INTERVAL_MS = 60_000

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function bucketKeepThresholdSec(): number {
  return nowSec() - 3600
}

let timer: ReturnType<typeof setInterval> | null = null

function getClient(): Database.Database {
  const db = getDb()
  const client = (db as unknown as { $client: Database.Database }).$client
  return client
}

export function startAuthJanitor(): void {
  if (timer) return

  void runAuthJanitorPass().catch((err) => {
    console.warn('[auth-janitor] startup pass failed', err)
  })

  timer = setInterval(() => {
    void runAuthJanitorPass().catch((err) => {
      console.warn('[auth-janitor] pass failed', err)
    })
  }, INTERVAL_MS)

  if (timer.unref) {
    timer.unref()
  }
}

export function stopAuthJanitor(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export async function runAuthJanitorPass(): Promise<void> {
  const db = getDb()
  const client = getClient()
  const now = nowSec()

  db.delete(captchaChallenge)
    .where(or(lte(captchaChallenge.expiresAt, now), isNotNull(captchaChallenge.usedAt)))
    .run()

  db.delete(authRateBucket).where(lte(authRateBucket.bucketStart, bucketKeepThresholdSec())).run()

  const captchaCount = client.prepare(`SELECT count(*) AS count FROM captcha_challenge`).get() as {
    count: number
  }

  if (captchaCount && captchaCount.count > CAPTCHA_MAX) {
    const toDelete = captchaCount.count - CAPTCHA_MAX + Math.floor(CAPTCHA_MAX * 0.1)
    client
      .prepare(
        `DELETE FROM captcha_challenge WHERE id IN (SELECT id FROM captcha_challenge ORDER BY created_at ASC LIMIT ?)`
      )
      .run(toDelete)
  }

  const bucketCount = client.prepare(`SELECT count(*) AS count FROM auth_rate_bucket`).get() as {
    count: number
  }

  if (bucketCount && bucketCount.count > RATE_BUCKET_MAX) {
    const toDelete = bucketCount.count - RATE_BUCKET_MAX + Math.floor(RATE_BUCKET_MAX * 0.1)
    client
      .prepare(
        `DELETE FROM auth_rate_bucket WHERE (bucket_key, bucket_start) IN (SELECT bucket_key, bucket_start FROM auth_rate_bucket ORDER BY bucket_start ASC LIMIT ?)`
      )
      .run(toDelete)
  }
}
