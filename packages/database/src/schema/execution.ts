import { integer, primaryKey, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core'

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    submissionId: text('submission_id').notNull().unique(),
    submissionHash: text('submission_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    actorId: text('actor_id').notNull(),
    projectId: text('project_id').notNull(),
    sourceDraftId: text('source_draft_id').notNull(),
    sourcePlanningSessionId: text('source_planning_session_id').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    workspaceRoot: text('workspace_root').notNull(),
    canonicalWorkspaceRoot: text('canonical_workspace_root').notNull(),
    state: text('state').notNull(),
    stateRevision: integer('state_revision').notNull().default(0),
    controlIntent: text('control_intent').notNull().default('none'),
    executionGeneration: integer('execution_generation').notNull().default(0),
    currentRunId: text('current_run_id'),
    suspensionKind: text('suspension_kind'),
    recoveryReason: text('recovery_reason'),
    lastErrorJson: text('last_error_json'),
    queuedAt: integer('queued_at'),
    startedAt: integer('started_at'),
    terminalAt: integer('terminal_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    uniqueIndex('idx_jobs_idempotency').on(table.idempotencyKey),
    index('idx_jobs_actor_updated').on(table.actorId, table.updatedAt),
    index('idx_jobs_state').on(table.state, table.queuedAt)
  ]
)

export const jobSnapshots = sqliteTable('job_snapshots', {
  jobId: text('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  draftSnapshotJson: text('draft_snapshot_json').notNull(),
  executionProfileJson: text('execution_profile_json').notNull(),
  executionSettingsSnapshotJson: text('execution_settings_snapshot_json').notNull(),
  referenceManifestJson: text('reference_manifest_json').notNull(),
  executionTreeJson: text('execution_tree_json').notNull(),
  settingsHash: text('settings_hash').notNull(),
  contentHash: text('content_hash').notNull(),
  createdAt: integer('created_at').notNull()
})

export const jobMilestones = sqliteTable(
  'job_milestones',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    sourceMilestoneId: text('source_milestone_id').notNull(),
    sortOrder: integer('sort_order').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    successCriteria: text('success_criteria').notNull().default(''),
    state: text('state').notNull().default('pending')
  },
  (table) => [index('idx_job_milestones_job').on(table.jobId, table.generation, table.sortOrder)]
)

export const jobSlices = sqliteTable(
  'job_slices',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    milestoneId: text('milestone_id')
      .notNull()
      .references(() => jobMilestones.id, { onDelete: 'cascade' }),
    sourceSliceId: text('source_slice_id').notNull(),
    sortOrder: integer('sort_order').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    successCriteria: text('success_criteria').notNull().default(''),
    state: text('state').notNull().default('pending'),
    verificationState: text('verification_state').notNull().default('pending')
  },
  (table) => [index('idx_job_slices_job').on(table.jobId, table.generation, table.sortOrder)]
)

export const jobWorkItems = sqliteTable(
  'job_work_items',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    sourceTaskId: text('source_task_id').notNull(),
    parentWorkId: text('parent_work_id'),
    milestoneId: text('milestone_id').notNull(),
    sliceId: text('slice_id').notNull(),
    kind: text('kind').notNull(),
    sortOrder: integer('sort_order').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    contextMarkdown: text('context_markdown').notNull().default(''),
    abilityCode: text('ability_code').notNull(),
    providerCode: text('provider_code').notNull(),
    successCriteria: text('success_criteria').notNull().default(''),
    canRunInParallel: integer('can_run_in_parallel').notNull().default(0),
    state: text('state').notNull().default('pending'),
    stateRevision: integer('state_revision').notNull().default(0),
    lastErrorJson: text('last_error_json'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    index('idx_job_work_items_job').on(table.jobId, table.generation, table.state),
    index('idx_job_work_items_slice').on(table.jobId, table.generation, table.sliceId)
  ]
)

export const jobWorkDependencies = sqliteTable(
  'job_work_dependencies',
  {
    jobId: text('job_id').notNull(),
    generation: integer('generation').notNull(),
    fromWorkId: text('from_work_id').notNull(),
    dependsOnWorkId: text('depends_on_work_id').notNull(),
    reason: text('reason').notNull()
  },
  (table) => [
    primaryKey({
      columns: [table.jobId, table.generation, table.fromWorkId, table.dependsOnWorkId]
    })
  ]
)

export const executionQueueEntries = sqliteTable(
  'execution_queue_entries',
  {
    jobId: text('job_id').notNull(),
    generation: integer('generation').notNull(),
    status: text('status').notNull(),
    priority: integer('priority').notNull().default(0),
    sequence: integer('sequence').notNull(),
    enqueuedAt: integer('enqueued_at').notNull(),
    claimedAt: integer('claimed_at'),
    removedAt: integer('removed_at')
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.generation] }),
    index('idx_execution_queue_status').on(
      table.status,
      table.priority,
      table.sequence,
      table.jobId
    )
  ]
)

export const executionRuns = sqliteTable(
  'execution_runs',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    status: text('status').notNull(),
    leaseOwner: text('lease_owner').notNull(),
    leaseExpiresAt: integer('lease_expires_at').notNull(),
    fencingToken: integer('fencing_token').notNull().default(1),
    runtimeRefJson: text('runtime_ref_json'),
    startedAt: integer('started_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    releasedAt: integer('released_at'),
    releaseReason: text('release_reason')
  },
  (table) => [index('idx_execution_runs_job').on(table.jobId, table.generation)]
)

export const executionPoolSlots = sqliteTable(
  'execution_pool_slots',
  {
    pool: text('pool').notNull(),
    slotNumber: integer('slot_number').notNull(),
    runId: text('run_id'),
    status: text('status').notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: integer('lease_expires_at'),
    claimedAt: integer('claimed_at'),
    releasedAt: integer('released_at')
  },
  (table) => [primaryKey({ columns: [table.pool, table.slotNumber] })]
)

export const executionOutbox = sqliteTable(
  'execution_outbox',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    eventType: text('event_type').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: integer('created_at').notNull(),
    dispatchedAt: integer('dispatched_at'),
    attempts: integer('attempts').notNull().default(0),
    lastErrorJson: text('last_error_json')
  },
  (table) => [index('idx_execution_outbox_pending').on(table.dispatchedAt, table.createdAt)]
)
