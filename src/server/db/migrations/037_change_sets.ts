import type { Migration } from './types'

function tableExists(db: import('better-sqlite3').Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined
  return Boolean(row?.name)
}

export const migration037ChangeSets: Migration = {
  version: 37,
  name: 'change_sets',
  up(db) {
    if (tableExists(db, 'change_sets')) return

    db.exec(`
      CREATE TABLE change_sets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        source_thread_id TEXT,
        source_turn_id TEXT,
        status TEXT NOT NULL,
        base_workspace_generation TEXT,
        base_commit TEXT,
        worktree_path TEXT,
        patch_artifact_id TEXT,
        patch_hash TEXT,
        validation_json TEXT,
        apply_policy TEXT NOT NULL DEFAULT 'manual',
        state_revision INTEGER NOT NULL DEFAULT 1,
        last_error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        applied_at INTEGER
      );
      CREATE INDEX idx_change_sets_project_status
        ON change_sets (project_id, status, created_at);
      CREATE INDEX idx_change_sets_user_status
        ON change_sets (username, status, created_at);
    `)
  }
}
