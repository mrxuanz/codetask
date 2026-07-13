import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex
} from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

const JOB_STATES = [
  'planning_queued',
  'planning_running',
  'plan_review',
  'execution_queued',
  'execution_running',
  'pausing',
  'paused',
  'applying_changes',
  'succeeded',
  'failed',
  'cancelled'
] as const

const CONTROL_INTENTS = ['none', 'pause'] as const

const RESUME_TARGETS = ['planning_queued', 'execution_queued'] as const

const RUN_KINDS = ['planning', 'execution'] as const

const RUN_STATES = ['active', 'pausing', 'completed', 'failed', 'cancelled'] as const

const STOP_REASONS = [
  'user_cancelled',
  'app_shutdown',
  'run_interrupted',
  'run_failed',
  'pause_checkpoint_failed'
] as const

const TASK_STATES = ['queued', 'running', 'completed', 'blocked', 'failed', 'skipped'] as const

function inList(
  column: ReturnType<typeof text>,
  values: readonly string[]
): ReturnType<typeof sql> {
  return sql`(${column} IN (${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `
  )}))`
}

export const controlJobs = sqliteTable(
  'control_jobs',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id').notNull(),
    projectId: text('project_id').notNull(),
    draftMessageId: text('draft_message_id').notNull(),
    state: text('state').notNull(),
    stateRevision: integer('state_revision').notNull(),
    controlIntent: text('control_intent').notNull(),
    resumeTarget: text('resume_target'),
    currentPlanRevision: integer('current_plan_revision'),
    executionGeneration: integer('execution_generation').notNull(),
    activeRunId: text('active_run_id'),
    lastFailureId: text('last_failure_id'),
    title: text('title').notNull(),
    requirementsSummary: text('requirements_summary').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    terminalAtMs: integer('terminal_at_ms')
  },
  (table) => [
    uniqueIndex('idx_control_jobs_thread_draft').on(table.threadId, table.draftMessageId),
    index('idx_control_jobs_project_state').on(table.projectId, table.state, table.updatedAtMs),
    index('idx_control_jobs_scheduler').on(
      table.state,
      table.controlIntent,
      table.activeRunId,
      table.createdAtMs
    ),
    check('ck_control_jobs_state', inList(table.state, JOB_STATES)),
    check('ck_control_jobs_control_intent', inList(table.controlIntent, CONTROL_INTENTS)),
    check(
      'ck_control_jobs_resume_target',
      sql`${table.resumeTarget} IS NULL OR ${inList(table.resumeTarget, RESUME_TARGETS)}`
    ),
    check('ck_control_jobs_state_revision', sql`${table.stateRevision} >= 1`),
    check('ck_control_jobs_execution_generation', sql`${table.executionGeneration} >= 0`),
    check(
      'ck_control_jobs_current_plan_revision',
      sql`${table.currentPlanRevision} IS NULL OR ${table.currentPlanRevision} >= 1`
    ),
    check('ck_control_jobs_created_at_ms', sql`${table.createdAtMs} >= 0`),
    check('ck_control_jobs_updated_at_ms', sql`${table.updatedAtMs} >= 0`),
    check(
      'ck_control_jobs_terminal_at_ms',
      sql`${table.terminalAtMs} IS NULL OR ${table.terminalAtMs} >= 0`
    )
  ]
)

export const controlJobRuns = sqliteTable(
  'control_job_runs',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => controlJobs.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    attemptNo: integer('attempt_no').notNull(),
    fenceToken: text('fence_token').notNull(),
    executionGeneration: integer('execution_generation').notNull(),
    leaseOwnerBootId: text('lease_owner_boot_id'),
    heartbeatAtMs: integer('heartbeat_at_ms'),
    stopReason: text('stop_reason'),
    startedAtMs: integer('started_at_ms').notNull(),
    endedAtMs: integer('ended_at_ms')
  },
  (table) => [
    uniqueIndex('idx_control_job_runs_job_fence').on(table.jobId, table.fenceToken),
    check('ck_control_job_runs_kind', inList(table.kind, RUN_KINDS)),
    check('ck_control_job_runs_state', inList(table.state, RUN_STATES)),
    check(
      'ck_control_job_runs_stop_reason',
      sql`${table.stopReason} IS NULL OR ${inList(table.stopReason, STOP_REASONS)}`
    ),
    check('ck_control_job_runs_attempt_no', sql`${table.attemptNo} >= 1`),
    check('ck_control_job_runs_execution_generation', sql`${table.executionGeneration} >= 0`),
    check('ck_control_job_runs_started_at_ms', sql`${table.startedAtMs} >= 0`),
    check(
      'ck_control_job_runs_ended_at_ms',
      sql`${table.endedAtMs} IS NULL OR ${table.endedAtMs} >= 0`
    ),
    check(
      'ck_control_job_runs_heartbeat_at_ms',
      sql`${table.heartbeatAtMs} IS NULL OR ${table.heartbeatAtMs} >= 0`
    )
  ]
)

export const controlJobTasks = sqliteTable(
  'control_job_tasks',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => controlJobs.id, { onDelete: 'cascade' }),
    executionGeneration: integer('execution_generation').notNull(),
    taskId: text('task_id').notNull(),
    sourcePlanRevision: integer('source_plan_revision').notNull(),
    state: text('state').notNull(),
    sortOrder: integer('sort_order').notNull(),
    originKind: text('origin_kind'),
    parentTaskId: text('parent_task_id'),
    title: text('title').notNull(),
    abilityCode: text('ability_code'),
    coreCode: text('core_code'),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.executionGeneration, table.taskId] }),
    check('ck_control_job_tasks_state', inList(table.state, TASK_STATES)),
    check('ck_control_job_tasks_execution_generation', sql`${table.executionGeneration} >= 0`),
    check('ck_control_job_tasks_sort_order', sql`${table.sortOrder} >= 0`),
    check('ck_control_job_tasks_created_at_ms', sql`${table.createdAtMs} >= 0`),
    check('ck_control_job_tasks_updated_at_ms', sql`${table.updatedAtMs} >= 0`),
    index('idx_control_job_tasks_job_gen').on(table.jobId, table.executionGeneration)
  ]
)

export const controlTaskAttempts = sqliteTable(
  'control_task_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: text('job_id').notNull(),
    executionGeneration: integer('execution_generation').notNull(),
    taskId: text('task_id').notNull(),
    attemptNo: integer('attempt_no').notNull(),
    runId: text('run_id'),
    state: text('state').notNull(),
    provider: text('provider'),
    evidenceBlobHash: text('evidence_blob_hash'),
    failureId: text('failure_id'),
    startedAtMs: integer('started_at_ms').notNull(),
    endedAtMs: integer('ended_at_ms'),
    resultHash: text('result_hash')
  },
  (table) => [
    uniqueIndex('idx_control_task_attempts_unique').on(
      table.jobId,
      table.executionGeneration,
      table.taskId,
      table.attemptNo
    ),
    check('ck_control_task_attempts_attempt_no', sql`${table.attemptNo} >= 1`),
    check('ck_control_task_attempts_execution_generation', sql`${table.executionGeneration} >= 0`),
    check('ck_control_task_attempts_started_at_ms', sql`${table.startedAtMs} >= 0`),
    check(
      'ck_control_task_attempts_ended_at_ms',
      sql`${table.endedAtMs} IS NULL OR ${table.endedAtMs} >= 0`
    ),
    index('idx_control_task_attempts_task').on(
      table.jobId,
      table.executionGeneration,
      table.taskId
    )
  ]
)

export const controlVerifications = sqliteTable(
  'control_verifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scopeType: text('scope_type').notNull(),
    scopeId: text('scope_id').notNull(),
    attemptNo: integer('attempt_no').notNull(),
    runId: text('run_id'),
    fenceToken: text('fence_token'),
    executionGeneration: integer('execution_generation').notNull(),
    verdict: text('verdict').notNull(),
    failureId: text('failure_id'),
    createdAtMs: integer('created_at_ms').notNull()
  },
  (table) => [
    check('ck_control_verifications_attempt_no', sql`${table.attemptNo} >= 1`),
    check('ck_control_verifications_execution_generation', sql`${table.executionGeneration} >= 0`),
    check('ck_control_verifications_created_at_ms', sql`${table.createdAtMs} >= 0`),
    index('idx_control_verifications_scope').on(table.scopeType, table.scopeId)
  ]
)

export const controlOutboxEvents = sqliteTable(
  'control_outbox_events',
  {
    eventId: integer('event_id').primaryKey({ autoIncrement: true }),
    topic: text('topic').notNull(),
    eventType: text('event_type').notNull(),
    entityId: text('entity_id').notNull(),
    aggregateRevision: integer('aggregate_revision').notNull(),
    payloadJson: text('payload_json').notNull(),
    payloadBytes: integer('payload_bytes').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    dispatchedAtMs: integer('dispatched_at_ms')
  },
  (table) => [
    index('idx_control_outbox_events_dispatch').on(table.dispatchedAtMs, table.eventId),
    index('idx_control_outbox_events_topic').on(table.topic, table.eventId),
    check('ck_control_outbox_events_aggregate_revision', sql`${table.aggregateRevision} >= 1`),
    check('ck_control_outbox_events_payload_bytes', sql`${table.payloadBytes} >= 0`),
    check('ck_control_outbox_events_created_at_ms', sql`${table.createdAtMs} >= 0`),
    check(
      'ck_control_outbox_events_dispatched_at_ms',
      sql`${table.dispatchedAtMs} IS NULL OR ${table.dispatchedAtMs} >= 0`
    )
  ]
)

export const controlCommandDedup = sqliteTable(
  'control_command_dedup',
  {
    actorUsername: text('actor_username').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    commandType: text('command_type').notNull(),
    requestHash: text('request_hash').notNull(),
    responseJson: text('response_json').notNull(),
    responseRevision: integer('response_revision').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    expiresAtMs: integer('expires_at_ms').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.actorUsername, table.idempotencyKey] }),
    check('ck_control_command_dedup_response_revision', sql`${table.responseRevision} >= 1`),
    check('ck_control_command_dedup_created_at_ms', sql`${table.createdAtMs} >= 0`),
    check('ck_control_command_dedup_expires_at_ms', sql`${table.expiresAtMs} >= 0`)
  ]
)

export const controlResourceSlots = sqliteTable(
  'control_resource_slots',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    runId: text('run_id').notNull(),
    pool: text('pool').notNull(),
    state: text('state').notNull()
  },
  (table) => [
    uniqueIndex('idx_control_resource_slots_run_id').on(table.runId),
    uniqueIndex('idx_control_resource_slots_job_active')
      .on(table.jobId, table.state)
      .where(sql`${table.state} = 'active'`),
    index('idx_control_resource_slots_pool_state').on(table.pool, table.state)
  ]
)

export const controlJobFailures = sqliteTable('control_job_failures', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  runId: text('run_id'),
  code: text('code').notNull(),
  recoverability: text('recoverability').notNull(),
  reason: text('reason'),
  runKind: text('run_kind'),
  createdAtMs: integer('created_at_ms').notNull()
})

export const controlPlanRevisions = sqliteTable(
  'control_plan_revisions',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => controlJobs.id, { onDelete: 'cascade' }),
    planRevision: integer('plan_revision').notNull(),
    createdAtMs: integer('created_at_ms').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.planRevision] }),
    check('ck_control_plan_revisions_plan_revision', sql`${table.planRevision} >= 1`),
    check('ck_control_plan_revisions_created_at_ms', sql`${table.createdAtMs} >= 0`)
  ]
)

export const controlPlanMilestones = sqliteTable(
  'control_plan_milestones',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => controlJobs.id, { onDelete: 'cascade' }),
    planRevision: integer('plan_revision').notNull(),
    milestoneIndex: integer('milestone_index').notNull(),
    sortOrder: integer('sort_order').notNull(),
    title: text('title').notNull().default(''),
    description: text('description').notNull().default(''),
    successCriteria: text('success_criteria').notNull().default(''),
    confirmed: integer('confirmed')
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.planRevision, table.milestoneIndex] }),
    check('ck_control_plan_milestones_plan_revision', sql`${table.planRevision} >= 1`),
    check('ck_control_plan_milestones_sort_order', sql`${table.sortOrder} >= 0`),
    index('idx_control_plan_milestones_job_order').on(table.jobId, table.planRevision, table.sortOrder)
  ]
)

export const controlPlanSlices = sqliteTable(
  'control_plan_slices',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => controlJobs.id, { onDelete: 'cascade' }),
    planRevision: integer('plan_revision').notNull(),
    milestoneIndex: integer('milestone_index').notNull(),
    sliceIndex: integer('slice_index').notNull(),
    sortOrder: integer('sort_order').notNull(),
    title: text('title').notNull().default(''),
    description: text('description').notNull().default(''),
    successCriteria: text('success_criteria').notNull().default(''),
    dependsOnSliceRefsJson: text('depends_on_slice_refs_json'),
    confirmed: integer('confirmed')
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.planRevision, table.milestoneIndex, table.sliceIndex] }),
    check('ck_control_plan_slices_plan_revision', sql`${table.planRevision} >= 1`),
    check('ck_control_plan_slices_sort_order', sql`${table.sortOrder} >= 0`),
    index('idx_control_plan_slices_job_order').on(table.jobId, table.planRevision, table.sortOrder)
  ]
)

export const controlPlanTasks = sqliteTable(
  'control_plan_tasks',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => controlJobs.id, { onDelete: 'cascade' }),
    planRevision: integer('plan_revision').notNull(),
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
  (table) => [
    primaryKey({ columns: [table.jobId, table.planRevision, table.taskId] }),
    check('ck_control_plan_tasks_plan_revision', sql`${table.planRevision} >= 1`),
    check('ck_control_plan_tasks_sort_order', sql`${table.sortOrder} >= 0`),
    check('ck_control_plan_tasks_task_index', sql`${table.taskIndex} >= 0`),
    check('ck_control_plan_tasks_can_run_in_parallel', sql`${table.canRunInParallel} IN (0, 1)`),
    index('idx_control_plan_tasks_job_order').on(table.jobId, table.planRevision, table.sortOrder)
  ]
)

export const controlSchemaMeta = sqliteTable('control_schema_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  sourceMigration: integer('source_migration'),
  copyReportHash: text('copy_report_hash'),
  backupId: text('backup_id'),
  updatedAtMs: integer('updated_at_ms')
})
