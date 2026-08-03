import type Database from 'better-sqlite3'
import { migration058DeletionRequestsActorId } from '../../../../packages/database/src/migrations/deletion-requests-actor-id.ts'
import type { Migration } from './types'

export const migration058DeletionRequestsActorIdTables: Migration = {
  version: migration058DeletionRequestsActorId.version,
  name: migration058DeletionRequestsActorId.name,
  up(db: Database.Database) {
    migration058DeletionRequestsActorId.up(db)
  }
}
