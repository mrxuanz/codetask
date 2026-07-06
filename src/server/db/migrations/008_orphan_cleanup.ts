import type { Migration } from './types'

export const migration008OrphanCleanup: Migration = {
  version: 8,
  name: 'orphan_cleanup',
  up(db) {
    db.pragma('foreign_keys = ON')

    db.exec(`
      DELETE FROM job_tasks
      WHERE job_id NOT IN (SELECT id FROM thread_jobs)
         OR job_id IN (
           SELECT id FROM thread_jobs
           WHERE thread_id NOT IN (SELECT id FROM threads)
              OR draft_message_id NOT IN (SELECT id FROM thread_messages)
         );

      DELETE FROM job_abilities
      WHERE job_id NOT IN (SELECT id FROM thread_jobs)
         OR job_id IN (
           SELECT id FROM thread_jobs
           WHERE thread_id NOT IN (SELECT id FROM threads)
              OR draft_message_id NOT IN (SELECT id FROM thread_messages)
         );

      DELETE FROM job_plan_tasks
      WHERE job_id NOT IN (SELECT id FROM thread_jobs)
         OR job_id IN (
           SELECT id FROM thread_jobs
           WHERE thread_id NOT IN (SELECT id FROM threads)
              OR draft_message_id NOT IN (SELECT id FROM thread_messages)
         );

      DELETE FROM job_plan_milestones
      WHERE job_id NOT IN (SELECT id FROM thread_jobs)
         OR job_id IN (
           SELECT id FROM thread_jobs
           WHERE thread_id NOT IN (SELECT id FROM threads)
              OR draft_message_id NOT IN (SELECT id FROM thread_messages)
         );

      DELETE FROM job_plan_slices
      WHERE job_id NOT IN (SELECT id FROM thread_jobs)
         OR job_id IN (
           SELECT id FROM thread_jobs
           WHERE thread_id NOT IN (SELECT id FROM threads)
              OR draft_message_id NOT IN (SELECT id FROM thread_messages)
         );

      DELETE FROM job_events
      WHERE job_id NOT IN (SELECT id FROM thread_jobs)
         OR job_id IN (
           SELECT id FROM thread_jobs
           WHERE thread_id NOT IN (SELECT id FROM threads)
              OR draft_message_id NOT IN (SELECT id FROM thread_messages)
         );

      DELETE FROM thread_jobs
      WHERE thread_id NOT IN (SELECT id FROM threads)
         OR draft_message_id NOT IN (SELECT id FROM thread_messages);

      DELETE FROM thread_messages
      WHERE thread_id NOT IN (SELECT id FROM threads);

      DELETE FROM threads
      WHERE project_id NOT IN (SELECT id FROM projects);
    `)
  }
}
