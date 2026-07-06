import type { Migration } from './types'
import { createThreadPlanPointerTriggers } from './thread-plan-pointer-triggers'

export const migration016DesignSessions: Migration = {
  version: 16,
  name: 'design_sessions',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS design_sessions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        draft_message_id TEXT NOT NULL REFERENCES thread_messages(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        workspace_root TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'plan_generating',
        draft_revision INTEGER NOT NULL DEFAULT 0,
        plan_revision INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        plan_phase TEXT NOT NULL DEFAULT 'idle',
        plan_status TEXT NOT NULL DEFAULT 'pending',
        plan_contexts_registered INTEGER NOT NULL DEFAULT 0,
        plan_contexts_total INTEGER NOT NULL DEFAULT 0,
        plan_message TEXT,
        plan_counts_json TEXT NOT NULL DEFAULT '{}',
        task_phase TEXT NOT NULL DEFAULT 'idle',
        task_status TEXT NOT NULL DEFAULT 'pending',
        task_current_index INTEGER NOT NULL DEFAULT 0,
        task_total INTEGER NOT NULL DEFAULT 0,
        task_current_task_id TEXT,
        task_message TEXT,
        task_meta_json TEXT NOT NULL DEFAULT '{}',
        reference_manifest_json TEXT,
        draft_confirmed_at INTEGER,
        launched_job_id TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_design_sessions_thread_draft
        ON design_sessions (thread_id, draft_message_id);

      CREATE INDEX IF NOT EXISTS idx_design_sessions_thread_updated
        ON design_sessions (thread_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS design_runs (
        id TEXT PRIMARY KEY,
        design_session_id TEXT NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        planner_session_id TEXT,
        plan_revision_before INTEGER,
        plan_revision_after INTEGER,
        tool_name TEXT,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_design_runs_session_started
        ON design_runs (design_session_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS design_abilities (
        design_session_id TEXT NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
        ability_code TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        label TEXT,
        recommended_core_code TEXT,
        PRIMARY KEY (design_session_id, ability_code)
      );

      CREATE TABLE IF NOT EXISTS design_plan_milestones (
        design_session_id TEXT NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
        milestone_index INTEGER NOT NULL,
        sort_order INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        success_criteria TEXT NOT NULL DEFAULT '',
        confirmed INTEGER,
        PRIMARY KEY (design_session_id, milestone_index)
      );

      CREATE TABLE IF NOT EXISTS design_plan_slices (
        design_session_id TEXT NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
        milestone_index INTEGER NOT NULL,
        slice_index INTEGER NOT NULL,
        sort_order INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        success_criteria TEXT NOT NULL DEFAULT '',
        depends_on_slice_refs_json TEXT,
        confirmed INTEGER,
        PRIMARY KEY (design_session_id, milestone_index, slice_index)
      );

      CREATE TABLE IF NOT EXISTS design_plan_tasks (
        design_session_id TEXT NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        milestone_index INTEGER NOT NULL,
        slice_index INTEGER NOT NULL,
        task_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        task_kind TEXT NOT NULL,
        ability_code TEXT NOT NULL,
        context_markdown TEXT NOT NULL DEFAULT '',
        core_code TEXT,
        success_criteria TEXT NOT NULL DEFAULT '',
        reference_ids_json TEXT,
        reference_reason TEXT,
        depends_on_task_refs_json TEXT,
        can_run_in_parallel INTEGER NOT NULL DEFAULT 0,
        confirmed INTEGER,
        PRIMARY KEY (design_session_id, task_id)
      );
    `)

    const legacyJobs = db
      .prepare(
        `SELECT id, thread_id, username, draft_message_id, title, summary, status, workspace_path,
                plan_phase, plan_status, plan_contexts_registered, plan_contexts_total, plan_message,
                plan_counts_json, task_phase, task_status, task_current_index, task_total,
                task_current_task_id, task_message, task_meta_json, reference_manifest_json,
                draft_confirmed_at, last_error, created_at, updated_at
         FROM thread_jobs
         WHERE status IN ('planning', 'plan_editing')`
      )
      .all() as Array<Record<string, unknown>>

    const insertSession = db.prepare(`
      INSERT INTO design_sessions (
        id, thread_id, username, draft_message_id, title, summary, workspace_root,
        phase, draft_revision, plan_revision, status,
        plan_phase, plan_status, plan_contexts_registered, plan_contexts_total, plan_message,
        plan_counts_json, task_phase, task_status, task_current_index, task_total,
        task_current_task_id, task_message, task_meta_json, reference_manifest_json,
        draft_confirmed_at, launched_job_id, last_error, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, 0, 0, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, NULL, ?, ?, ?
      )
    `)

    for (const row of legacyJobs) {
      const oldJobId = String(row.id)
      const designSessionId = `ds-${oldJobId.startsWith('job-') ? oldJobId.slice(4) : oldJobId}`
      const phase = row.status === 'planning' ? 'plan_generating' : 'plan_edit'

      insertSession.run(
        designSessionId,
        row.thread_id,
        row.username,
        row.draft_message_id,
        row.title,
        row.summary ?? '',
        row.workspace_path,
        phase,
        row.status,
        row.plan_phase ?? 'idle',
        row.plan_status ?? 'pending',
        row.plan_contexts_registered ?? 0,
        row.plan_contexts_total ?? 0,
        row.plan_message ?? null,
        row.plan_counts_json ?? '{}',
        row.task_phase ?? 'idle',
        row.task_status ?? 'pending',
        row.task_current_index ?? 0,
        row.task_total ?? 0,
        row.task_current_task_id ?? null,
        row.task_message ?? null,
        row.task_meta_json ?? '{}',
        row.reference_manifest_json ?? null,
        row.draft_confirmed_at ?? null,
        row.last_error ?? null,
        row.created_at,
        row.updated_at
      )

      db.prepare(
        `INSERT INTO design_abilities (design_session_id, ability_code, sort_order, label, recommended_core_code)
         SELECT ?, ability_code, sort_order, label, recommended_core_code
         FROM job_abilities WHERE job_id = ?`
      ).run(designSessionId, oldJobId)

      db.prepare(
        `INSERT INTO design_plan_milestones
         SELECT ?, milestone_index, sort_order, title, description, success_criteria, confirmed
         FROM job_plan_milestones WHERE job_id = ?`
      ).run(designSessionId, oldJobId)

      db.prepare(
        `INSERT INTO design_plan_slices
         SELECT ?, milestone_index, slice_index, sort_order, title, description, success_criteria,
                depends_on_slice_refs_json, confirmed
         FROM job_plan_slices WHERE job_id = ?`
      ).run(designSessionId, oldJobId)

      db.prepare(
        `INSERT INTO design_plan_tasks
         SELECT ?, task_id, sort_order, milestone_index, slice_index, task_index, title, description,
                task_kind, ability_code, context_markdown, core_code, success_criteria,
                reference_ids_json, reference_reason, depends_on_task_refs_json,
                can_run_in_parallel, confirmed
         FROM job_plan_tasks WHERE job_id = ?`
      ).run(designSessionId, oldJobId)

      db.prepare(
        `UPDATE thread_messages
         SET payload_json = json_set(payload_json, '$.linkedPlanId', ?)
         WHERE id = ?
           AND payload_json IS NOT NULL
           AND json_extract(payload_json, '$.linkedPlanId') = ?`
      ).run(designSessionId, row.draft_message_id, oldJobId)

      db.prepare(`UPDATE threads SET active_plan_id = ? WHERE active_plan_id = ?`).run(
        designSessionId,
        oldJobId
      )

      db.prepare(`DELETE FROM thread_jobs WHERE id = ?`).run(oldJobId)
    }

    createThreadPlanPointerTriggers(db)
  }
}
