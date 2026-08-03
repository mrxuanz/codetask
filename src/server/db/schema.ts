import {
  blob,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  index
} from 'drizzle-orm/sqlite-core'

export const appSettings = sqliteTable('app_settings', {
  namespace: text('namespace').primaryKey(),
  valueJson: text('value_json').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  revision: integer('revision').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export const authSecret = sqliteTable('auth_secret', {
  singletonKey: integer('singleton_key').primaryKey(),
  secretHex: text('secret_hex').notNull(),
  createdAtMs: integer('created_at_ms').notNull()
})

export const authUsers = sqliteTable(
  'auth_users',
  {
    id: text('id').primaryKey(),
    singletonKey: integer('singleton_key').notNull(),
    username: text('username').notNull(),
    normalizedUsername: text('normalized_username').notNull(),
    passwordHash: text('password_hash').notNull(),
    passwordVersion: integer('password_version').notNull().default(1),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    disabledAtMs: integer('disabled_at_ms')
  },
  (table) => [
    uniqueIndex('idx_auth_users_singleton').on(table.singletonKey),
    uniqueIndex('idx_auth_users_normalized_username').on(table.normalizedUsername)
  ]
)

export const authSessions = sqliteTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    tokenDigest: text('token_digest').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    lastSeenAtMs: integer('last_seen_at_ms').notNull(),
    expiresAtMs: integer('expires_at_ms').notNull(),
    revokedAtMs: integer('revoked_at_ms'),
    revokeReason: text('revoke_reason')
  },
  (table) => [
    uniqueIndex('idx_auth_sessions_token_digest').on(table.tokenDigest),
    index('idx_auth_sessions_user_active').on(table.userId, table.revokedAtMs, table.expiresAtMs)
  ]
)

export const authChallenges = sqliteTable(
  'auth_challenges',
  {
    id: text('id').primaryKey(),
    scopeKey: text('scope_key').notNull(),
    answerDigest: text('answer_digest').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    expiresAtMs: integer('expires_at_ms').notNull(),
    consumedAtMs: integer('consumed_at_ms'),
    createdAtMs: integer('created_at_ms').notNull()
  },
  (table) => [
    index('idx_auth_challenges_scope').on(table.scopeKey),
    index('idx_auth_challenges_expiry').on(table.expiresAtMs)
  ]
)

export const authThrottles = sqliteTable('auth_throttles', {
  key: text('key').primaryKey(),
  windowStartedAtMs: integer('window_started_at_ms').notNull(),
  requestCount: integer('request_count').notNull().default(0),
  failureCount: integer('failure_count').notNull().default(0),
  captchaRequired: integer('captcha_required').notNull().default(0),
  lockedUntilMs: integer('locked_until_ms'),
  updatedAtMs: integer('updated_at_ms').notNull()
})

export const authAudit = sqliteTable('auth_audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventType: text('event_type').notNull(),
  userId: text('user_id'),
  subjectDigest: text('subject_digest'),
  scopeDigest: text('scope_digest'),
  success: integer('success').notNull(),
  reasonCode: text('reason_code'),
  createdAtMs: integer('created_at_ms').notNull()
})

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id').notNull(),
    title: text('title').notNull(),
    workspaceRoot: text('workspace_root').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [uniqueIndex('idx_projects_actor_workspace').on(table.actorId, table.workspaceRoot)]
)

export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  actorId: text('actor_id').notNull(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  status: text('status').notNull(),
  conversationId: text('conversation_id').notNull(),
  coreCode: text('core_code').notNull(),
  runtimeStatus: text('runtime_status').notNull(),
  runtimeSessionId: text('runtime_session_id'),
  coreRuntimeJson: text('core_runtime_json').notNull().default('{}'),
  lastError: text('last_error'),
  lastUsedAt: integer('last_used_at'),
  titleSource: text('title_source').notNull().default('auto'),
  /** Live CHECK is chat-only after migration 056. */
  threadKind: text('thread_kind').notNull().default('chat'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export const threadMessages = sqliteTable('thread_messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull(),
  role: text('role').notNull(),
  kind: text('kind').notNull(),
  content: text('content').notNull(),
  coreCode: text('core_code').notNull(),
  conversationId: text('conversation_id').notNull(),
  runtimeSessionId: text('runtime_session_id'),
  payloadJson: text('payload_json'),
  payloadArtifactId: text('payload_artifact_id'),
  attachmentsJson: text('attachments_json'),
  createdAt: text('created_at').notNull()
})

/** Conversation-module turns (migration 048+). Host drizzle mirror for cross-module reads. */
export const conversationTurns = sqliteTable('conversation_turns', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  actorId: text('actor_id').notNull(),
  state: text('state').notNull(),
  inputText: text('input_text').notNull().default(''),
  providerCode: text('provider_code').notNull(),
  workspaceAccess: text('workspace_access').notNull().default('live-read'),
  settingsSnapshotJson: text('settings_snapshot_json').notNull().default('{}'),
  settingsHash: text('settings_hash').notNull().default(''),
  idempotencyKey: text('idempotency_key'),
  requestHash: text('request_hash').notNull().default(''),
  stateRevision: integer('state_revision').notNull().default(1),
  userMessageId: text('user_message_id'),
  assistantMessageId: text('assistant_message_id'),
  lastErrorJson: text('last_error_json'),
  createdAt: text('created_at').notNull(),
  admittedAt: text('admitted_at'),
  startedAt: text('started_at'),
  completedAt: text('completed_at')
})

export const designPlanRevisions = sqliteTable(
  'design_plan_revisions',
  {
    jobId: text('job_id').notNull(),
    planRevision: integer('plan_revision').notNull(),
    contentGzip: blob('content_gzip', { mode: 'buffer' }).notNull(),
    contentHash: text('content_hash').notNull(),
    rawByteSize: integer('raw_byte_size').notNull(),
    gzipByteSize: integer('gzip_byte_size').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at')
  },
  (table) => [primaryKey({ columns: [table.jobId, table.planRevision] })]
)

export const jobArtifacts = sqliteTable('job_artifacts', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  taskId: text('task_id'),
  kind: text('kind').notNull(),
  tier: text('tier').notNull().default('working'),
  contentHash: text('content_hash').notNull(),
  byteSize: integer('byte_size').notNull(),
  storage: text('storage').notNull(),
  contentInline: text('content_inline'),
  contentBlob: blob('content_blob', { mode: 'buffer' }),
  contentPath: text('content_path'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at')
})

export const jobCounters = sqliteTable(
  'job_counters',
  {
    jobId: text('job_id').notNull(),
    counterKey: text('counter_key').notNull(),
    value: integer('value').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.jobId, table.counterKey] })]
)

export const messageArtifacts = sqliteTable(
  'message_artifacts',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => threadMessages.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('payload'),
    contentHash: text('content_hash').notNull(),
    byteSize: integer('byte_size').notNull(),
    storage: text('storage').notNull(),
    contentInline: text('content_inline'),
    contentPath: text('content_path'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at')
  },
  (table) => [uniqueIndex('idx_message_artifacts_message_kind').on(table.messageId, table.kind)]
)

/** FIX-PLAN F4-A / 02 §15.11: exclusive workspace write lease (Execution-unified schema). */
export const workspaceLeases = sqliteTable(
  'workspace_leases',
  {
    id: text('id').primaryKey(),
    canonicalWorkspaceRoot: text('canonical_workspace_root').notNull(),
    ownerType: text('owner_type').notNull(),
    ownerId: text('owner_id').notNull(),
    runId: text('run_id'),
    status: text('status').notNull(),
    leaseOwner: text('lease_owner').notNull(),
    leaseExpiresAt: integer('lease_expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
    releasedAt: integer('released_at')
  },
  (table) => [
    index('idx_workspace_leases_active_owner').on(table.ownerType, table.ownerId, table.status)
  ]
)

/** FIX-PLAN F4-B (§9.2–9.3): durable delete intent for drain coordinator + startup janitor. */
export const deletionRequests = sqliteTable('deletion_requests', {
  id: text('id').primaryKey(),
  entityKind: text('entity_kind').notNull(),
  entityId: text('entity_id').notNull(),
  actorId: text('actor_id').notNull(),
  status: text('status').notNull(),
  phase: text('phase').notNull().default('requested'),
  threadId: text('thread_id'),
  projectId: text('project_id'),
  workspacePath: text('workspace_path'),
  frozenJson: text('frozen_json'),
  cleanupTargetsJson: text('cleanup_targets_json'),
  filesystemCleanupJson: text('filesystem_cleanup_json'),
  errorJson: text('error_json'),
  lastError: text('last_error'),
  retryCount: integer('retry_count').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export type AuthUser = typeof authUsers.$inferSelect
export type AuthSession = typeof authSessions.$inferSelect
export type Project = typeof projects.$inferSelect
export type Thread = typeof threads.$inferSelect
export type ThreadMessage = typeof threadMessages.$inferSelect
export type JobArtifact = typeof jobArtifacts.$inferSelect
export type ConversationTurn = typeof conversationTurns.$inferSelect
export type JobCounter = typeof jobCounters.$inferSelect
export type WorkspaceLease = typeof workspaceLeases.$inferSelect
export type DeletionRequest = typeof deletionRequests.$inferSelect
