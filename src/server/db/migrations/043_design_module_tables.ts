import type Database from 'better-sqlite3'
import { migration043DesignModuleTables } from '../../../../packages/database/src/migrations/index.ts'
import type { Migration } from './runner'

/**
 * One-shot Design schema (01). Data backfill runs in migration044.
 */
export const migration043DesignModule: Migration = {
  version: migration043DesignModuleTables.version,
  name: migration043DesignModuleTables.name,
  up(db: Database.Database) {
    migration043DesignModuleTables.up(db)
  }
}
