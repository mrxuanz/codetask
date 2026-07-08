import { mkdirSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { applyMigrations } from './migrations/index'
import {
  authState,
  authGuardState,
  authRateBucket,
  captchaChallenge,
  jobAbilities,
  jobArtifacts,
  jobCounters,
  messageArtifacts,
  jobPlanMilestones,
  jobPlanSlices,
  jobPlanTasks,
  jobTasks,
  projects,
  threadJobs,
  threadMessages,
  threads,
  workloadRuns,
  workloadSlots
} from './schema'

const schema = {
  authState,
  authGuardState,
  authRateBucket,
  captchaChallenge,
  projects,
  threads,
  threadMessages,
  threadJobs,
  jobTasks,
  jobArtifacts,
  jobCounters,
  messageArtifacts,
  jobAbilities,
  jobPlanTasks,
  jobPlanMilestones,
  jobPlanSlices,
  workloadRuns,
  workloadSlots
}

export type AppDatabase = BetterSQLite3Database<typeof schema>

let db: AppDatabase | null = null

export function createIsolatedTestDatabase(dataDir: string): AppDatabase {
  mkdirSync(dataDir, { recursive: true })
  const sqlite = new Database(join(dataDir, 'app.db'))
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('auto_vacuum = INCREMENTAL')
  applyMigrations(sqlite)
  return drizzle(sqlite, { schema })
}

export function closeIsolatedTestDatabase(database: AppDatabase): void {
  const client = (database as AppDatabase & { $client?: Database.Database }).$client
  client?.close()
}

export function createDatabase(dataDir: string): AppDatabase {
  if (db) return db

  mkdirSync(dataDir, { recursive: true })
  const sqlite = new Database(join(dataDir, 'app.db'))
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('auto_vacuum = INCREMENTAL')
  applyMigrations(sqlite)
  db = drizzle(sqlite, { schema })
  return db
}

export function initDb(dataDir: string): AppDatabase {
  return createDatabase(dataDir)
}

export function getDb(): AppDatabase {
  if (!db) {
    throw new Error('Database not initialized')
  }
  return db
}

export function closeDatabaseForTests(): void {
  if (!db) return
  const client = (db as AppDatabase & { $client?: Database.Database }).$client
  client?.close()
  db = null
}
