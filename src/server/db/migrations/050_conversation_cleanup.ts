import type Database from 'better-sqlite3'
import { migration050ConversationCleanup } from '../../../../packages/database/src/migrations/conversation-cleanup.ts'
import type { Migration } from './types'

export const migration050ConversationCleanupTables: Migration = {
  version: migration050ConversationCleanup.version,
  name: migration050ConversationCleanup.name,
  up(db: Database.Database) {
    migration050ConversationCleanup.up(db)
  }
}
