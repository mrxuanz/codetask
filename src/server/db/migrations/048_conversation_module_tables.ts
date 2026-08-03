import type Database from 'better-sqlite3'
import { migration048ConversationModuleTables } from '../../../../packages/database/src/migrations/conversation.ts'
import type { Migration } from './types'

export const migration048ConversationModule: Migration = {
  version: migration048ConversationModuleTables.version,
  name: migration048ConversationModuleTables.name,
  up(db: Database.Database) {
    migration048ConversationModuleTables.up(db)
  }
}
