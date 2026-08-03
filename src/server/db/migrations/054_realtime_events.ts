import type Database from 'better-sqlite3'
import { migration054RealtimeEvents as realtimeEventsMigration } from '../../../../packages/database/src/migrations/realtime-events.ts'
import type { Migration } from './types'

export const migration054RealtimeEvents: Migration = {
  version: realtimeEventsMigration.version,
  name: realtimeEventsMigration.name,
  up(db: Database.Database) {
    realtimeEventsMigration.up(db)
  }
}
