import type Database from 'better-sqlite3'
import { migration056TightenLegacyThreadSchema } from '../../../../packages/database/src/migrations/tighten-legacy-thread-schema.ts'
import type { Migration } from './types'

export const migration056TightenLegacyThreadSchemaTables: Migration = {
  version: migration056TightenLegacyThreadSchema.version,
  name: migration056TightenLegacyThreadSchema.name,
  up(db: Database.Database) {
    migration056TightenLegacyThreadSchema.up(db)
  }
}
