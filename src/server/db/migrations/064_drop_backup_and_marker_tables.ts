import type Database from 'better-sqlite3'
import { migration064DropBackupAndMarkerTables } from '../../../../packages/database/src/migrations/drop-backup-and-marker-tables.ts'
import type { Migration } from './types'

export const migration064DropBackupAndMarkerTablesHost: Migration = {
  version: migration064DropBackupAndMarkerTables.version,
  name: migration064DropBackupAndMarkerTables.name,
  up(db: Database.Database) {
    migration064DropBackupAndMarkerTables.up(db)
  }
}
