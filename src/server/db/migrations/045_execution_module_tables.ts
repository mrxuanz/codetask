import type Database from 'better-sqlite3'
import { migration045ExecutionModuleTables } from '../../../../packages/database/src/migrations/execution.ts'
import type { Migration } from './types'

export const migration045ExecutionModule: Migration = {
  version: migration045ExecutionModuleTables.version,
  name: migration045ExecutionModuleTables.name,
  up(db: Database.Database) {
    migration045ExecutionModuleTables.up(db)
  }
}
