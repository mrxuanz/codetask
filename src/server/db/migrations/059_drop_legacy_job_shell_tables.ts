import type Database from 'better-sqlite3'
import { migration059DropLegacyJobShellTables } from '../../../../packages/database/src/migrations/drop-legacy-job-shell-tables.ts'
import type { Migration } from './types'

export const migration059DropLegacyJobShellTablesHost: Migration = {
  version: migration059DropLegacyJobShellTables.version,
  name: migration059DropLegacyJobShellTables.name,
  up(db: Database.Database) {
    migration059DropLegacyJobShellTables.up(db)
  }
}
