import { mkdirSync } from 'fs'
import { dirname } from 'path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { dataPaths } from '../data-paths'
import { applyMigrations } from './migrations/index'
import {
  appSettings,
  designPlanRevisions,
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
  jobTaskAttempts,
  projects,
  threadJobs,
  threadMessages,
  conversationTurns,
  threads,
  workloadRuns,
  workloadSlots,
  workspaceLeases,
  deletionRequests,
  changeSets
} from './schema'

const schema = {
  appSettings,
  designPlanRevisions,
  authState,
  authGuardState,
  authRateBucket,
  captchaChallenge,
  projects,
  threads,
  threadMessages,
  conversationTurns,
  threadJobs,
  jobTasks,
  jobTaskAttempts,
  jobArtifacts,
  jobCounters,
  messageArtifacts,
  jobAbilities,
  jobPlanTasks,
  jobPlanMilestones,
  jobPlanSlices,
  workloadRuns,
  workloadSlots,
  workspaceLeases,
  deletionRequests,
  changeSets
}

export type AppDatabase = BetterSQLite3Database<typeof schema>

/** Test helper for migration fixtures that already own a SQLite client. */
export function createAppDatabaseForTests(client: Database.Database): AppDatabase {
  return drizzle(client, { schema })
}

let db: AppDatabase | null = null

export function createIsolatedTestDatabase(dataDir: string): AppDatabase {
  const dbFile = dataPaths(dataDir).dbFile
  mkdirSync(dirname(dbFile), { recursive: true })
  const sqlite = new Database(dbFile)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('auto_vacuum = INCREMENTAL')
  applyMigrations(sqlite)
  return createAppDatabaseForTests(sqlite)
}

export function closeIsolatedTestDatabase(database: AppDatabase): void {
  const client = (database as AppDatabase & { $client?: Database.Database }).$client
  client?.close()
}

export function createDatabase(dataDir: string): AppDatabase {
  if (db) return db

  const dbFile = dataPaths(dataDir).dbFile
  mkdirSync(dirname(dbFile), { recursive: true })
  const sqlite = new Database(dbFile)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('auto_vacuum = INCREMENTAL')
  applyMigrations(sqlite)
  db = createAppDatabaseForTests(sqlite)
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
