import type Database from 'better-sqlite3'

export type ExecutionMigration = {
  version: number
  name: string
  up: (db: Database.Database) => void
}

/** Create Execution-owned tables (02 §15). Idempotent via IF NOT EXISTS. */
export const migration045ExecutionModuleTables: ExecutionMigration = {
  version: 45,
  name: 'execution_module_tables',
  up(db) {
    // Unify workspace_leases onto 02 schema (canonical_workspace_root / owner_type / lease_owner).
    // Migration 030 created an older shape (canonical_path / owner_kind / boot_id).
    const leaseInfo = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_leases'`)
      .get() as { name: string } | undefined
    if (leaseInfo) {
      const cols = db.prepare(`PRAGMA table_info(workspace_leases)`).all() as Array<{
        name: string
      }>
      const names = new Set(cols.map((c) => c.name))
      if (names.has('canonical_path') && !names.has('canonical_workspace_root')) {
        db.exec(`ALTER TABLE workspace_leases RENAME TO workspace_leases_v030`)
      }
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY NOT NULL,
        submission_id TEXT NOT NULL UNIQUE,
        submission_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        source_draft_id TEXT NOT NULL,
        source_planning_session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        workspace_root TEXT NOT NULL,
        canonical_workspace_root TEXT NOT NULL,
        state TEXT NOT NULL,
        state_revision INTEGER NOT NULL DEFAULT 0,
        control_intent TEXT NOT NULL DEFAULT 'none',
        execution_generation INTEGER NOT NULL DEFAULT 0,
        current_run_id TEXT,
        suspension_kind TEXT,
        recovery_reason TEXT,
        last_error_json TEXT,
        queued_at INTEGER,
        started_at INTEGER,
        terminal_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_jobs_actor_updated ON jobs(actor_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, queued_at);

      CREATE TABLE IF NOT EXISTS job_snapshots (
        job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        draft_snapshot_json TEXT NOT NULL,
        execution_profile_json TEXT NOT NULL,
        execution_settings_snapshot_json TEXT NOT NULL,
        reference_manifest_json TEXT NOT NULL,
        execution_tree_json TEXT NOT NULL,
        settings_hash TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_milestones (
        id TEXT PRIMARY KEY NOT NULL,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        source_milestone_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        success_criteria TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_job_milestones_job
        ON job_milestones(job_id, generation, sort_order);

      CREATE TABLE IF NOT EXISTS job_slices (
        id TEXT PRIMARY KEY NOT NULL,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        milestone_id TEXT NOT NULL REFERENCES job_milestones(id) ON DELETE CASCADE,
        source_slice_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        success_criteria TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'pending',
        verification_state TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_job_slices_job
        ON job_slices(job_id, generation, sort_order);

      CREATE TABLE IF NOT EXISTS job_work_items (
        id TEXT PRIMARY KEY NOT NULL,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        source_task_id TEXT NOT NULL,
        parent_work_id TEXT,
        milestone_id TEXT NOT NULL,
        slice_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        context_markdown TEXT NOT NULL DEFAULT '',
        ability_code TEXT NOT NULL,
        provider_code TEXT NOT NULL,
        success_criteria TEXT NOT NULL DEFAULT '',
        can_run_in_parallel INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'pending',
        state_revision INTEGER NOT NULL DEFAULT 0,
        last_error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_job_work_items_job
        ON job_work_items(job_id, generation, state);
      CREATE INDEX IF NOT EXISTS idx_job_work_items_slice
        ON job_work_items(job_id, generation, slice_id);

      CREATE TABLE IF NOT EXISTS job_work_dependencies (
        job_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        from_work_id TEXT NOT NULL,
        depends_on_work_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        PRIMARY KEY (job_id, generation, from_work_id, depends_on_work_id)
      );

      CREATE TABLE IF NOT EXISTS job_work_references (
        job_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        work_id TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        PRIMARY KEY (job_id, generation, work_id, reference_id)
      );

      CREATE TABLE IF NOT EXISTS execution_queue_entries (
        job_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        sequence INTEGER NOT NULL,
        enqueued_at INTEGER NOT NULL,
        claimed_at INTEGER,
        removed_at INTEGER,
        PRIMARY KEY (job_id, generation)
      );
      CREATE INDEX IF NOT EXISTS idx_execution_queue_status
        ON execution_queue_entries(status, priority, sequence, job_id);

      CREATE TABLE IF NOT EXISTS execution_runs (
        id TEXT PRIMARY KEY NOT NULL,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        lease_owner TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        fencing_token INTEGER NOT NULL DEFAULT 1,
        runtime_ref_json TEXT,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        released_at INTEGER,
        release_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_execution_runs_job ON execution_runs(job_id, generation);

      CREATE TABLE IF NOT EXISTS execution_pool_slots (
        pool TEXT NOT NULL,
        slot_number INTEGER NOT NULL,
        run_id TEXT,
        status TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        claimed_at INTEGER,
        released_at INTEGER,
        PRIMARY KEY (pool, slot_number)
      );

      CREATE TABLE IF NOT EXISTS workspace_leases (
        id TEXT PRIMARY KEY NOT NULL,
        canonical_workspace_root TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        run_id TEXT,
        status TEXT NOT NULL,
        lease_owner TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        released_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_leases_active
        ON workspace_leases(canonical_workspace_root)
        WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS work_attempts (
        id TEXT PRIMARY KEY NOT NULL,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        work_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_started_at INTEGER,
        result_hash TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        error_json TEXT,
        replay_authorized_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_attempts_idempotency
        ON work_attempts(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_work_attempts_work
        ON work_attempts(job_id, work_id, attempt_number);

      CREATE TABLE IF NOT EXISTS work_results (
        id TEXT PRIMARY KEY NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES work_attempts(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        validation_json TEXT NOT NULL DEFAULT '{}',
        evidence_summary TEXT NOT NULL DEFAULT '',
        evidence_artifact_id TEXT,
        result_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS verification_attempts (
        id TEXT PRIMARY KEY NOT NULL,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        bundle_hash TEXT NOT NULL,
        evidence_bundle_json TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        error_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_verification_attempts_scope
        ON verification_attempts(job_id, generation, scope_type, scope_id);

      CREATE TABLE IF NOT EXISTS verification_results (
        id TEXT PRIMARY KEY NOT NULL,
        verification_attempt_id TEXT NOT NULL UNIQUE
          REFERENCES verification_attempts(id) ON DELETE CASCADE,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence TEXT NOT NULL,
        summary TEXT NOT NULL,
        verdict_json TEXT NOT NULL,
        verdict_artifact_id TEXT,
        bundle_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repair_generations (
        job_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        generation_number INTEGER NOT NULL,
        verdict_id TEXT,
        created_work_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (job_id, generation, scope_type, scope_id, generation_number)
      );

      CREATE TABLE IF NOT EXISTS job_assets (
        id TEXT PRIMARY KEY NOT NULL,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        reference_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        byte_size INTEGER NOT NULL DEFAULT 0,
        storage TEXT NOT NULL,
        content_path TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_job_assets_job ON job_assets(job_id, reference_id);

      CREATE TABLE IF NOT EXISTS job_command_receipts (
        actor_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        command TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (actor_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS execution_outbox (
        id TEXT PRIMARY KEY NOT NULL,
        job_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_execution_outbox_pending
        ON execution_outbox(dispatched_at, created_at);

      INSERT OR IGNORE INTO execution_pool_slots (
        pool, slot_number, run_id, status, lease_owner, lease_expires_at, claimed_at, released_at
      ) VALUES ('job-execution', 1, NULL, 'free', NULL, NULL, NULL, NULL);
    `)

    // Best-effort copy of still-active leases from the 030 shape (seconds → ms).
    const legacy = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_leases_v030'`
      )
      .get() as { name: string } | undefined
    if (legacy) {
      db.exec(`
        INSERT OR IGNORE INTO workspace_leases (
          id, canonical_workspace_root, owner_type, owner_id, run_id,
          status, lease_owner, lease_expires_at, created_at, released_at
        )
        SELECT
          id,
          canonical_path,
          owner_kind,
          owner_id,
          run_id,
          status,
          COALESCE(boot_id, 'legacy'),
          CASE WHEN lease_expires_at < 100000000000 THEN lease_expires_at * 1000 ELSE lease_expires_at END,
          CASE WHEN created_at < 100000000000 THEN created_at * 1000 ELSE created_at END,
          CASE
            WHEN released_at IS NULL THEN NULL
            WHEN released_at < 100000000000 THEN released_at * 1000
            ELSE released_at
          END
        FROM workspace_leases_v030
        WHERE status = 'active';
      `)
    }
  }
}

export const executionSchemaMigrations: ExecutionMigration[] = [migration045ExecutionModuleTables]
