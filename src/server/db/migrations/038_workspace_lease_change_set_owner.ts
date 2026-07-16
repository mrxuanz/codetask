import type { Migration } from './types'

function tableExists(db: import('better-sqlite3').Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined
  return Boolean(row?.name)
}

/**
 * P6: allow Change Set apply to hold exclusive workspace leases.
 * SQLite cannot ALTER CHECK — recreate workspace_leases with expanded owner_kind.
 */
export const migration038WorkspaceLeaseChangeSetOwner: Migration = {
  version: 38,
  name: 'workspace_lease_change_set_owner',
  up(db) {
    if (!tableExists(db, 'workspace_leases')) return

    const sql = (
      db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_leases'`).get() as
        | { sql: string }
        | undefined
    )?.sql
    if (sql?.includes("'change_set'")) return

    db.exec(`
      CREATE TABLE workspace_leases_p6 (
        id TEXT PRIMARY KEY,
        canonical_path TEXT NOT NULL,
        owner_kind TEXT NOT NULL CHECK (
          owner_kind IN ('conversation', 'planner', 'thread_job', 'change_set')
        ),
        owner_id TEXT NOT NULL,
        run_id TEXT,
        boot_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'released')),
        lease_expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        released_at INTEGER
      );

      INSERT INTO workspace_leases_p6 (
        id, canonical_path, owner_kind, owner_id, run_id, boot_id,
        status, lease_expires_at, created_at, released_at
      )
      SELECT
        id, canonical_path, owner_kind, owner_id, run_id, boot_id,
        status, lease_expires_at, created_at, released_at
      FROM workspace_leases;

      DROP TABLE workspace_leases;
      ALTER TABLE workspace_leases_p6 RENAME TO workspace_leases;

      CREATE INDEX idx_workspace_leases_active_path
        ON workspace_leases (canonical_path, status);
      CREATE INDEX idx_workspace_leases_active_owner
        ON workspace_leases (owner_kind, owner_id, status);
      CREATE INDEX idx_workspace_leases_boot_status
        ON workspace_leases (boot_id, status);
    `)
  }
}
