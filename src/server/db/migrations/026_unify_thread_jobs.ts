import type { Migration } from './types'
import {
  createThreadPlanPointerTriggers,
  dropThreadPlanPointerTriggers
} from './thread-plan-pointer-triggers'

function hasColumn(db: Parameters<Migration['up']>[0], table: string, column: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column)
  )
}

function tableExists(db: Parameters<Migration['up']>[0], table: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
  )
}

export const migration026UnifyThreadJobs: Migration = {
  version: 26,
  name: 'unify_thread_jobs',
  up(db) {
    if (!tableExists(db, 'design_sessions')) {
      // Already unified (or fresh DB that never had design_sessions after this migration).
      ensureThreadJobDesignColumns(db)
      // Rebuild plan-pointer triggers in case a prior partial run left design_sessions refs.
      createThreadPlanPointerTriggers(db)
      return
    }

    // Backups for rollback
    db.exec(`
      CREATE TABLE IF NOT EXISTS design_sessions_backup_026 AS SELECT * FROM design_sessions;
      CREATE TABLE IF NOT EXISTS design_abilities_backup_026 AS SELECT * FROM design_abilities;
      CREATE TABLE IF NOT EXISTS design_plan_milestones_backup_026 AS SELECT * FROM design_plan_milestones;
      CREATE TABLE IF NOT EXISTS design_plan_slices_backup_026 AS SELECT * FROM design_plan_slices;
      CREATE TABLE IF NOT EXISTS design_plan_tasks_backup_026 AS SELECT * FROM design_plan_tasks;
      CREATE TABLE IF NOT EXISTS design_runs_backup_026 AS SELECT * FROM design_runs;
      CREATE TABLE IF NOT EXISTS draft_references_backup_026 AS SELECT * FROM draft_references;
    `)

    ensureThreadJobDesignColumns(db)

    // 1) Unlaunched design sessions → insert into thread_jobs (keep ds-* id)
    const unlaunched = db
      .prepare(
        `SELECT * FROM design_sessions
         WHERE launched_job_id IS NULL OR launched_job_id = ''`
      )
      .all() as Array<Record<string, unknown>>

    const insertUnlaunched = db.prepare(`
      INSERT OR IGNORE INTO thread_jobs (
        id, thread_id, username, draft_message_id, title, summary, status, workspace_path,
        plan_phase, plan_status, plan_contexts_registered, plan_contexts_total, plan_message, plan_counts_json,
        task_phase, task_status, task_current_index, task_total, task_current_task_id, task_message, task_meta_json,
        last_error, draft_confirmed_at, reference_manifest_json, plan_confirmed_at,
        design_session_id, snapshot_draft_revision, snapshot_plan_revision, snapshot_manifest_revision,
        execution_lease_owner, execution_lease_expires_at, active_run_id, terminal_at, runtime_bytes,
        created_at, updated_at,
        phase, draft_revision, plan_revision, manifest_revision, corpus_revision, frozen_corpus_revision,
        plan_artifact_id, plan_artifact_path, plan_summary_json
      ) VALUES (
        @id, @thread_id, @username, @draft_message_id, @title, @summary, @status, @workspace_path,
        @plan_phase, @plan_status, @plan_contexts_registered, @plan_contexts_total, @plan_message, @plan_counts_json,
        @task_phase, @task_status, @task_current_index, @task_total, @task_current_task_id, @task_message, @task_meta_json,
        @last_error, @draft_confirmed_at, @reference_manifest_json, NULL,
        NULL, NULL, NULL, NULL,
        NULL, NULL, @active_run_id, NULL, 0,
        @created_at, @updated_at,
        @phase, @draft_revision, @plan_revision, @manifest_revision, @corpus_revision, @frozen_corpus_revision,
        @plan_artifact_id, @plan_artifact_path, @plan_summary_json
      )
    `)

    for (const row of unlaunched) {
      insertUnlaunched.run({
        id: row.id,
        thread_id: row.thread_id,
        username: row.username,
        draft_message_id: row.draft_message_id,
        title: row.title,
        summary: row.summary ?? '',
        status: row.status,
        workspace_path: row.workspace_root,
        plan_phase: row.plan_phase,
        plan_status: row.plan_status,
        plan_contexts_registered: row.plan_contexts_registered,
        plan_contexts_total: row.plan_contexts_total,
        plan_message: row.plan_message,
        plan_counts_json: row.plan_counts_json ?? '{}',
        task_phase: row.task_phase,
        task_status: row.task_status,
        task_current_index: row.task_current_index,
        task_total: row.task_total,
        task_current_task_id: row.task_current_task_id,
        task_message: row.task_message,
        task_meta_json: row.task_meta_json ?? '{}',
        last_error: row.last_error,
        draft_confirmed_at: row.draft_confirmed_at,
        reference_manifest_json: row.reference_manifest_json,
        active_run_id: row.active_run_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
        phase: row.phase,
        draft_revision: row.draft_revision ?? 0,
        plan_revision: row.plan_revision ?? 0,
        manifest_revision: row.manifest_revision ?? 0,
        corpus_revision: row.corpus_revision ?? 0,
        frozen_corpus_revision: row.frozen_corpus_revision ?? 0,
        plan_artifact_id: row.plan_artifact_id,
        plan_artifact_path: row.plan_artifact_path,
        plan_summary_json: row.plan_summary_json
      })

      copyDesignChildrenToJob(db, String(row.id), String(row.id))
    }

    // 2) Launched design sessions → enrich existing job-* row; retarget children from ds-* to job-*
    const launched = db
      .prepare(
        `SELECT * FROM design_sessions
         WHERE launched_job_id IS NOT NULL AND launched_job_id != ''`
      )
      .all() as Array<Record<string, unknown>>

    // Prefer design-session planning metadata. Revision columns are NOT NULL DEFAULT 0,
    // so plain COALESCE would keep the job's 0 and never copy session revisions.
    const updateLaunchedJob = db.prepare(`
      UPDATE thread_jobs SET
        phase = COALESCE(NULLIF(phase, ''), @phase),
        draft_revision = CASE
          WHEN COALESCE(draft_revision, 0) = 0 THEN @draft_revision ELSE draft_revision END,
        plan_revision = CASE
          WHEN COALESCE(plan_revision, 0) = 0 THEN @plan_revision ELSE plan_revision END,
        manifest_revision = CASE
          WHEN COALESCE(manifest_revision, 0) = 0 THEN @manifest_revision ELSE manifest_revision END,
        corpus_revision = CASE
          WHEN COALESCE(corpus_revision, 0) = 0 THEN @corpus_revision ELSE corpus_revision END,
        frozen_corpus_revision = CASE
          WHEN COALESCE(frozen_corpus_revision, 0) = 0 THEN @frozen_corpus_revision
          ELSE frozen_corpus_revision END,
        plan_artifact_id = COALESCE(plan_artifact_id, @plan_artifact_id),
        plan_artifact_path = COALESCE(plan_artifact_path, @plan_artifact_path),
        plan_summary_json = COALESCE(plan_summary_json, @plan_summary_json),
        design_session_id = COALESCE(design_session_id, @design_session_id),
        updated_at = @updated_at
      WHERE id = @job_id
    `)

    for (const row of launched) {
      const jobId = String(row.launched_job_id)
      const dsId = String(row.id)
      const jobExists = db.prepare(`SELECT 1 FROM thread_jobs WHERE id = ?`).get(jobId)
      if (jobExists) {
        updateLaunchedJob.run({
          job_id: jobId,
          phase: 'archived',
          draft_revision: row.draft_revision ?? 0,
          plan_revision: row.plan_revision ?? 0,
          manifest_revision: row.manifest_revision ?? 0,
          corpus_revision: row.corpus_revision ?? 0,
          frozen_corpus_revision: row.frozen_corpus_revision ?? 0,
          plan_artifact_id: row.plan_artifact_id,
          plan_artifact_path: row.plan_artifact_path,
          plan_summary_json: row.plan_summary_json,
          design_session_id: dsId,
          updated_at: row.updated_at
        })
        // Retarget draft_references / design_runs from ds-* → job-*
        db.prepare(`UPDATE draft_references SET design_session_id = ? WHERE design_session_id = ?`).run(
          jobId,
          dsId
        )
        db.prepare(`UPDATE design_runs SET design_session_id = ? WHERE design_session_id = ?`).run(
          jobId,
          dsId
        )
      } else {
        // Orphan launched session without job row — treat as unlaunched insert under ds id
        insertUnlaunched.run({
          id: dsId,
          thread_id: row.thread_id,
          username: row.username,
          draft_message_id: row.draft_message_id,
          title: row.title,
          summary: row.summary ?? '',
          status: 'pending',
          workspace_path: row.workspace_root,
          plan_phase: row.plan_phase,
          plan_status: row.plan_status,
          plan_contexts_registered: row.plan_contexts_registered,
          plan_contexts_total: row.plan_contexts_total,
          plan_message: row.plan_message,
          plan_counts_json: row.plan_counts_json ?? '{}',
          task_phase: row.task_phase,
          task_status: row.task_status,
          task_current_index: row.task_current_index,
          task_total: row.task_total,
          task_current_task_id: row.task_current_task_id,
          task_message: row.task_message,
          task_meta_json: row.task_meta_json ?? '{}',
          last_error: row.last_error,
          draft_confirmed_at: row.draft_confirmed_at,
          reference_manifest_json: row.reference_manifest_json,
          active_run_id: row.active_run_id,
          created_at: row.created_at,
          updated_at: row.updated_at,
          phase: 'archived',
          draft_revision: row.draft_revision ?? 0,
          plan_revision: row.plan_revision ?? 0,
          manifest_revision: row.manifest_revision ?? 0,
          corpus_revision: row.corpus_revision ?? 0,
          frozen_corpus_revision: row.frozen_corpus_revision ?? 0,
          plan_artifact_id: row.plan_artifact_id,
          plan_artifact_path: row.plan_artifact_path,
          plan_summary_json: row.plan_summary_json
        })
        copyDesignChildrenToJob(db, dsId, dsId)
      }

      // Fix stale pointers still pointing at launched ds-*
      db.prepare(
        `UPDATE threads SET active_plan_id = ? WHERE active_plan_id = ?`
      ).run(jobId, dsId)
      db.prepare(
        `UPDATE thread_messages
         SET payload_json = json_set(payload_json, '$.linkedPlanId', ?)
         WHERE payload_json IS NOT NULL
           AND json_extract(payload_json, '$.linkedPlanId') = ?`
      ).run(jobId, dsId)
    }

    // 3) Workload owner_kind design_session → thread_job
    if (tableExists(db, 'workload_slots')) {
      db.exec(`UPDATE workload_slots SET owner_kind = 'thread_job' WHERE owner_kind = 'design_session'`)
    }
    if (tableExists(db, 'workload_runs')) {
      db.exec(`UPDATE workload_runs SET owner_kind = 'thread_job' WHERE owner_kind = 'design_session'`)
    }

    // 4) Rebuild draft_references / design_runs to FK thread_jobs
    rebuildDraftReferencesFk(db)
    rebuildDesignRunsFk(db)

    // 5) Drop design_sessions clear trigger before DROP so unlaunched ds-* active_plan_id
    // pointers are not nulled after the same id was inserted into thread_jobs.
    dropThreadPlanPointerTriggers(db)

    db.exec(`
      DROP TABLE IF EXISTS design_plan_tasks;
      DROP TABLE IF EXISTS design_plan_slices;
      DROP TABLE IF EXISTS design_plan_milestones;
      DROP TABLE IF EXISTS design_abilities;
      DROP TABLE IF EXISTS design_sessions;
    `)

    // 6) Rebuild plan-pointer triggers without design_sessions references
    createThreadPlanPointerTriggers(db)
  }
}

function ensureThreadJobDesignColumns(db: Parameters<Migration['up']>[0]): void {
  const columns: Array<[string, string]> = [
    ['phase', `TEXT`],
    ['draft_revision', `INTEGER NOT NULL DEFAULT 0`],
    ['plan_revision', `INTEGER NOT NULL DEFAULT 0`],
    ['manifest_revision', `INTEGER NOT NULL DEFAULT 0`],
    ['corpus_revision', `INTEGER NOT NULL DEFAULT 0`],
    ['frozen_corpus_revision', `INTEGER NOT NULL DEFAULT 0`],
    ['plan_artifact_id', `TEXT`],
    ['plan_artifact_path', `TEXT`],
    ['plan_summary_json', `TEXT`]
  ]
  for (const [name, decl] of columns) {
    if (!hasColumn(db, 'thread_jobs', name)) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN ${name} ${decl}`)
    }
  }
}

function copyDesignChildrenToJob(
  db: Parameters<Migration['up']>[0],
  designSessionId: string,
  jobId: string
): void {
  db.prepare(
    `INSERT OR IGNORE INTO job_abilities (job_id, ability_code, sort_order, label, recommended_core_code)
     SELECT ?, ability_code, sort_order, label, recommended_core_code
     FROM design_abilities WHERE design_session_id = ?`
  ).run(jobId, designSessionId)

  db.prepare(
    `INSERT OR IGNORE INTO job_plan_milestones
       (job_id, milestone_index, sort_order, title, description, success_criteria, confirmed)
     SELECT ?, milestone_index, sort_order, title, description, success_criteria, confirmed
     FROM design_plan_milestones WHERE design_session_id = ?`
  ).run(jobId, designSessionId)

  db.prepare(
    `INSERT OR IGNORE INTO job_plan_slices
       (job_id, milestone_index, slice_index, sort_order, title, description, success_criteria,
        depends_on_slice_refs_json, confirmed)
     SELECT ?, milestone_index, slice_index, sort_order, title, description, success_criteria,
            depends_on_slice_refs_json, confirmed
     FROM design_plan_slices WHERE design_session_id = ?`
  ).run(jobId, designSessionId)

  db.prepare(
    `INSERT OR IGNORE INTO job_plan_tasks
       (job_id, task_id, sort_order, milestone_index, slice_index, task_index, title, description,
        task_kind, ability_code, context_markdown, core_code, success_criteria,
        reference_ids_json, reference_reason, depends_on_task_refs_json, can_run_in_parallel, confirmed)
     SELECT ?, task_id, sort_order, milestone_index, slice_index, task_index, title, description,
            task_kind, ability_code, context_markdown, core_code, success_criteria,
            reference_ids_json, reference_reason, depends_on_task_refs_json, can_run_in_parallel, confirmed
     FROM design_plan_tasks WHERE design_session_id = ?`
  ).run(jobId, designSessionId)

  // draft_references / design_runs already point at designSessionId; for unlaunched, id == jobId so OK
}

function rebuildDraftReferencesFk(db: Parameters<Migration['up']>[0]): void {
  if (!tableExists(db, 'draft_references')) return
  db.exec(`
    CREATE TABLE draft_references_new (
      id TEXT PRIMARY KEY NOT NULL,
      design_session_id TEXT NOT NULL REFERENCES thread_jobs(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      attachment_id TEXT,
      local_path TEXT,
      resolved_path TEXT,
      asset_url TEXT,
      mime_type TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO draft_references_new
      SELECT id, design_session_id, source, name, kind, description, attachment_id, local_path,
             resolved_path, asset_url, mime_type, sort_order, created_at, updated_at
      FROM draft_references
      WHERE design_session_id IN (SELECT id FROM thread_jobs);
    DROP TABLE draft_references;
    ALTER TABLE draft_references_new RENAME TO draft_references;
  `)
}

function rebuildDesignRunsFk(db: Parameters<Migration['up']>[0]): void {
  if (!tableExists(db, 'design_runs')) return
  db.exec(`
    CREATE TABLE design_runs_new (
      id TEXT PRIMARY KEY NOT NULL,
      design_session_id TEXT NOT NULL REFERENCES thread_jobs(id) ON DELETE CASCADE,
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
    INSERT INTO design_runs_new
      SELECT id, design_session_id, kind, status, started_at, finished_at, planner_session_id,
             plan_revision_before, plan_revision_after, tool_name, error
      FROM design_runs
      WHERE design_session_id IN (SELECT id FROM thread_jobs);
    DROP TABLE design_runs;
    ALTER TABLE design_runs_new RENAME TO design_runs;
  `)
}
