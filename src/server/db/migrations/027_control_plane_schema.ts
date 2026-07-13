import type { Migration } from './types'

function tableExists(db: Parameters<Migration['up']>[0], table: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
  )
}

export const migration027ControlPlaneSchema: Migration = {
  version: 27,
  name: 'control_plane_schema',
  up(db) {
    if (tableExists(db, 'control_jobs')) return

    db.exec(`
      -- ============================================================
      -- control_jobs
      -- ============================================================
      CREATE TABLE control_jobs (
        id                    TEXT PRIMARY KEY,
        thread_id             TEXT NOT NULL,
        project_id            TEXT NOT NULL,
        draft_message_id      TEXT NOT NULL,
        state                 TEXT NOT NULL
          CHECK (state IN (
            'planning_queued','planning_running','plan_review',
            'execution_queued','execution_running',
            'pausing','paused','applying_changes',
            'succeeded','failed','cancelled'
          )),
        state_revision        INTEGER NOT NULL CHECK (state_revision >= 1),
        control_intent        TEXT NOT NULL CHECK (control_intent IN ('none','pause'))
          DEFAULT 'none',
        resume_target         TEXT
          CHECK (resume_target IS NULL OR resume_target IN ('planning_queued','execution_queued')),
        current_plan_revision INTEGER CHECK (current_plan_revision IS NULL OR current_plan_revision >= 1),
        execution_generation   INTEGER NOT NULL CHECK (execution_generation >= 0) DEFAULT 0,
        active_run_id         TEXT,
        last_failure_id       TEXT,
        title                 TEXT NOT NULL CHECK (length(title) > 0),
        requirements_summary  TEXT NOT NULL DEFAULT '',
        created_at_ms         INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms         INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        terminal_at_ms        INTEGER CHECK (terminal_at_ms IS NULL OR terminal_at_ms >= 0)
      );

      CREATE INDEX idx_control_jobs_project_state
        ON control_jobs(project_id, state, updated_at_ms DESC);
      CREATE INDEX idx_control_jobs_scheduler
        ON control_jobs(state, control_intent, active_run_id, created_at_ms);
      CREATE UNIQUE INDEX idx_control_jobs_thread_draft
        ON control_jobs(thread_id, draft_message_id);

      -- ============================================================
      -- control_job_runs
      -- ============================================================
      CREATE TABLE control_job_runs (
        id                      TEXT PRIMARY KEY,
        job_id                  TEXT NOT NULL,
        kind                    TEXT NOT NULL CHECK (kind IN ('planning','execution')),
        state                   TEXT NOT NULL
          CHECK (state IN (
            'queued','starting','active','retrying',
            'pausing','cancelling','stopping','exiting',
            'paused','succeeded','failed','cancelled','interrupted'
          )),
        attempt_no              INTEGER NOT NULL CHECK (attempt_no >= 1),
        fence_token             TEXT NOT NULL,
        execution_generation    INTEGER NOT NULL CHECK (execution_generation >= 0),
        lease_owner_boot_id     TEXT,
        current_runtime_instance_id TEXT,
        pending_attempt_id      TEXT,
        lifecycle_operation_id  TEXT,
        heartbeat_at_ms         INTEGER,
        stop_reason             TEXT,
        started_at_ms           INTEGER NOT NULL CHECK (started_at_ms >= 0),
        ended_at_ms             INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= 0)
      );

      CREATE UNIQUE INDEX idx_control_job_runs_fence
        ON control_job_runs(job_id, fence_token);

      -- ============================================================
      -- control_runtime_instances
      -- ============================================================
      CREATE TABLE control_runtime_instances (
        id                  TEXT PRIMARY KEY,
        run_id              TEXT NOT NULL,
        task_attempt_id     TEXT,
        state               TEXT NOT NULL
          CHECK (state IN ('starting','active','stopping','closed')),
        owner_boot_id       TEXT NOT NULL,
        provider            TEXT,
        protocol_state      TEXT,
        pid_or_handle_ref   TEXT,
        started_at_ms       INTEGER NOT NULL CHECK (started_at_ms >= 0),
        closed_at_ms        INTEGER CHECK (closed_at_ms IS NULL OR closed_at_ms >= 0),
        exit_kind           TEXT,
        exit_code           INTEGER,
        signal              TEXT
      );

      CREATE UNIQUE INDEX idx_control_runtime_instances_run_active
        ON control_runtime_instances(run_id)
        WHERE state != 'closed';

      -- ============================================================
      -- control_job_tasks
      -- ============================================================
      CREATE TABLE control_job_tasks (
        job_id              TEXT NOT NULL,
        execution_generation INTEGER NOT NULL,
        task_id             TEXT NOT NULL,
        source_plan_revision INTEGER NOT NULL,
        state               TEXT NOT NULL
          CHECK (state IN ('queued','running','completed','blocked','failed','skipped')),
        sort_order          INTEGER NOT NULL,
        origin_kind         TEXT,
        parent_task_id      TEXT,
        title               TEXT NOT NULL,
        ability_code        TEXT,
        core_code           TEXT,
        created_at_ms       INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms       INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        PRIMARY KEY (job_id, execution_generation, task_id)
      );

      -- ============================================================
      -- control_task_attempts
      -- ============================================================
      CREATE TABLE control_task_attempts (
        id                  TEXT PRIMARY KEY,
        job_id              TEXT NOT NULL,
        execution_generation INTEGER NOT NULL,
        task_id             TEXT NOT NULL,
        attempt_no          INTEGER NOT NULL CHECK (attempt_no >= 1),
        run_id              TEXT NOT NULL,
        state               TEXT NOT NULL
          CHECK (state IN ('running','completed','failed','interrupted')),
        provider            TEXT,
        evidence_blob_hash  TEXT,
        failure_id          TEXT,
        started_at_ms       INTEGER NOT NULL CHECK (started_at_ms >= 0),
        ended_at_ms         INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= 0),
        result_hash         TEXT
      );

      CREATE UNIQUE INDEX idx_control_task_attempts_unique
        ON control_task_attempts(job_id, execution_generation, task_id, attempt_no);

      -- ============================================================
      -- control_verifications
      -- ============================================================
      CREATE TABLE control_verifications (
        id                  TEXT PRIMARY KEY,
        job_id              TEXT NOT NULL,
        execution_generation INTEGER NOT NULL,
        plan_revision       INTEGER NOT NULL,
        scope_type          TEXT NOT NULL CHECK (scope_type IN ('slice','milestone')),
        scope_id            TEXT NOT NULL,
        attempt_no          INTEGER NOT NULL CHECK (attempt_no >= 1),
        state               TEXT NOT NULL CHECK (state IN ('running','passed','rejected','interrupted','superseded')),
        run_id              TEXT,
        fence_token         TEXT,
        verdict_blob_hash   TEXT,
        result_hash         TEXT,
        failure_id          TEXT,
        started_at_ms       INTEGER NOT NULL CHECK (started_at_ms >= 0),
        ended_at_ms         INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= 0),
        -- state=passed REQUIRES verdict_blob_hash, result_hash, ended_at_ms
        CHECK (
          state != 'passed' OR (
            verdict_blob_hash IS NOT NULL
            AND result_hash IS NOT NULL
            AND ended_at_ms IS NOT NULL
          )
        )
      );

      CREATE UNIQUE INDEX idx_control_verifications_unique
        ON control_verifications(job_id, execution_generation, plan_revision, scope_type, scope_id, attempt_no);

      -- ============================================================
      -- control_plan_revisions
      -- ============================================================
      CREATE TABLE control_plan_revisions (
        id              TEXT PRIMARY KEY,
        job_id          TEXT NOT NULL,
        plan_revision   INTEGER NOT NULL CHECK (plan_revision >= 1),
        status          TEXT NOT NULL CHECK (status IN ('draft','confirmed','superseded')),
        content_hash    TEXT NOT NULL,
        created_at_ms   INTEGER NOT NULL CHECK (created_at_ms >= 0)
      );

      -- ============================================================
      -- control_plan_milestones
      -- ============================================================
      CREATE TABLE control_plan_milestones (
        id              TEXT PRIMARY KEY,
        job_id          TEXT NOT NULL,
        plan_revision   INTEGER NOT NULL,
        milestone_id    TEXT NOT NULL,
        title           TEXT NOT NULL,
        sort_order      INTEGER NOT NULL,
        created_at_ms   INTEGER NOT NULL CHECK (created_at_ms >= 0)
      );

      -- ============================================================
      -- control_plan_slices
      -- ============================================================
      CREATE TABLE control_plan_slices (
        id              TEXT PRIMARY KEY,
        job_id          TEXT NOT NULL,
        plan_revision   INTEGER NOT NULL,
        milestone_id    TEXT NOT NULL,
        slice_id        TEXT NOT NULL,
        title           TEXT NOT NULL,
        sort_order      INTEGER NOT NULL,
        created_at_ms   INTEGER NOT NULL CHECK (created_at_ms >= 0)
      );

      -- ============================================================
      -- control_plan_tasks
      -- ============================================================
      CREATE TABLE control_plan_tasks (
        id              TEXT PRIMARY KEY,
        job_id          TEXT NOT NULL,
        plan_revision   INTEGER NOT NULL,
        task_id         TEXT NOT NULL,
        ability_code    TEXT,
        core_code       TEXT,
        created_at_ms   INTEGER NOT NULL CHECK (created_at_ms >= 0)
      );

      -- ============================================================
      -- control_resource_slots
      -- ============================================================
      CREATE TABLE control_resource_slots (
        id              TEXT PRIMARY KEY,
        job_id          TEXT NOT NULL,
        run_id          TEXT NOT NULL,
        pool            TEXT NOT NULL,
        state           TEXT NOT NULL CHECK (state IN ('active','released')),
        created_at_ms   INTEGER NOT NULL CHECK (created_at_ms >= 0),
        released_at_ms  INTEGER CHECK (released_at_ms IS NULL OR released_at_ms >= 0)
      );

      CREATE UNIQUE INDEX idx_control_resource_slots_run
        ON control_resource_slots(run_id);
      CREATE UNIQUE INDEX idx_control_resource_slots_active
        ON control_resource_slots(job_id)
        WHERE state != 'released';

      -- ============================================================
      -- control_outbox_events
      -- ============================================================
      CREATE TABLE control_outbox_events (
        event_id            INTEGER PRIMARY KEY AUTOINCREMENT,
        topic               TEXT NOT NULL,
        event_type          TEXT NOT NULL,
        entity_id           TEXT NOT NULL,
        aggregate_revision  INTEGER NOT NULL,
        payload_json        TEXT NOT NULL,
        payload_bytes       INTEGER NOT NULL CHECK (payload_bytes >= 0),
        created_at_ms       INTEGER NOT NULL CHECK (created_at_ms >= 0),
        dispatched_at_ms    INTEGER CHECK (dispatched_at_ms IS NULL OR dispatched_at_ms >= 0)
      );

      CREATE INDEX idx_control_outbox_dispatch
        ON control_outbox_events(dispatched_at_ms, event_id);
      CREATE INDEX idx_control_outbox_topic
        ON control_outbox_events(topic, event_id);

      -- ============================================================
      -- control_command_dedup
      -- ============================================================
      CREATE TABLE control_command_dedup (
        actor_username    TEXT NOT NULL,
        idempotency_key   TEXT NOT NULL,
        command_type      TEXT NOT NULL,
        request_hash      TEXT NOT NULL,
        response_json     TEXT NOT NULL,
        response_revision INTEGER NOT NULL,
        created_at_ms     INTEGER NOT NULL CHECK (created_at_ms >= 0),
        expires_at_ms     INTEGER NOT NULL CHECK (expires_at_ms >= 0),
        PRIMARY KEY (actor_username, idempotency_key)
      );

      -- ============================================================
      -- control_job_failures
      -- ============================================================
      CREATE TABLE control_job_failures (
        id              TEXT PRIMARY KEY,
        job_id          TEXT NOT NULL,
        code            TEXT NOT NULL,
        recoverability  TEXT NOT NULL CHECK (recoverability IN ('recoverable','non_recoverable')),
        reason          TEXT,
        run_kind        TEXT CHECK (run_kind IS NULL OR run_kind IN ('planning','execution')),
        created_at_ms   INTEGER NOT NULL CHECK (created_at_ms >= 0)
      );

      -- ============================================================
      -- control_schema_meta
      -- ============================================================
      CREATE TABLE control_schema_meta (
        key           TEXT PRIMARY KEY,
        value         TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      );

      -- ============================================================
      -- control_evidence_blobs (content-addressed)
      -- ============================================================
      CREATE TABLE control_evidence_blobs (
        hash          TEXT PRIMARY KEY,
        content_json  TEXT NOT NULL,
        bytes         INTEGER NOT NULL CHECK (bytes >= 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
      );
    `)
  }
}
