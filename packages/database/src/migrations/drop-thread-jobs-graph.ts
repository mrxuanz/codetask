import type Database from 'better-sqlite3'

export type HostThreadJobsDropMigration = {
  version: number
  name: string
  up: (db: Database.Database) => void
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

/**
 * Drop legacy thread_jobs graph after live cutover (M3).
 * Retention tables (job_artifacts / job_counters / design_plan_revisions) are rebuilt
 * without FK to thread_jobs so host retention keeps working against opaque job ids.
 */
export const migration060DropThreadJobsGraph: HostThreadJobsDropMigration = {
  version: 60,
  name: 'drop_thread_jobs_graph',
  up(db) {
    db.exec(`
      DROP TRIGGER IF EXISTS thread_jobs_draft_same_thread_insert;
      DROP TRIGGER IF EXISTS thread_jobs_draft_same_thread_update;
      DROP TRIGGER IF EXISTS thread_jobs_clear_active_plan;
    `)

    db.pragma('foreign_keys = OFF')
    const tx = db.transaction(() => {
      if (tableExists(db, 'draft_references')) {
        db.exec(`DROP TABLE draft_references`)
      }

      if (tableExists(db, 'design_plan_revisions')) {
        db.exec(`
          CREATE TABLE design_plan_revisions_new (
            job_id TEXT NOT NULL,
            plan_revision INTEGER NOT NULL,
            content_gzip BLOB NOT NULL,
            content_hash TEXT NOT NULL,
            raw_byte_size INTEGER NOT NULL,
            gzip_byte_size INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            PRIMARY KEY (job_id, plan_revision)
          );
          INSERT INTO design_plan_revisions_new
            SELECT job_id, plan_revision, content_gzip, content_hash, raw_byte_size,
                   gzip_byte_size, created_at, expires_at
            FROM design_plan_revisions;
          DROP TABLE design_plan_revisions;
          ALTER TABLE design_plan_revisions_new RENAME TO design_plan_revisions;
        `)
      }

      if (tableExists(db, 'job_artifacts')) {
        db.exec(`
          CREATE TABLE job_artifacts_new (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL,
            task_id TEXT,
            kind TEXT NOT NULL,
            tier TEXT NOT NULL DEFAULT 'working',
            content_hash TEXT NOT NULL,
            byte_size INTEGER NOT NULL,
            storage TEXT NOT NULL,
            content_inline TEXT,
            content_blob BLOB,
            content_path TEXT,
            created_at INTEGER NOT NULL,
            expires_at INTEGER
          );
          INSERT INTO job_artifacts_new
            SELECT id, job_id, task_id, kind, tier, content_hash, byte_size, storage,
                   content_inline, content_blob, content_path, created_at, expires_at
            FROM job_artifacts;
          DROP TABLE job_artifacts;
          ALTER TABLE job_artifacts_new RENAME TO job_artifacts;
        `)
      }

      if (tableExists(db, 'job_counters')) {
        db.exec(`
          CREATE TABLE job_counters_new (
            job_id TEXT NOT NULL,
            counter_key TEXT NOT NULL,
            value INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (job_id, counter_key)
          );
          INSERT INTO job_counters_new
            SELECT job_id, counter_key, value, updated_at FROM job_counters;
          DROP TABLE job_counters;
          ALTER TABLE job_counters_new RENAME TO job_counters;
        `)
      }

      if (tableExists(db, 'thread_jobs')) {
        db.exec(`DROP TABLE thread_jobs`)
      }
    })
    tx()
    db.pragma('foreign_keys = ON')
  }
}
