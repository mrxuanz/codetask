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

export const KERNEL_SCHEMA_VERSION = 3
const KERNEL_MIGRATIONS: readonly KernelMigration[] = [
  migration001Authentication,
  migration002Conversation,
  migration003DraftPlanning
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
