import type Database from 'better-sqlite3'
import { migration051ActorIdRemap } from '../../../../packages/database/src/migrations/auth-actor-remap.ts'
import type { Migration } from './runner'

export const migration051ActorIdUsernameToUserId: Migration = {
  version: migration051ActorIdRemap.version,
  name: migration051ActorIdRemap.name,
  up(db: Database.Database) {
    migration051ActorIdRemap.up(db)
  }
}
