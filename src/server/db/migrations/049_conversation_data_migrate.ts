import type Database from 'better-sqlite3'
import { migration049ConversationDataMigrate } from '../../../../packages/database/src/migrations/conversation-data.ts'
import type { Migration } from './runner'

export const migration049ConversationData: Migration = {
  version: migration049ConversationDataMigrate.version,
  name: migration049ConversationDataMigrate.name,
  up(db: Database.Database) {
    migration049ConversationDataMigrate.up(db)
  }
}
