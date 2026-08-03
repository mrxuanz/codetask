import type Database from 'better-sqlite3'
import { migration046ExecutionDataMigrate } from '../../../../packages/database/src/migrations/execution-data-migrate.ts'
import type { Migration } from './types'

export const migration046ExecutionData: Migration = {
  version: migration046ExecutionDataMigrate.version,
  name: migration046ExecutionDataMigrate.name,
  up(db: Database.Database) {
    migration046ExecutionDataMigrate.up(db)
  }
}
