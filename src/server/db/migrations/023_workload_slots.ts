import type { Migration } from './types'

function columnExists(
  db: import('better-sqlite3').Database,
  table: string,
  column: string
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((col) => col.name === column)
}

function tableExists(db: import('better-sqlite3').Database, table: string): boolean {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`
    )
    .get(table) as { name: string } | undefined
  return row?.name === table
}

export const migration023WorkloadSlots: Migration = {
  version: 23,
  name: 'workload_slots',
  up(db) {
    if (!columnExists(db, 'thread_jobs', 'active_run_id')) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN active_run_id TEXT`)
    }
    if (!columnExists(db, 'design_sessions', 'active_run_id')) {
      db.exec(`ALTER TABLE design_sessions ADD COLUMN active_run_id TEXT`)
    }

    if (!tableExists(db, 'workload_runs')) {
      db.exec(`
        CREATE TABLE workload_runs (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          owner_kind TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          pool TEXT NOT NULL DEFAULT 'default',
          status TEXT NOT NULL DEFAULT 'active',
          lease_owner TEXT,
          lease_expires_at INTEGER,
          cancel_reason TEXT,
          runtime_ref_json TEXT,
          started_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          released_at INTEGER
        );
        CREATE INDEX idx_workload_runs_owner ON workload_runs (owner_kind, owner_id, started_at DESC);
        CREATE INDEX idx_workload_runs_username_pool ON workload_runs (username, pool, status, started_at DESC);
      `)
    }

    if (!tableExists(db, 'workload_slots')) {
      db.exec(`
        CREATE TABLE workload_slots (
          run_id TEXT NOT NULL REFERENCES workload_runs(id) ON DELETE CASCADE,
          username TEXT NOT NULL,
          pool TEXT NOT NULL DEFAULT 'default',
          owner_kind TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          lease_owner TEXT,
          lease_expires_at INTEGER,
          created_at INTEGER NOT NULL,
          released_at INTEGER
        );
        CREATE UNIQUE INDEX idx_workload_slots_run_id ON workload_slots (run_id);
        CREATE INDEX idx_workload_slots_username_pool ON workload_slots (username, pool, status);
      `)
    }
  }
}
