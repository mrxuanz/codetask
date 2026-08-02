import type Database from 'better-sqlite3'

export type DesignMigration = {
  version: number
  name: string
  up: (db: Database.Database) => void
}

/** Create Design-owned tables (01 §8). Idempotent via IF NOT EXISTS. */
export const migration043DesignModuleTables: DesignMigration = {
  version: 43,
  name: 'design_module_tables',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY NOT NULL,
        actor_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        user_flow TEXT NOT NULL DEFAULT '',
        tech_stack TEXT NOT NULL DEFAULT '',
        nfr_json TEXT NOT NULL DEFAULT '[]',
        acceptance_json TEXT NOT NULL DEFAULT '[]',
        verification_json TEXT NOT NULL DEFAULT '[]',
        out_of_scope_json TEXT NOT NULL DEFAULT '[]',
        assumptions_json TEXT NOT NULL DEFAULT '[]',
        requirements_markdown TEXT NOT NULL DEFAULT '',
        requirements_status TEXT NOT NULL DEFAULT 'pending',
        locked_sections_json TEXT NOT NULL DEFAULT '{}',
        execution_profile_json TEXT,
        workspace_root TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'editing',
        lock_revision INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_drafts_actor_updated ON drafts(actor_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_drafts_project ON drafts(project_id);

      CREATE TABLE IF NOT EXISTS draft_abilities (
        draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        ability_code TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        recommended_core_code TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (draft_id, ability_code)
      );

      CREATE TABLE IF NOT EXISTS design_draft_references (
        id TEXT PRIMARY KEY NOT NULL,
        draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        source TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        mime_type TEXT,
        description TEXT NOT NULL DEFAULT '',
        attachment_id TEXT,
        local_path TEXT,
        resolved_path TEXT,
        asset_url TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_design_draft_references_draft ON design_draft_references(draft_id);

      CREATE TABLE IF NOT EXISTS draft_reference_snapshots (
        id TEXT PRIMARY KEY NOT NULL,
        draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        draft_lock_revision INTEGER NOT NULL,
        manifest_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_draft_reference_snapshots_draft
        ON draft_reference_snapshots(draft_id, draft_lock_revision);

      CREATE TABLE IF NOT EXISTS planning_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        actor_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        source_draft_id TEXT NOT NULL REFERENCES drafts(id),
        draft_snapshot_json TEXT NOT NULL,
        reference_snapshot_id TEXT REFERENCES draft_reference_snapshots(id),
        execution_profile_json TEXT NOT NULL,
        planner_settings_snapshot_json TEXT NOT NULL DEFAULT '{}',
        planner_settings_hash TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued',
        active_run_id TEXT,
        tree_revision INTEGER NOT NULL DEFAULT 0,
        published_job_id TEXT,
        last_error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        published_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_planning_sessions_draft ON planning_sessions(source_draft_id);
      CREATE INDEX IF NOT EXISTS idx_planning_sessions_actor ON planning_sessions(actor_id, updated_at);

      CREATE TABLE IF NOT EXISTS planning_runs (
        id TEXT PRIMARY KEY NOT NULL,
        planning_session_id TEXT NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        fencing_token TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        error_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_planning_runs_session ON planning_runs(planning_session_id, attempt_no);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_planning_runs_fence ON planning_runs(fencing_token);

      CREATE TABLE IF NOT EXISTS execution_plans (
        id TEXT PRIMARY KEY NOT NULL,
        planning_session_id TEXT NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'current',
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_plans_session_revision
        ON execution_plans(planning_session_id, revision);

      CREATE TABLE IF NOT EXISTS execution_plan_milestones (
        id TEXT PRIMARY KEY NOT NULL,
        plan_id TEXT NOT NULL REFERENCES execution_plans(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        success_criteria TEXT NOT NULL DEFAULT '',
        confirmed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS execution_plan_slices (
        id TEXT PRIMARY KEY NOT NULL,
        plan_id TEXT NOT NULL REFERENCES execution_plans(id) ON DELETE CASCADE,
        milestone_id TEXT NOT NULL REFERENCES execution_plan_milestones(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        success_criteria TEXT NOT NULL DEFAULT '',
        confirmed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS execution_plan_tasks (
        id TEXT PRIMARY KEY NOT NULL,
        plan_id TEXT NOT NULL REFERENCES execution_plans(id) ON DELETE CASCADE,
        slice_id TEXT NOT NULL REFERENCES execution_plan_slices(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        task_kind TEXT NOT NULL,
        ability_code TEXT NOT NULL,
        core_code TEXT NOT NULL,
        context_markdown TEXT NOT NULL DEFAULT '',
        success_criteria TEXT NOT NULL DEFAULT '',
        reference_reason TEXT NOT NULL DEFAULT '',
        can_run_in_parallel INTEGER NOT NULL DEFAULT 0,
        confirmed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS execution_plan_dependencies (
        plan_id TEXT NOT NULL REFERENCES execution_plans(id) ON DELETE CASCADE,
        from_node_id TEXT NOT NULL,
        to_node_id TEXT NOT NULL,
        dependency_kind TEXT NOT NULL,
        PRIMARY KEY (plan_id, from_node_id, to_node_id, dependency_kind)
      );

      CREATE TABLE IF NOT EXISTS execution_plan_task_references (
        plan_id TEXT NOT NULL REFERENCES execution_plans(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES execution_plan_tasks(id) ON DELETE CASCADE,
        reference_id TEXT NOT NULL,
        PRIMARY KEY (plan_id, task_id, reference_id)
      );

      CREATE TABLE IF NOT EXISTS execution_plan_revisions (
        planning_session_id TEXT NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        snapshot_gzip TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (planning_session_id, revision)
      );

      CREATE TABLE IF NOT EXISTS job_handoffs (
        submission_id TEXT PRIMARY KEY NOT NULL,
        planning_session_id TEXT NOT NULL REFERENCES planning_sessions(id),
        idempotency_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        job_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error_json TEXT,
        created_at INTEGER NOT NULL,
        accepted_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_job_handoffs_idempotency ON job_handoffs(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_job_handoffs_status ON job_handoffs(status, created_at);

      CREATE TABLE IF NOT EXISTS migration_failures (
        id TEXT PRIMARY KEY NOT NULL,
        migration_name TEXT NOT NULL,
        source_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS planning_capacity_leases (
        id TEXT PRIMARY KEY NOT NULL,
        planning_session_id TEXT NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
        pool TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        released_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_planning_capacity_active
        ON planning_capacity_leases(pool, released_at);
    `)
  }
}

export const designSchemaMigrations: DesignMigration[] = [migration043DesignModuleTables]
