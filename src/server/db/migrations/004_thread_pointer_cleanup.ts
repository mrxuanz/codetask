import type { Migration } from './types'

export const migration004ThreadPointerCleanup: Migration = {
  version: 4,
  name: 'thread_pointer_cleanup',
  up(db) {
    db.exec(`
      DROP TRIGGER IF EXISTS thread_messages_clear_active_draft;
      CREATE TRIGGER thread_messages_clear_active_draft
      AFTER DELETE ON thread_messages
      BEGIN
        UPDATE threads
        SET active_draft_id = NULL
        WHERE active_draft_id = OLD.id;
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
}
