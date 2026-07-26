/**
 * New-core SQLite DDL (Wave 4).
 *
 * Parallel to legacy drizzle migrations — `core_*` tables only.
 * Do not alter production migration history for these.
 *
 * ## No unbounded BLOB policy (重构.md §9.6)
 * - The main database must NOT store unbounded binary payloads or infinite logs.
 * - Individual business TEXT/BLOB payloads must not exceed 2 MiB.
 * - Large artifacts live on the filesystem; SQLite stores metadata only
 *   (storage_path, content_sha256, byte_size) — never file contents in BLOB columns.
 * - Provider stdout/stderr streams, workspace archives, and credential material
 *   must not be written into these tables.
 */

export const CORE_SCHEMA_VERSION = 2

/** Ordered CREATE statements for applyCoreSchema. */
export const CORE_TABLE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS core_schema_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS core_threads (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    revision INTEGER NOT NULL DEFAULT 0,
    draft_id TEXT,
    plan_id TEXT,
    job_id TEXT,
    title TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_core_threads_project
    ON core_threads(project_id)`,

  `CREATE TABLE IF NOT EXISTS core_drafts (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES core_threads(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_core_drafts_thread
    ON core_drafts(thread_id)`,

  `CREATE TABLE IF NOT EXISTS core_plans (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES core_threads(id) ON DELETE CASCADE,
    draft_id TEXT,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    execution_generation INTEGER NOT NULL DEFAULT 1,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_core_plans_thread
    ON core_plans(thread_id)`,

  `CREATE TABLE IF NOT EXISTS core_plan_nodes (
    id TEXT PRIMARY KEY NOT NULL,
    plan_id TEXT NOT NULL REFERENCES core_plans(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    parent_id TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_core_plan_nodes_plan
    ON core_plan_nodes(plan_id)`,

  `CREATE TABLE IF NOT EXISTS core_plan_edges (
    plan_id TEXT NOT NULL REFERENCES core_plans(id) ON DELETE CASCADE,
    from_node_id TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    PRIMARY KEY (plan_id, from_node_id, to_node_id)
  )`,

  `CREATE TABLE IF NOT EXISTS core_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES core_threads(id) ON DELETE CASCADE,
    plan_id TEXT,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    plan_revision INTEGER NOT NULL DEFAULT 1,
    execution_generation INTEGER NOT NULL DEFAULT 1,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    terminal_at_ms INTEGER
  )`,

  `CREATE INDEX IF NOT EXISTS idx_core_jobs_thread
    ON core_jobs(thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_core_jobs_status
    ON core_jobs(status)`,

  `CREATE TABLE IF NOT EXISTS core_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES core_jobs(id) ON DELETE CASCADE,
    plan_node_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    revision INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    dependency_ids_json TEXT NOT NULL DEFAULT '[]',
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (job_id, id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_core_tasks_job
    ON core_tasks(job_id)`,

  `CREATE TABLE IF NOT EXISTS core_task_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES core_tasks(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,
    status TEXT NOT NULL,
    execution_generation INTEGER NOT NULL DEFAULT 1,
    idempotency_key TEXT NOT NULL,
    result_hash TEXT,
    error_code TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (task_id, idempotency_key)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_core_task_attempts_task
    ON core_task_attempts(task_id)`,

  `CREATE TABLE IF NOT EXISTS core_verification_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    job_id TEXT NOT NULL REFERENCES core_jobs(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    status TEXT NOT NULL,
    execution_generation INTEGER NOT NULL DEFAULT 1,
    verdict TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_core_verification_attempts_job
    ON core_verification_attempts(job_id)`,

  `CREATE TABLE IF NOT EXISTS core_workspace_leases (
    workspace_id TEXT PRIMARY KEY NOT NULL,
    holder_id TEXT NOT NULL,
    acquired_at_ms INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS core_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    event_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    aggregate_revision INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    claimed_by TEXT,
    claimed_at_ms INTEGER,
    available_at_ms INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    acked_at_ms INTEGER
  )`,

  `CREATE INDEX IF NOT EXISTS idx_core_outbox_claim
    ON core_outbox(status, available_at_ms, id)`,

  `CREATE TABLE IF NOT EXISTS core_artifacts (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    job_id TEXT,
    kind TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER,
    deleted_at_ms INTEGER
  )`,

  `CREATE INDEX IF NOT EXISTS idx_core_artifacts_project
    ON core_artifacts(project_id)`,

  `CREATE TABLE IF NOT EXISTS core_retention_markers (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    marker TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (entity_kind, entity_id, marker)
  )`,

  `CREATE TABLE IF NOT EXISTS core_idempotency (
    key TEXT PRIMARY KEY NOT NULL,
    payload_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`
]

/** Full script (joined) for tooling / docs. */
export const CORE_TABLES_SQL = CORE_TABLE_STATEMENTS.join(';\n') + ';\n'
