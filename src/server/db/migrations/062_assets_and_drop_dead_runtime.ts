import type Database from 'better-sqlite3'
import { migration062AssetsAndDropDeadRuntimeTables } from '../../../../packages/database/src/migrations/assets-and-drop-dead-runtime.ts'
import type { Migration } from './types'

export const migration062AssetsAndDropDeadRuntimeTablesHost: Migration = {
  version: migration062AssetsAndDropDeadRuntimeTables.version,
  name: migration062AssetsAndDropDeadRuntimeTables.name,
  up(db: Database.Database) {
    migration062AssetsAndDropDeadRuntimeTables.up(db)
  }
}
