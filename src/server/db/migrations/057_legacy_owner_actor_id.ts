import type Database from 'better-sqlite3'
import { migration057LegacyOwnerActorId } from '../../../../packages/database/src/migrations/legacy-owner-actor-id.ts'
import type { Migration } from './types'

export const migration057LegacyOwnerActorIdTables: Migration = {
  version: migration057LegacyOwnerActorId.version,
  name: migration057LegacyOwnerActorId.name,
  up(db: Database.Database) {
    migration057LegacyOwnerActorId.up(db)
  }
}
