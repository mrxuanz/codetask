import type Database from 'better-sqlite3'

interface KernelMigration {
  readonly version: number
  readonly name: string
  readonly checksum: string
  apply(database: Database.Database): void
}

const migration001Authentication: KernelMigration = {
  version: 1,
  name: 'authentication',
  checksum: 'auth-kernel-001-2026-07-26',
  apply(database): void {
    database.exec(`
      CREATE TABLE auth_users (
        id TEXT PRIMARY KEY,
        singleton_key INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton_key = 1),
        username TEXT NOT NULL,
        normalized_username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_version INTEGER NOT NULL CHECK (password_version >= 1),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
        disabled_at_ms INTEGER
      );

      CREATE TABLE auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        token_digest TEXT NOT NULL UNIQUE CHECK (length(token_digest) = 64),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        last_seen_at_ms INTEGER NOT NULL CHECK (last_seen_at_ms >= created_at_ms),
        expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
        revoked_at_ms INTEGER,
        revoke_reason TEXT,
        CHECK (
          (revoked_at_ms IS NULL AND revoke_reason IS NULL)
          OR (revoked_at_ms IS NOT NULL AND revoke_reason IS NOT NULL)
        )
      );

      CREATE INDEX idx_auth_sessions_user_active
        ON auth_sessions(user_id, revoked_at_ms, expires_at_ms, created_at_ms DESC);
      CREATE INDEX idx_auth_sessions_expiry
        ON auth_sessions(expires_at_ms);

      CREATE TABLE auth_throttles (
        key TEXT PRIMARY KEY,
        window_started_at_ms INTEGER NOT NULL CHECK (window_started_at_ms >= 0),
        request_count INTEGER NOT NULL CHECK (request_count >= 0),
        failure_count INTEGER NOT NULL CHECK (failure_count >= 0),
        captcha_required INTEGER NOT NULL CHECK (captcha_required IN (0, 1)),
        locked_until_ms INTEGER,
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= window_started_at_ms)
      );

      CREATE INDEX idx_auth_throttles_updated ON auth_throttles(updated_at_ms);

      CREATE TABLE auth_challenges (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        answer_digest TEXT NOT NULL CHECK (length(answer_digest) = 64),
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
        expires_at_ms INTEGER NOT NULL,
        consumed_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        CHECK (expires_at_ms > created_at_ms),
        CHECK (attempts <= max_attempts)
      );

      CREATE INDEX idx_auth_challenges_scope
        ON auth_challenges(scope_key, created_at_ms DESC);
      CREATE INDEX idx_auth_challenges_expiry ON auth_challenges(expires_at_ms);

      CREATE TABLE auth_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        user_id TEXT REFERENCES auth_users(id) ON DELETE SET NULL,
        subject_digest TEXT,
        scope_digest TEXT,
        success INTEGER NOT NULL CHECK (success IN (0, 1)),
        reason_code TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
      );

      CREATE INDEX idx_auth_audit_created ON auth_audit(created_at_ms DESC);
      CREATE INDEX idx_auth_audit_user_created
        ON auth_audit(user_id, created_at_ms DESC);
    `)
  }
}

const migration002Conversation: KernelMigration = {
  version: 2,
  name: 'conversation',
  checksum: 'conversation-kernel-002-2026-07-26',
  apply(database): void {
    database.exec(`
      CREATE TABLE conversation_settings (
        user_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
        provider_code TEXT NOT NULL DEFAULT 'cursorcli' CHECK (provider_code = 'cursorcli'),
        model TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      );

      CREATE TABLE conversation_workspaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        root_path TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
        UNIQUE(user_id, canonical_key)
      );

      CREATE INDEX idx_conversation_workspaces_user_updated
        ON conversation_workspaces(user_id, updated_at_ms DESC, id);

      CREATE TABLE conversation_threads (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES conversation_workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        provider_code TEXT NOT NULL DEFAULT 'cursorcli' CHECK (provider_code = 'cursorcli'),
        model TEXT,
        runtime_session_id TEXT,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
        last_message_at_ms INTEGER
      );

      CREATE INDEX idx_conversation_threads_workspace_activity
        ON conversation_threads(workspace_id, last_message_at_ms DESC, created_at_ms DESC, id);

      CREATE TABLE conversation_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        UNIQUE(thread_id, sequence)
      );

      CREATE INDEX idx_conversation_messages_thread_sequence
        ON conversation_messages(thread_id, sequence);

      CREATE TABLE conversation_turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        user_message_id TEXT NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'cancelled')),
        provider_code TEXT NOT NULL CHECK (provider_code = 'cursorcli'),
        model TEXT,
        error_code TEXT,
        error_message TEXT,
        started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
        finished_at_ms INTEGER,
        CHECK (
          (state = 'running' AND finished_at_ms IS NULL)
          OR (state <> 'running' AND finished_at_ms IS NOT NULL)
        )
      );

      CREATE UNIQUE INDEX idx_conversation_turns_one_running
        ON conversation_turns(thread_id)
        WHERE state = 'running';
      CREATE INDEX idx_conversation_turns_thread_started
        ON conversation_turns(thread_id, started_at_ms DESC);
    `)
  }
}

const migration003DraftPlanning: KernelMigration = {
  version: 3,
  name: 'draft-planning',
  checksum: 'draft-planning-kernel-003-2026-07-26',
  apply(database): void {
    database.exec(`
      CREATE TABLE draft_settings (
        user_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
        provider_code TEXT NOT NULL DEFAULT 'cursorcli' CHECK (provider_code = 'cursorcli'),
        model TEXT,
        planner_prompt TEXT,
        skills_manual TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      );

      CREATE TABLE drafts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES conversation_workspaces(id) ON DELETE CASCADE,
        source_thread_id TEXT REFERENCES conversation_threads(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        requirements TEXT NOT NULL,
        constraints_text TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('editing', 'generating', 'tree_ready', 'submitted')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        active_tree_id TEXT,
        submitted_handoff_id TEXT,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
        submitted_at_ms INTEGER,
        CHECK (
          (status = 'submitted' AND submitted_handoff_id IS NOT NULL AND submitted_at_ms IS NOT NULL)
          OR (status <> 'submitted' AND submitted_handoff_id IS NULL AND submitted_at_ms IS NULL)
        )
      );

      CREATE INDEX idx_drafts_user_updated
        ON drafts(user_id, updated_at_ms DESC, id);
      CREATE INDEX idx_drafts_workspace_updated
        ON drafts(workspace_id, updated_at_ms DESC, id);

      CREATE TABLE draft_attachments (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        storage_relative_path TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        UNIQUE(draft_id, storage_relative_path)
      );

      CREATE INDEX idx_draft_attachments_draft_created
        ON draft_attachments(draft_id, created_at_ms, id);

      CREATE TABLE draft_generation_runs (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'cancelled')),
        source_draft_revision INTEGER NOT NULL CHECK (source_draft_revision >= 1),
        settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0),
        provider_code TEXT NOT NULL CHECK (provider_code = 'cursorcli'),
        model TEXT,
        error_code TEXT,
        error_message TEXT,
        started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
        finished_at_ms INTEGER,
        CHECK (
          (state = 'running' AND finished_at_ms IS NULL)
          OR (state <> 'running' AND finished_at_ms IS NOT NULL)
        )
      );

      CREATE UNIQUE INDEX idx_draft_generation_one_running
        ON draft_generation_runs(draft_id)
        WHERE state = 'running';
      CREATE INDEX idx_draft_generation_draft_started
        ON draft_generation_runs(draft_id, started_at_ms DESC);

      CREATE TABLE draft_execution_trees (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        generation_run_id TEXT NOT NULL UNIQUE
          REFERENCES draft_generation_runs(id) ON DELETE CASCADE,
        tree_revision INTEGER NOT NULL CHECK (tree_revision >= 1),
        source_draft_revision INTEGER NOT NULL CHECK (source_draft_revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        tree_json TEXT NOT NULL,
        planner_prompt_snapshot TEXT NOT NULL,
        skills_manual_snapshot TEXT NOT NULL,
        model TEXT,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        UNIQUE(draft_id, tree_revision)
      );

      CREATE INDEX idx_draft_execution_trees_draft_revision
        ON draft_execution_trees(draft_id, tree_revision DESC);

      CREATE TABLE job_intake_handoffs (
        id TEXT PRIMARY KEY,
        source_draft_id TEXT NOT NULL UNIQUE,
        source_user_id TEXT NOT NULL,
        source_workspace_id TEXT NOT NULL,
        source_tree_id TEXT NOT NULL,
        source_draft_revision INTEGER NOT NULL CHECK (source_draft_revision >= 1),
        source_tree_revision INTEGER NOT NULL CHECK (source_tree_revision >= 1),
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'rejected')),
        draft_snapshot_json TEXT NOT NULL,
        execution_tree_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        accepted_at_ms INTEGER,
        rejected_at_ms INTEGER,
        rejection_code TEXT,
        CHECK (
          (state = 'pending' AND accepted_at_ms IS NULL AND rejected_at_ms IS NULL
            AND rejection_code IS NULL)
          OR (state = 'accepted' AND accepted_at_ms IS NOT NULL AND rejected_at_ms IS NULL
            AND rejection_code IS NULL)
          OR (state = 'rejected' AND accepted_at_ms IS NULL AND rejected_at_ms IS NOT NULL
            AND rejection_code IS NOT NULL)
        )
      );

      CREATE INDEX idx_job_intake_handoffs_state_created
        ON job_intake_handoffs(state, created_at_ms, id);

      CREATE TABLE job_intake_attachments (
        id TEXT PRIMARY KEY,
        handoff_id TEXT NOT NULL REFERENCES job_intake_handoffs(id) ON DELETE CASCADE,
        source_attachment_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        storage_relative_path TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        UNIQUE(handoff_id, source_attachment_id),
        UNIQUE(handoff_id, storage_relative_path)
      );

      CREATE INDEX idx_job_intake_attachments_handoff
        ON job_intake_attachments(handoff_id, created_at_ms, id);
    `)
  }
}

const migration004JobExecution: KernelMigration = {
  version: 4,
  name: 'job-execution',
  checksum: 'job-execution-kernel-004-2026-07-27',
  apply(database): void {
    database.exec(`
      CREATE TABLE job_settings (
        user_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
        max_concurrent_jobs INTEGER NOT NULL DEFAULT 2
          CHECK (max_concurrent_jobs BETWEEN 1 AND 2),
        work_provider TEXT NOT NULL DEFAULT 'codex'
          CHECK (work_provider IN ('codex', 'claude-code', 'opencode', 'cursorcli')),
        work_model TEXT,
        work_prompt TEXT,
        work_skills_manual TEXT,
        work_validation_enabled INTEGER NOT NULL DEFAULT 1 CHECK (work_validation_enabled IN (0, 1)),
        work_validation_provider TEXT NOT NULL DEFAULT 'claude-code'
          CHECK (work_validation_provider IN ('codex', 'claude-code', 'opencode', 'cursorcli')),
        work_validation_model TEXT,
        work_validation_prompt TEXT,
        work_validation_skills_manual TEXT,
        slice_validation_enabled INTEGER NOT NULL DEFAULT 1 CHECK (slice_validation_enabled IN (0, 1)),
        slice_validation_provider TEXT NOT NULL DEFAULT 'opencode'
          CHECK (slice_validation_provider IN ('codex', 'claude-code', 'opencode', 'cursorcli')),
        slice_validation_model TEXT,
        slice_validation_prompt TEXT,
        slice_validation_skills_manual TEXT,
        milestone_validation_enabled INTEGER NOT NULL DEFAULT 1
          CHECK (milestone_validation_enabled IN (0, 1)),
        milestone_validation_provider TEXT NOT NULL DEFAULT 'cursorcli'
          CHECK (milestone_validation_provider IN ('codex', 'claude-code', 'opencode', 'cursorcli')),
        milestone_validation_model TEXT,
        milestone_validation_prompt TEXT,
        milestone_validation_skills_manual TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        source_handoff_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL REFERENCES conversation_workspaces(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('queued', 'running', 'pause_requested', 'paused', 'succeeded', 'failed', 'deleted')
        ),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        queue_order INTEGER NOT NULL CHECK (queue_order >= 1),
        active_item_id TEXT,
        source_snapshot_json TEXT NOT NULL,
        execution_tree_json TEXT NOT NULL,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
        started_at_ms INTEGER,
        finished_at_ms INTEGER,
        deleted_at_ms INTEGER,
        CHECK (
          (state = 'deleted' AND deleted_at_ms IS NOT NULL)
          OR (state <> 'deleted' AND deleted_at_ms IS NULL)
        )
      );

      CREATE INDEX idx_jobs_user_state_queue
        ON jobs(user_id, state, queue_order, created_at_ms, id);
      CREATE INDEX idx_jobs_workspace_state
        ON jobs(workspace_id, state, updated_at_ms DESC);

      CREATE TABLE job_work_items (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        kind TEXT NOT NULL CHECK (
          kind IN ('work', 'work_validation', 'slice_validation', 'milestone_validation')
        ),
        tree_task_id TEXT,
        scope_id TEXT NOT NULL,
        parent_item_id TEXT REFERENCES job_work_items(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        files_json TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL,
        attachment_ids_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('queued', 'running', 'succeeded', 'failed', 'skipped')
        ),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        repair_generation INTEGER NOT NULL DEFAULT 0 CHECK (repair_generation >= 0),
        provider_code TEXT NOT NULL
          CHECK (provider_code IN ('codex', 'claude-code', 'opencode', 'cursorcli')),
        model TEXT,
        prompt_snapshot TEXT NOT NULL,
        skills_manual_snapshot TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        started_at_ms INTEGER,
        finished_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
        UNIQUE(job_id, sequence)
      );

      CREATE INDEX idx_job_work_items_job_sequence
        ON job_work_items(job_id, sequence, id);
      CREATE INDEX idx_job_work_items_job_state_sequence
        ON job_work_items(job_id, state, sequence, id);

      CREATE TABLE job_attachments (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        source_attachment_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        storage_relative_path TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        UNIQUE(job_id, source_attachment_id),
        UNIQUE(job_id, storage_relative_path)
      );

      CREATE INDEX idx_job_attachments_job
        ON job_attachments(job_id, created_at_ms, id);

      CREATE TABLE job_workspace_leases (
        workspace_id TEXT PRIMARY KEY REFERENCES conversation_workspaces(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
        lease_id TEXT NOT NULL UNIQUE,
        acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
        heartbeat_at_ms INTEGER NOT NULL CHECK (heartbeat_at_ms >= acquired_at_ms)
      );

      CREATE TABLE job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
      );

      CREATE INDEX idx_job_events_user_cursor ON job_events(user_id, id);
      CREATE INDEX idx_job_events_job_cursor ON job_events(job_id, id);
    `)
  }
}

const migration005ProviderThreads: KernelMigration = {
  version: 5,
  name: 'provider-threads',
  checksum: 'provider-threads-kernel-005-2026-07-27',
  apply(database): void {
    database.exec(`
      ALTER TABLE conversation_settings
        ADD COLUMN preferred_provider_code TEXT NOT NULL DEFAULT 'codex'
        CHECK (preferred_provider_code IN ('codex', 'claude-code', 'opencode', 'cursorcli'));

      ALTER TABLE conversation_threads
        ADD COLUMN selected_provider_code TEXT NOT NULL DEFAULT 'cursorcli'
        CHECK (selected_provider_code IN ('codex', 'claude-code', 'opencode', 'cursorcli'));

      ALTER TABLE conversation_turns
        ADD COLUMN selected_provider_code TEXT NOT NULL DEFAULT 'cursorcli'
        CHECK (selected_provider_code IN ('codex', 'claude-code', 'opencode', 'cursorcli'));
    `)
  }
}

const migration006PlannerThreads: KernelMigration = {
  version: 6,
  name: 'planner-threads',
  checksum: 'planner-threads-kernel-006-2026-07-27',
  apply(database): void {
    database.exec(`
      ALTER TABLE conversation_threads
        ADD COLUMN thread_kind TEXT NOT NULL DEFAULT 'chat'
        CHECK (thread_kind IN ('chat', 'planner'));

      ALTER TABLE draft_generation_runs
        ADD COLUMN selected_provider_code TEXT NOT NULL DEFAULT 'cursorcli'
        CHECK (selected_provider_code IN ('codex', 'claude-code', 'opencode', 'cursorcli'));

      ALTER TABLE draft_execution_trees
        ADD COLUMN selected_provider_code TEXT NOT NULL DEFAULT 'cursorcli'
        CHECK (selected_provider_code IN ('codex', 'claude-code', 'opencode', 'cursorcli'));

      ALTER TABLE drafts
        ADD COLUMN planner_phase TEXT NOT NULL DEFAULT 'gathering'
        CHECK (planner_phase IN ('gathering', 'ready'));

      UPDATE drafts SET planner_phase = 'ready';

      ALTER TABLE draft_settings ADD COLUMN discussion_prompt TEXT;
      ALTER TABLE draft_settings ADD COLUMN discussion_skills_manual TEXT;

      UPDATE job_settings SET
        work_model = NULL,
        work_validation_model = NULL,
        slice_validation_model = NULL,
        milestone_validation_model = NULL;

      UPDATE job_work_items SET model = NULL;

      CREATE INDEX idx_conversation_threads_workspace_kind_activity
        ON conversation_threads(
          workspace_id,
          thread_kind,
          last_message_at_ms DESC,
          created_at_ms DESC,
          id
        );
    `)
  }
}

export const KERNEL_SCHEMA_VERSION = 6
const KERNEL_MIGRATIONS: readonly KernelMigration[] = [
  migration001Authentication,
  migration002Conversation,
  migration003DraftPlanning,
  migration004JobExecution,
  migration005ProviderThreads,
  migration006PlannerThreads
]

function ensureMigrationTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS kernel_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
  `)
}

function verifyAppliedMigrations(database: Database.Database): number {
  const rows = database
    .prepare(
      `SELECT version, name, checksum
       FROM kernel_schema_migrations
       ORDER BY version`
    )
    .all() as Array<{ version: number; name: string; checksum: string }>

  for (const row of rows) {
    const migration = KERNEL_MIGRATIONS.find((candidate) => candidate.version === row.version)
    if (!migration || migration.name !== row.name || migration.checksum !== row.checksum) {
      throw new Error(`kernel_schema.migration_mismatch.${row.version}`)
    }
  }
  return rows.at(-1)?.version ?? 0
}

export function applyKernelMigrations(
  database: Database.Database,
  nowMs: () => number = Date.now
): void {
  ensureMigrationTable(database)
  const currentVersion = verifyAppliedMigrations(database)

  for (const migration of KERNEL_MIGRATIONS) {
    if (migration.version <= currentVersion) continue
    database.transaction(() => {
      migration.apply(database)
      database
        .prepare(
          `INSERT INTO kernel_schema_migrations
             (version, name, checksum, applied_at_ms)
           VALUES (?, ?, ?, ?)`
        )
        .run(migration.version, migration.name, migration.checksum, nowMs())
    })()
  }
}
