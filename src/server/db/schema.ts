import { integer, primaryKey, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core'

export const authState = sqliteTable('auth_state', {
  id: integer('id').primaryKey(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  sessionToken: text('session_token'),
  sessionExpiresAt: integer('session_expires_at'),
  createdAt: integer('created_at').notNull()
})

export const authGuardState = sqliteTable('auth_guard_state', {
  id: integer('id').primaryKey(),
  failCount: integer('fail_count').notNull().default(0),
  lastFailedAt: integer('last_failed_at'),
  lockedUntil: integer('locked_until'),
  captchaRequired: integer('captcha_required').notNull().default(0),
  updatedAt: integer('updated_at').notNull()
})

export const authRateBucket = sqliteTable(
  'auth_rate_bucket',
  {
    bucketKey: text('bucket_key').notNull(),
    bucketStart: integer('bucket_start').notNull(),
    failCount: integer('fail_count').notNull().default(0),
    lastSeenAt: integer('last_seen_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.bucketKey, table.bucketStart] })]
)

export const captchaChallenge = sqliteTable('captcha_challenge', {
  id: text('id').primaryKey(),
  scopeKey: text('scope_key').notNull(),
  answerHash: text('answer_hash').notNull(),
  expiresAt: integer('expires_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  usedAt: integer('used_at'),
  createdAt: integer('created_at').notNull()
})

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    title: text('title').notNull(),
    workspaceRoot: text('workspace_root').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [uniqueIndex('idx_projects_user_workspace').on(table.username, table.workspaceRoot)]
)

export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
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
  activeDraftId: text('active_draft_id'),
  activePlanId: text('active_plan_id'),
  wizardPhase: text('wizard_phase').notNull().default('collect'),
  threadKind: text('thread_kind').notNull().default('chat'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export const threadMessages = sqliteTable('thread_messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  username: text('username').notNull(),
  role: text('role').notNull(),
  kind: text('kind').notNull(),
  content: text('content').notNull(),
  coreCode: text('core_code').notNull(),
  conversationId: text('conversation_id').notNull(),
  runtimeSessionId: text('runtime_session_id'),
  payloadJson: text('payload_json'),
  payloadArtifactId: text('payload_artifact_id'),
  attachmentsJson: text('attachments_json'),
  wizardPhase: text('wizard_phase'),
  createdAt: text('created_at').notNull()
})

export const threadJobs = sqliteTable(
  'thread_jobs',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    username: text('username').notNull(),
    draftMessageId: text('draft_message_id')
      .notNull()
      .references(() => threadMessages.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    status: text('status').notNull(),
    workspacePath: text('workspace_path').notNull(),
    planPhase: text('plan_phase').notNull().default('idle'),
    planStatus: text('plan_status').notNull().default('pending'),
    planContextsRegistered: integer('plan_contexts_registered').notNull().default(0),
    planContextsTotal: integer('plan_contexts_total').notNull().default(0),
    planMessage: text('plan_message'),
    planCountsJson: text('plan_counts_json').notNull().default('{}'),
    taskPhase: text('task_phase').notNull().default('idle'),
    taskStatus: text('task_status').notNull().default('pending'),
    taskCurrentIndex: integer('task_current_index').notNull().default(0),
    taskTotal: integer('task_total').notNull().default(0),
    taskCurrentTaskId: text('task_current_task_id'),
    taskMessage: text('task_message'),
    taskMetaJson: text('task_meta_json').notNull().default('{}'),
    lastError: text('last_error'),
    draftConfirmedAt: integer('draft_confirmed_at'),
    referenceManifestJson: text('reference_manifest_json'),
    planConfirmedAt: integer('plan_confirmed_at'),
    designSessionId: text('design_session_id'),
    snapshotDraftRevision: integer('snapshot_draft_revision'),
    snapshotPlanRevision: integer('snapshot_plan_revision'),
    snapshotManifestRevision: integer('snapshot_manifest_revision'),
    executionLeaseOwner: text('execution_lease_owner'),
    executionLeaseExpiresAt: integer('execution_lease_expires_at'),
    activeRunId: text('active_run_id'),
    terminalAt: integer('terminal_at'),
    runtimeBytes: integer('runtime_bytes').notNull().default(0),
    phase: text('phase'),
    draftRevision: integer('draft_revision').notNull().default(0),
    planRevision: integer('plan_revision').notNull().default(0),
    manifestRevision: integer('manifest_revision').notNull().default(0),
    corpusRevision: integer('corpus_revision').notNull().default(0),
    frozenCorpusRevision: integer('frozen_corpus_revision').notNull().default(0),
    planArtifactId: text('plan_artifact_id'),
    planArtifactPath: text('plan_artifact_path'),
    planSummaryJson: text('plan_summary_json'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [uniqueIndex('idx_thread_jobs_thread_draft').on(table.threadId, table.draftMessageId)]
)

export const jobTasks = sqliteTable(
  'job_tasks',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => threadJobs.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    title: text('title').notNull(),
    sortOrder: integer('sort_order').notNull(),
    status: text('status').notNull(),
    abilityCode: text('ability_code'),
    executionStatus: text('execution_status'),
    evidenceStatus: text('evidence_status'),
    evidenceJson: text('evidence_json'),
    evidenceArtifactId: text('evidence_artifact_id'),
    evidenceSummary: text('evidence_summary'),
    blockerKind: text('blocker_kind'),
    recoveryAction: text('recovery_action'),
    errorMessage: text('error_message'),
    coreCode: text('core_code')
  },
  (table) => [primaryKey({ columns: [table.jobId, table.taskId] })]
)

/**
 * FIX-PLAN F3-B (§8.3): minimal crash-recovery ledger for task execution attempts.
 * A row is created when a task attempt starts and finalised (completed/interrupted/failed) with a
 * result hash + checkpoint in the same transaction. Startup converts stale `running` attempts to
 * `interrupted`, then a fresh attempt is created under the same (job_id, task_id) identity.
 */
export const jobTaskAttempts = sqliteTable(
  'job_task_attempts',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => threadJobs.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    runId: text('run_id').references(() => workloadRuns.id, { onDelete: 'set null' }),
    attemptNo: integer('attempt_no').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull(),
    resultHash: text('result_hash'),
    errorJson: text('error_json'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at')
  },
  (table) => [
    uniqueIndex('idx_job_task_attempts_job_task_no').on(
      table.jobId,
      table.taskId,
      table.attemptNo
    ),
    uniqueIndex('idx_job_task_attempts_idempotency').on(table.idempotencyKey)
  ]
)

export const jobArtifacts = sqliteTable('job_artifacts', {
  id: text('id').primaryKey(),
  jobId: text('job_id')
    .notNull()
    .references(() => threadJobs.id, { onDelete: 'cascade' }),
  taskId: text('task_id'),
  kind: text('kind').notNull(),
  tier: text('tier').notNull().default('working'),
  contentHash: text('content_hash').notNull(),
  byteSize: integer('byte_size').notNull(),
  storage: text('storage').notNull(),
  contentInline: text('content_inline'),
  contentPath: text('content_path'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at')
})

export const jobCounters = sqliteTable(
  'job_counters',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => threadJobs.id, { onDelete: 'cascade' }),
    counterKey: text('counter_key').notNull(),
    value: integer('value').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.jobId, table.counterKey] })]
)

export const jobAbilities = sqliteTable(
  'job_abilities',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => threadJobs.id, { onDelete: 'cascade' }),
    abilityCode: text('ability_code').notNull(),
    sortOrder: integer('sort_order').notNull(),
    label: text('label'),
    recommendedCoreCode: text('recommended_core_code')
  },
  (table) => [primaryKey({ columns: [table.jobId, table.abilityCode] })]
)

export const jobPlanTasks = sqliteTable(
  'job_plan_tasks',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => threadJobs.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    sortOrder: integer('sort_order').notNull(),
    milestoneIndex: integer('milestone_index').notNull(),
    sliceIndex: integer('slice_index').notNull(),
    taskIndex: integer('task_index').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    taskKind: text('task_kind').notNull(),
    abilityCode: text('ability_code').notNull(),
    contextMarkdown: text('context_markdown').notNull().default(''),
    coreCode: text('core_code'),
    successCriteria: text('success_criteria').notNull().default(''),
    referenceIdsJson: text('reference_ids_json'),
    referenceReason: text('reference_reason'),
    dependsOnTaskRefsJson: text('depends_on_task_refs_json'),
    canRunInParallel: integer('can_run_in_parallel').notNull().default(0),
    confirmed: integer('confirmed')
  },
  (table) => [primaryKey({ columns: [table.jobId, table.taskId] })]
)

export const jobPlanMilestones = sqliteTable(
  'job_plan_milestones',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => threadJobs.id, { onDelete: 'cascade' }),
    milestoneIndex: integer('milestone_index').notNull(),
    sortOrder: integer('sort_order').notNull(),
    title: text('title').notNull().default(''),
    description: text('description').notNull().default(''),
    successCriteria: text('success_criteria').notNull().default(''),
    confirmed: integer('confirmed')
  },
  (table) => [primaryKey({ columns: [table.jobId, table.milestoneIndex] })]
)

export const jobPlanSlices = sqliteTable(
  'job_plan_slices',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => threadJobs.id, { onDelete: 'cascade' }),
    milestoneIndex: integer('milestone_index').notNull(),
    sliceIndex: integer('slice_index').notNull(),
    sortOrder: integer('sort_order').notNull(),
    title: text('title').notNull().default(''),
    description: text('description').notNull().default(''),
    successCriteria: text('success_criteria').notNull().default(''),
    dependsOnSliceRefsJson: text('depends_on_slice_refs_json'),
    confirmed: integer('confirmed')
  },
  (table) => [primaryKey({ columns: [table.jobId, table.milestoneIndex, table.sliceIndex] })]
)

/** Planner/wizard run ledger; design_session_id column retains name but FKs thread_jobs.id. */
export const designRuns = sqliteTable('design_runs', {
  id: text('id').primaryKey(),
  designSessionId: text('design_session_id')
    .notNull()
    .references(() => threadJobs.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  status: text('status').notNull(),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  plannerSessionId: text('planner_session_id'),
  planRevisionBefore: integer('plan_revision_before'),
  planRevisionAfter: integer('plan_revision_after'),
  toolName: text('tool_name'),
  error: text('error')
})

/** Reference corpus rows; design_session_id column retains name but FKs thread_jobs.id. */
export const draftReferences = sqliteTable('draft_references', {
  id: text('id').primaryKey(),
  designSessionId: text('design_session_id')
    .notNull()
    .references(() => threadJobs.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  description: text('description').notNull().default(''),
  attachmentId: text('attachment_id'),
  localPath: text('local_path'),
  resolvedPath: text('resolved_path'),
  assetUrl: text('asset_url'),
  mimeType: text('mime_type'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

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

export const workloadRuns = sqliteTable('workload_runs', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  ownerKind: text('owner_kind').notNull(),
  ownerId: text('owner_id').notNull(),
  kind: text('kind').notNull(),
  pool: text('pool').notNull().default('default'),
  status: text('status').notNull().default('active'),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: integer('lease_expires_at'),
  cancelReason: text('cancel_reason'),
  runtimeRefJson: text('runtime_ref_json'),
  startedAt: integer('started_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  releasedAt: integer('released_at')
})

export const workloadSlots = sqliteTable(
  'workload_slots',
  {
    runId: text('run_id')
      .notNull()
      .references(() => workloadRuns.id, { onDelete: 'cascade' }),
    username: text('username').notNull(),
    pool: text('pool').notNull().default('default'),
    ownerKind: text('owner_kind').notNull(),
    ownerId: text('owner_id').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('active'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: integer('lease_expires_at'),
    createdAt: integer('created_at').notNull(),
    releasedAt: integer('released_at')
  },
  (table) => [uniqueIndex('idx_workload_slots_run_id').on(table.runId)]
)

/** FIX-PLAN F4-A (§9.1): exclusive workspace write lease. */
export const workspaceLeases = sqliteTable(
  'workspace_leases',
  {
    id: text('id').primaryKey(),
    canonicalPath: text('canonical_path').notNull(),
    ownerKind: text('owner_kind').notNull(),
    ownerId: text('owner_id').notNull(),
    runId: text('run_id'),
    bootId: text('boot_id').notNull(),
    status: text('status').notNull(),
    leaseExpiresAt: integer('lease_expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
    releasedAt: integer('released_at')
  },
  (table) => [
    index('idx_workspace_leases_active_owner').on(table.ownerKind, table.ownerId, table.status)
  ]
)

/** FIX-PLAN F4-B (§9.2–9.3): durable delete intent for drain coordinator + startup janitor. */
export const deletionRequests = sqliteTable('deletion_requests', {
  id: text('id').primaryKey(),
  entityKind: text('entity_kind').notNull(),
  entityId: text('entity_id').notNull(),
  username: text('username').notNull(),
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

export type AuthState = typeof authState.$inferSelect
export type Project = typeof projects.$inferSelect
export type Thread = typeof threads.$inferSelect
export type ThreadMessage = typeof threadMessages.$inferSelect
export type ThreadJob = typeof threadJobs.$inferSelect
export type JobTask = typeof jobTasks.$inferSelect
export type JobTaskAttempt = typeof jobTaskAttempts.$inferSelect
export type JobArtifact = typeof jobArtifacts.$inferSelect
export type JobCounter = typeof jobCounters.$inferSelect
export type JobAbility = typeof jobAbilities.$inferSelect
export type JobPlanTask = typeof jobPlanTasks.$inferSelect
export type JobPlanMilestone = typeof jobPlanMilestones.$inferSelect
export type JobPlanSlice = typeof jobPlanSlices.$inferSelect
export type DraftReferenceRow = typeof draftReferences.$inferSelect
export type DesignRun = typeof designRuns.$inferSelect
export type WorkloadRun = typeof workloadRuns.$inferSelect
export type WorkloadSlot = typeof workloadSlots.$inferSelect
export type WorkspaceLease = typeof workspaceLeases.$inferSelect
export type DeletionRequest = typeof deletionRequests.$inferSelect
