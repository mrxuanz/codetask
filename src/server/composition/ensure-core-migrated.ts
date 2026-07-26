/**
 * Boot-time one-shot: migrate legacy db → core when core is empty.
 * Never crashes bootstrap — unmappable / IO errors are logged and skipped.
 */
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import {
  migrateLegacyToCore,
  UnmappableLegacyRowError,
  type MigrationReport
} from '../adapters/sqlite/index.ts'
import { dataPaths } from '../data-paths.ts'

export type EnsureCoreMigratedLogger = {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

export type EnsureCoreMigratedResult = {
  migrated: boolean
  report?: MigrationReport
  reason: string
}

function coreHasData(coreSqlitePath: string): boolean {
  if (!existsSync(coreSqlitePath)) return false
  const db = new Database(coreSqlitePath, { readonly: true, fileMustExist: true })
  try {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('core_threads', 'core_jobs')`
      )
      .all() as Array<{ name: string }>
    if (tables.length === 0) return false

    const threadCount = tables.some((t) => t.name === 'core_threads')
      ? (
          db.prepare(`SELECT COUNT(*) AS n FROM core_threads`).get() as {
            n: number
          }
        ).n
      : 0
    const jobCount = tables.some((t) => t.name === 'core_jobs')
      ? (db.prepare(`SELECT COUNT(*) AS n FROM core_jobs`).get() as { n: number }).n
      : 0
    return threadCount > 0 || jobCount > 0
  } finally {
    db.close()
  }
}

/**
 * If core DB has no threads/jobs and a legacy db exists, run offline migrate.
 * Safe to call on every boot; idempotent once core is nonempty.
 */
export function ensureCoreMigrated(input: {
  dataDir: string
  coreSqlitePath: string
  logger?: EnsureCoreMigratedLogger
}): EnsureCoreMigratedResult {
  const logger = input.logger

  try {
    if (coreHasData(input.coreSqlitePath)) {
      const result = { migrated: false, reason: 'core-nonempty' }
      logger?.info('ensureCoreMigrated: skip', result)
      return result
    }

    const legacyDb = dataPaths(input.dataDir).dbFile
    if (!existsSync(legacyDb)) {
      const result = { migrated: false, reason: 'no-legacy-db' }
      logger?.info('ensureCoreMigrated: skip', { ...result, legacyDb })
      return result
    }

    const report = migrateLegacyToCore({
      sourcePath: legacyDb,
      targetPath: input.coreSqlitePath
    })
    const result = { migrated: true, report, reason: 'migrated' }
    logger?.info('ensureCoreMigrated: migrated', {
      reason: result.reason,
      counts: report.counts,
      hash: report.hash
    })
    return result
  } catch (err) {
    if (err instanceof UnmappableLegacyRowError) {
      logger?.warn('ensureCoreMigrated: unmappable legacy row; skipping', {
        message: err.message,
        details: err.details
      })
      return { migrated: false, reason: 'unmappable' }
    }
    logger?.warn('ensureCoreMigrated: failed; skipping', {
      message: err instanceof Error ? err.message : String(err)
    })
    return { migrated: false, reason: 'error' }
  }
}
