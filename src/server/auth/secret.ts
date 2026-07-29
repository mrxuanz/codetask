import { createHmac } from 'crypto'
import type Database from 'better-sqlite3'
import type { AppDatabase } from '../db'

const AUTH_SECRET_PATTERN = /^[a-f0-9]{64}$/u

type AuthSecretSqlite = Pick<Database.Database, 'prepare'>

/** Read the installation secret created by the SQLite migration. */
export function readSqliteAuthSecret(db: AuthSecretSqlite): string {
  const row = db
    .prepare(`SELECT secret_hex AS secret FROM auth_secret WHERE singleton_key = 1`)
    .get() as { secret?: unknown } | undefined
  const secret = row?.secret
  if (typeof secret !== 'string' || !AUTH_SECRET_PATTERN.test(secret)) {
    throw new Error('SQLite auth secret is missing or corrupt')
  }
  return secret
}

/** Keep the Drizzle/raw-client boundary inside the Hono core. */
export function loadDatabaseAuthSecret(db: AppDatabase): string {
  const client = (db as AppDatabase & { $client?: AuthSecretSqlite }).$client
  if (!client) throw new Error('SQLite client is unavailable')
  return readSqliteAuthSecret(client)
}

export function hmacAuthSecret(authSecret: string, ...parts: string[]): string {
  return createHmac('sha256', authSecret).update(parts.join('')).digest('hex')
}
