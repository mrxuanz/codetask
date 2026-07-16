import type { Migration } from './types'

function hasColumn(
  db: { prepare: (sql: string) => { all: () => Array<{ name: string }> } },
  table: string,
  column: string
): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((entry) => entry.name === column)
}

/** Link an isolated code-change Turn to its Change Set worktree. */
export const migration040ConversationTurnChangeSets: Migration = {
  version: 40,
  name: 'conversation_turn_change_sets',
  up(db) {
    if (!hasColumn(db, 'conversation_turns', 'change_set_id')) {
      db.exec(`ALTER TABLE conversation_turns ADD COLUMN change_set_id TEXT`)
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversation_turns_change_set
      ON conversation_turns (change_set_id)
    `)
  }
}
