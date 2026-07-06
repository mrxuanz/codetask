import type Database from 'better-sqlite3'

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined
  return Boolean(row)
}

export function dropThreadPlanPointerTriggers(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS threads_active_plan_insert;
    DROP TRIGGER IF EXISTS threads_active_plan_update;
    DROP TRIGGER IF EXISTS thread_jobs_clear_active_plan;
    DROP TRIGGER IF EXISTS design_sessions_clear_active_plan;
  `)
}

export function createThreadPlanPointerTriggers(db: Database.Database): void {
  const hasDesignSessions = tableExists(db, 'design_sessions')

  if (hasDesignSessions) {
    db.exec(`
      DROP TRIGGER IF EXISTS threads_active_plan_insert;
      CREATE TRIGGER threads_active_plan_insert
      BEFORE INSERT ON threads
      WHEN NEW.active_plan_id IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN (SELECT thread_id FROM thread_jobs WHERE id = NEW.active_plan_id) IS NULL
            AND (SELECT thread_id FROM design_sessions WHERE id = NEW.active_plan_id) IS NULL
            THEN RAISE(ABORT, 'active_plan_id must reference an existing job or design session')
          WHEN COALESCE(
            (SELECT thread_id FROM thread_jobs WHERE id = NEW.active_plan_id),
            (SELECT thread_id FROM design_sessions WHERE id = NEW.active_plan_id)
          ) != NEW.id
            THEN RAISE(ABORT, 'active_plan_id must belong to the same thread')
        END;
      END;

      DROP TRIGGER IF EXISTS threads_active_plan_update;
      CREATE TRIGGER threads_active_plan_update
      BEFORE UPDATE OF active_plan_id ON threads
      WHEN NEW.active_plan_id IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN (SELECT thread_id FROM thread_jobs WHERE id = NEW.active_plan_id) IS NULL
            AND (SELECT thread_id FROM design_sessions WHERE id = NEW.active_plan_id) IS NULL
            THEN RAISE(ABORT, 'active_plan_id must reference an existing job or design session')
          WHEN COALESCE(
            (SELECT thread_id FROM thread_jobs WHERE id = NEW.active_plan_id),
            (SELECT thread_id FROM design_sessions WHERE id = NEW.active_plan_id)
          ) != NEW.id
            THEN RAISE(ABORT, 'active_plan_id must belong to the same thread')
        END;
      END;

      DROP TRIGGER IF EXISTS thread_jobs_clear_active_plan;
      CREATE TRIGGER thread_jobs_clear_active_plan
      AFTER DELETE ON thread_jobs
      BEGIN
        UPDATE threads
        SET active_plan_id = NULL
        WHERE active_plan_id = OLD.id;
      END;

      DROP TRIGGER IF EXISTS design_sessions_clear_active_plan;
      CREATE TRIGGER design_sessions_clear_active_plan
      AFTER DELETE ON design_sessions
      BEGIN
        UPDATE threads
        SET active_plan_id = NULL
        WHERE active_plan_id = OLD.id;
      END;
    `)
    return
  }

  db.exec(`
    DROP TRIGGER IF EXISTS threads_active_plan_insert;
    CREATE TRIGGER threads_active_plan_insert
    BEFORE INSERT ON threads
    WHEN NEW.active_plan_id IS NOT NULL
    BEGIN
      SELECT CASE
        WHEN (SELECT thread_id FROM thread_jobs WHERE id = NEW.active_plan_id) IS NULL
          THEN RAISE(ABORT, 'active_plan_id must reference an existing job')
        WHEN (SELECT thread_id FROM thread_jobs WHERE id = NEW.active_plan_id) != NEW.id
          THEN RAISE(ABORT, 'active_plan_id must belong to the same thread')
      END;
    END;

    DROP TRIGGER IF EXISTS threads_active_plan_update;
    CREATE TRIGGER threads_active_plan_update
    BEFORE UPDATE OF active_plan_id ON threads
    WHEN NEW.active_plan_id IS NOT NULL
    BEGIN
      SELECT CASE
        WHEN (SELECT thread_id FROM thread_jobs WHERE id = NEW.active_plan_id) IS NULL
          THEN RAISE(ABORT, 'active_plan_id must reference an existing job')
        WHEN (SELECT thread_id FROM thread_jobs WHERE id = NEW.active_plan_id) != NEW.id
          THEN RAISE(ABORT, 'active_plan_id must belong to the same thread')
      END;
    END;

    DROP TRIGGER IF EXISTS thread_jobs_clear_active_plan;
    CREATE TRIGGER thread_jobs_clear_active_plan
    AFTER DELETE ON thread_jobs
    BEGIN
      UPDATE threads
      SET active_plan_id = NULL
      WHERE active_plan_id = OLD.id;
    END;
  `)
}
