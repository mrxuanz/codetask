import type { Migration } from './types'

function tableExists(db: import('better-sqlite3').Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined
  return Boolean(row)
}

/**
 * FIX-PLAN F4-A (§9.1) + F4-B (§9.2–9.3): workspace mutual exclusion and deletion lifecycle.
 */
export const migration030WorkspaceLeasesAndDeletion: Migration = {
  version: 30,
  name: 'workspace_leases_and_deletion',
  up(db) {
    if (!tableExists(db, 'workspace_leases')) {
      db.exec(`
        CREATE TABLE workspace_leases (
          id TEXT PRIMARY KEY,
          canonical_path TEXT NOT NULL,
          owner_kind TEXT NOT NULL CHECK (
            owner_kind IN ('conversation', 'planner', 'thread_job')
          ),
          owner_id TEXT NOT NULL,
          run_id TEXT,
          boot_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'released')),
          lease_expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          released_at INTEGER
        );
        CREATE INDEX idx_workspace_leases_active_path
          ON workspace_leases (canonical_path, status);
        CREATE INDEX idx_workspace_leases_active_owner
          ON workspace_leases (owner_kind, owner_id, status);
        CREATE INDEX idx_workspace_leases_boot_status
          ON workspace_leases (boot_id, status);
      `)
    }

    if (!tableExists(db, 'deletion_requests')) {
      db.exec(`
        CREATE TABLE deletion_requests (
          id TEXT PRIMARY KEY,
          entity_kind TEXT NOT NULL CHECK (
            entity_kind IN ('thread_job', 'thread', 'project')
          ),
          entity_id TEXT NOT NULL,
          username TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('pending', 'draining', 'deleting', 'completed', 'failed')
          ),
          frozen_json TEXT,
          filesystem_cleanup_json TEXT,
          error_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX idx_deletion_requests_active_entity
          ON deletion_requests (entity_kind, entity_id)
          WHERE status NOT IN ('completed', 'failed');
        CREATE INDEX idx_deletion_requests_status
          ON deletion_requests (status);
      `)
    }
  }
}
