import type Database from 'better-sqlite3'
import { migration047DropControlPlaneTables } from '../../../../packages/database/src/migrations/drop-control-plane.ts'
import type { Migration } from './types'

export const migration047DropControlPlane: Migration = {
  version: migration047DropControlPlaneTables.version,
  name: migration047DropControlPlaneTables.name,
  up(db: Database.Database) {
    migration047DropControlPlaneTables.up(db)
  }
}
