import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  index
} from 'drizzle-orm/sqlite-core'

export const drafts = sqliteTable(
  'drafts',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id').notNull(),
    projectId: text('project_id').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    userFlow: text('user_flow').notNull().default(''),
    techStack: text('tech_stack').notNull().default(''),
    nfrJson: text('nfr_json').notNull().default('[]'),
    acceptanceJson: text('acceptance_json').notNull().default('[]'),
    verificationJson: text('verification_json').notNull().default('[]'),
    outOfScopeJson: text('out_of_scope_json').notNull().default('[]'),
    assumptionsJson: text('assumptions_json').notNull().default('[]'),
    requirementsMarkdown: text('requirements_markdown').notNull().default(''),
    requirementsStatus: text('requirements_status').notNull().default('pending'),
    lockedSectionsJson: text('locked_sections_json').notNull().default('{}'),
    executionProfileJson: text('execution_profile_json'),
    workspaceRoot: text('workspace_root').notNull(),
    status: text('status').notNull().default('editing'),
    lockRevision: integer('lock_revision').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    index('idx_drafts_actor_updated').on(table.actorId, table.updatedAt),
    index('idx_drafts_project').on(table.projectId)
  ]
)

export const draftAbilities = sqliteTable(
  'draft_abilities',
  {
    draftId: text('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    abilityCode: text('ability_code').notNull(),
    label: text('label').notNull(),
    description: text('description').notNull(),
    reason: text('reason').notNull().default(''),
    recommendedCoreCode: text('recommended_core_code').notNull(),
    sortOrder: integer('sort_order').notNull().default(0)
  },
  (table) => [primaryKey({ columns: [table.draftId, table.abilityCode] })]
)

export const draftReferences = sqliteTable(
  'design_draft_references',
  {
    id: text('id').primaryKey(),
    draftId: text('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    source: text('source'),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    mimeType: text('mime_type'),
    description: text('description').notNull().default(''),
    attachmentId: text('attachment_id'),
    localPath: text('local_path'),
    resolvedPath: text('resolved_path'),
    assetUrl: text('asset_url'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('idx_design_draft_references_draft').on(table.draftId)]
)

export const draftReferenceSnapshots = sqliteTable(
  'draft_reference_snapshots',
  {
    id: text('id').primaryKey(),
    draftId: text('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    draftLockRevision: integer('draft_lock_revision').notNull(),
    manifestJson: text('manifest_json').notNull(),
    contentHash: text('content_hash').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    index('idx_draft_reference_snapshots_draft').on(table.draftId, table.draftLockRevision)
  ]
)

export const planningSessions = sqliteTable(
  'planning_sessions',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id').notNull(),
    projectId: text('project_id').notNull(),
    sourceDraftId: text('source_draft_id')
      .notNull()
      .references(() => drafts.id),
    draftSnapshotJson: text('draft_snapshot_json').notNull(),
    referenceSnapshotId: text('reference_snapshot_id').references(() => draftReferenceSnapshots.id),
    executionProfileJson: text('execution_profile_json').notNull(),
    plannerSettingsSnapshotJson: text('planner_settings_snapshot_json').notNull().default('{}'),
    plannerSettingsHash: text('planner_settings_hash').notNull().default(''),
    status: text('status').notNull().default('queued'),
    activeRunId: text('active_run_id'),
    treeRevision: integer('tree_revision').notNull().default(0),
    publishedJobId: text('published_job_id'),
    lastErrorJson: text('last_error_json'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    publishedAt: integer('published_at')
  },
  (table) => [
    index('idx_planning_sessions_draft').on(table.sourceDraftId),
    index('idx_planning_sessions_actor').on(table.actorId, table.updatedAt)
  ]
)

export const planningRuns = sqliteTable(
  'planning_runs',
  {
    id: text('id').primaryKey(),
    planningSessionId: text('planning_session_id')
      .notNull()
      .references(() => planningSessions.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    attemptNo: integer('attempt_no').notNull(),
    provider: text('provider').notNull(),
    model: text('model'),
    fencingToken: text('fencing_token').notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    errorJson: text('error_json')
  },
  (table) => [
    index('idx_planning_runs_session').on(table.planningSessionId, table.attemptNo),
    uniqueIndex('idx_planning_runs_fence').on(table.fencingToken)
  ]
)

export const executionPlans = sqliteTable(
  'execution_plans',
  {
    id: text('id').primaryKey(),
    planningSessionId: text('planning_session_id')
      .notNull()
      .references(() => planningSessions.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    status: text('status').notNull().default('current'),
    contentHash: text('content_hash').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    uniqueIndex('idx_execution_plans_session_revision').on(
      table.planningSessionId,
      table.revision
    )
  ]
)

export const executionPlanMilestones = sqliteTable('execution_plan_milestones', {
  id: text('id').primaryKey(),
  planId: text('plan_id')
    .notNull()
    .references(() => executionPlans.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  successCriteria: text('success_criteria').notNull().default(''),
  confirmed: integer('confirmed').notNull().default(0)
})

export const executionPlanSlices = sqliteTable('execution_plan_slices', {
  id: text('id').primaryKey(),
  planId: text('plan_id')
    .notNull()
    .references(() => executionPlans.id, { onDelete: 'cascade' }),
  milestoneId: text('milestone_id')
    .notNull()
    .references(() => executionPlanMilestones.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  successCriteria: text('success_criteria').notNull().default(''),
  confirmed: integer('confirmed').notNull().default(0)
})

export const executionPlanTasks = sqliteTable('execution_plan_tasks', {
  id: text('id').primaryKey(),
  planId: text('plan_id')
    .notNull()
    .references(() => executionPlans.id, { onDelete: 'cascade' }),
  sliceId: text('slice_id')
    .notNull()
    .references(() => executionPlanSlices.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  taskKind: text('task_kind').notNull(),
  abilityCode: text('ability_code').notNull(),
  coreCode: text('core_code').notNull(),
  contextMarkdown: text('context_markdown').notNull().default(''),
  successCriteria: text('success_criteria').notNull().default(''),
  referenceReason: text('reference_reason').notNull().default(''),
  canRunInParallel: integer('can_run_in_parallel').notNull().default(0),
  confirmed: integer('confirmed').notNull().default(0)
})

export const executionPlanDependencies = sqliteTable(
  'execution_plan_dependencies',
  {
    planId: text('plan_id')
      .notNull()
      .references(() => executionPlans.id, { onDelete: 'cascade' }),
    fromNodeId: text('from_node_id').notNull(),
    toNodeId: text('to_node_id').notNull(),
    dependencyKind: text('dependency_kind').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.planId, table.fromNodeId, table.toNodeId, table.dependencyKind] })
  ]
)

export const executionPlanTaskReferences = sqliteTable(
  'execution_plan_task_references',
  {
    planId: text('plan_id')
      .notNull()
      .references(() => executionPlans.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => executionPlanTasks.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id').notNull()
  },
  (table) => [primaryKey({ columns: [table.planId, table.taskId, table.referenceId] })]
)

export const executionPlanRevisions = sqliteTable(
  'execution_plan_revisions',
  {
    planningSessionId: text('planning_session_id')
      .notNull()
      .references(() => planningSessions.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    snapshotGzip: text('snapshot_gzip').notNull(),
    contentHash: text('content_hash').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at')
  },
  (table) => [
    primaryKey({ columns: [table.planningSessionId, table.revision] })
  ]
)

export const jobHandoffs = sqliteTable(
  'job_handoffs',
  {
    submissionId: text('submission_id').primaryKey(),
    planningSessionId: text('planning_session_id')
      .notNull()
      .references(() => planningSessions.id),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status').notNull().default('pending'),
    jobId: text('job_id'),
    attempts: integer('attempts').notNull().default(0),
    lastErrorJson: text('last_error_json'),
    createdAt: integer('created_at').notNull(),
    acceptedAt: integer('accepted_at')
  },
  (table) => [
    uniqueIndex('idx_job_handoffs_idempotency').on(table.idempotencyKey),
    index('idx_job_handoffs_status').on(table.status, table.createdAt)
  ]
)

export const migrationFailures = sqliteTable('migration_failures', {
  id: text('id').primaryKey(),
  migrationName: text('migration_name').notNull(),
  sourceKey: text('source_key').notNull(),
  reason: text('reason').notNull(),
  payloadJson: text('payload_json'),
  createdAt: integer('created_at').notNull()
})

export const planningCapacityLeases = sqliteTable(
  'planning_capacity_leases',
  {
    id: text('id').primaryKey(),
    planningSessionId: text('planning_session_id')
      .notNull()
      .references(() => planningSessions.id, { onDelete: 'cascade' }),
    pool: text('pool').notNull(),
    acquiredAt: integer('acquired_at').notNull(),
    releasedAt: integer('released_at')
  },
  (table) => [
    uniqueIndex('idx_planning_capacity_active').on(table.pool, table.releasedAt)
  ]
)
