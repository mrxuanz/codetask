import type { Migration } from './types'

export const migration033DesignPlanRevisions: Migration = {
  version: 33,
  name: 'design_plan_revisions',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS design_plan_revisions (
        job_id TEXT NOT NULL REFERENCES thread_jobs(id) ON DELETE CASCADE,
        plan_revision INTEGER NOT NULL,
        content_gzip BLOB NOT NULL,
        content_hash TEXT NOT NULL,
        raw_byte_size INTEGER NOT NULL,
        gzip_byte_size INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (job_id, plan_revision)
      );

      CREATE INDEX IF NOT EXISTS idx_design_plan_revisions_expiry
        ON design_plan_revisions(expires_at)
        WHERE expires_at IS NOT NULL;
    `)
  }
}
