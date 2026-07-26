import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { KernelSqliteDatabase } from './database'
import { SqliteUnitOfWork } from './unit-of-work'

interface LegacyAuthRow {
  username: string
  password_hash: string
  created_at: number
}

export type LegacyAuthMigrationResult = 'not_present' | 'already_migrated' | 'migrated'

export function migrateLegacyAuthIfNeeded(input: {
  readonly legacyDatabase: Database.Database
  readonly kernelDatabase: KernelSqliteDatabase
  readonly nowMs?: () => number
}): LegacyAuthMigrationResult {
  const table = input.legacyDatabase
    .prepare(
      `SELECT 1 AS present
       FROM sqlite_master
       WHERE type = 'table' AND name = 'auth_state'`
    )
    .get() as { present: number } | undefined
  if (!table) return 'not_present'

  const legacy = input.legacyDatabase
    .prepare(
      `SELECT username, password_hash, created_at
       FROM auth_state
       WHERE id = 1`
    )
    .get() as LegacyAuthRow | undefined
  if (!legacy) return 'not_present'

  const username = legacy.username.trim()
  if (
    !username ||
    username.length > 64 ||
    !legacy.password_hash ||
    legacy.password_hash.length > 1_024
  ) {
    throw new Error('auth.legacy_record.invalid')
  }

  const nowMs = input.nowMs?.() ?? Date.now()
  const unitOfWork = new SqliteUnitOfWork(input.kernelDatabase)
  return unitOfWork.transaction((transaction) => {
    if (transaction.auth.getUser()) return 'already_migrated'
    const userId = randomUUID()
    transaction.auth.insertUser({
      id: userId,
      username,
      normalizedUsername: username.toLowerCase(),
      passwordHash: legacy.password_hash,
      passwordVersion: 1,
      createdAtMs: Math.max(0, legacy.created_at * 1_000),
      updatedAtMs: nowMs,
      disabledAtMs: null
    })
    transaction.auth.appendAudit({
      eventType: 'account.migrated',
      userId,
      subjectDigest: null,
      scopeDigest: null,
      success: true,
      reasonCode: 'auth.legacy_account_migrated_sessions_revoked',
      createdAtMs: nowMs
    })
    return 'migrated'
  })
}
