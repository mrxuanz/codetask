import type Database from 'better-sqlite3'
import { migration052ProjectsActorId } from '../../../../packages/database/src/migrations/projects-actor-id.ts'
import type { Migration } from './runner'

export const migration052ProjectsUsernameToActorId: Migration = {
  version: migration052ProjectsActorId.version,
  name: migration052ProjectsActorId.name,
  up(db: Database.Database) {
    migration052ProjectsActorId.up(db)
  }
}
