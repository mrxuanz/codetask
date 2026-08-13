import type Database from 'better-sqlite3'
import type { Migration } from './v001_042/types.ts'

/** Match Conversation keyset pagination and bounded queue scans exactly. */
export const migration068ConversationQueryIndexes: Migration = {
  version: 68,
  name: 'conversation_query_indexes',
  up(db: Database.Database) {
    db.exec(`
      DROP INDEX IF EXISTS idx_conversation_messages_conversation;
      CREATE INDEX idx_conversation_messages_conversation
        ON conversation_messages(conversation_id, created_at, id);

      DROP INDEX IF EXISTS idx_conversation_turns_conversation_state;
      CREATE INDEX idx_conversation_turns_conversation_state
        ON conversation_turns(conversation_id, state, created_at, id);

      DROP INDEX IF EXISTS idx_conversation_turns_actor_state;
      CREATE INDEX idx_conversation_turns_actor_state
        ON conversation_turns(actor_id, state, created_at, id);
    `)
  }
}
