import type Database from 'better-sqlite3'
import type { getDb } from '../db'
import type { SettingsStore } from '../context/settings-store'
import type { RetentionSettings } from '@codetask/contracts'

type AppDatabase = ReturnType<typeof getDb>

const LAST_SQLITE_MAINTENANCE_KEY = 'lastSqliteMaintenanceAt'

function sqliteClient(db: AppDatabase): Database.Database | null {
  return (db as AppDatabase & { $client?: Database.Database }).$client ?? null
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function readLastSqliteMaintenanceAt(store: SettingsStore): number {
  const value = store.readNamespace('runtime_maintenance').value
  if (!value) return 0
  const at = value[LAST_SQLITE_MAINTENANCE_KEY]
  return typeof at === 'number' ? at : 0
}

function writeLastSqliteMaintenanceAt(store: SettingsStore, at: number): void {
  const current = store.readNamespace('runtime_maintenance')
  store.writeNamespace(
    'runtime_maintenance',
    {
      ...(current.value ?? {}),
      [LAST_SQLITE_MAINTENANCE_KEY]: at
    },
    { expectedRevision: current.revision }
  )
}

export function shouldRunSqliteMaintenance(
  store: SettingsStore,
  settings: RetentionSettings,
  now = nowSec()
): boolean {
  const intervalHours = settings.sqliteMaintenanceIntervalHours
  if (intervalHours <= 0) return false
  const lastAt = readLastSqliteMaintenanceAt(store)
  return now - lastAt >= intervalHours * 3_600
}

export function runSqliteMaintenance(db: AppDatabase): {
  checkpointed: boolean
  vacuumedPages: number
} {
  const sqlite = sqliteClient(db)
  if (!sqlite) {
    return { checkpointed: false, vacuumedPages: 0 }
  }

  sqlite.pragma('wal_checkpoint(PASSIVE)')
  const vacuumResult = sqlite.pragma('incremental_vacuum(200)', { simple: true })
  sqlite.pragma('optimize')

  return {
    checkpointed: true,
    vacuumedPages: typeof vacuumResult === 'number' ? vacuumResult : 0
  }
}

export function runSqliteMaintenanceIfDue(input: {
  db: AppDatabase
  store: SettingsStore
  settings: RetentionSettings
}): { ran: boolean; checkpointed: boolean; vacuumedPages: number } {
  if (!shouldRunSqliteMaintenance(input.store, input.settings)) {
    return { ran: false, checkpointed: false, vacuumedPages: 0 }
  }

  const result = runSqliteMaintenance(input.db)
  writeLastSqliteMaintenanceAt(input.store, nowSec())
  return { ran: true, ...result }
}
