import type Database from 'better-sqlite3'
import { migration065DropLegacyThreadTables } from '../../../../packages/database/src/migrations/drop-legacy-thread-tables.ts'
import type { Migration } from './types'

export const migration065DropLegacyThreadTablesHost: Migration = {
  version: migration065DropLegacyThreadTables.version,
  name: migration065DropLegacyThreadTables.name,
  up(db: Database.Database) {
    migration065DropLegacyThreadTables.up(db)
  }
}
