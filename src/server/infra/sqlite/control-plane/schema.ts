import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

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
    index('idx_control_jobs_project_state').on(table.projectId, table.state, table.updatedAtMs),
    index('idx_control_jobs_scheduler').on(
      table.state,
      table.controlIntent,
      table.activeRunId,
      table.createdAtMs
    ),
    uniqueIndex('idx_control_jobs_thread_draft').on(table.threadId, table.draftMessageId)
  ]
)

export const controlJobRuns = sqliteTable(
  'control_job_runs',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    attemptNo: integer('attempt_no').notNull(),
    fenceToken: text('fence_token').notNull(),
    executionGeneration: integer('execution_generation').notNull(),
    leaseOwnerBootId: text('lease_owner_boot_id'),
    currentRuntimeInstanceId: text('current_runtime_instance_id'),
    pendingAttemptId: text('pending_attempt_id'),
    lifecycleOperationId: text('lifecycle_operation_id'),
    heartbeatAtMs: integer('heartbeat_at_ms'),
    stopReason: text('stop_reason'),
    startedAtMs: integer('started_at_ms').notNull(),
    endedAtMs: integer('ended_at_ms')
  },
  (table) => [
    uniqueIndex('idx_control_job_runs_fence').on(table.jobId, table.fenceToken)
  ]
)

export const controlRuntimeInstances = sqliteTable(
  'control_runtime_instances',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    taskAttemptId: text('task_attempt_id'),
    state: text('state').notNull(),
    ownerBootId: text('owner_boot_id').notNull(),
    provider: text('provider'),
    protocolState: text('protocol_state'),
    pidOrHandleRef: text('pid_or_handle_ref'),
    startedAtMs: integer('started_at_ms').notNull(),
    closedAtMs: integer('closed_at_ms'),
    exitKind: text('exit_kind'),
    exitCode: integer('exit_code'),
    signal: text('signal')
  },
  (table) => [
    uniqueIndex('idx_control_runtime_instances_run_active')
      .on(table.runId)
      .where(sql`${table.state} != 'closed'`)
  ]
)

export const controlJobTasks = sqliteTable(
  'control_job_tasks',
  {
    jobId: text('job_id').notNull(),
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
    uniqueIndex('idx_control_job_tasks_pk').on(table.jobId, table.executionGeneration, table.taskId)
  ]
)

export const controlTaskAttempts = sqliteTable(
  'control_task_attempts',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    executionGeneration: integer('execution_generation').notNull(),
    taskId: text('task_id').notNull(),
    attemptNo: integer('attempt_no').notNull(),
    runId: text('run_id').notNull(),
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
    )
  ]
)

export const controlVerifications = sqliteTable(
  'control_verifications',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    executionGeneration: integer('execution_generation').notNull(),
    planRevision: integer('plan_revision').notNull(),
    scopeType: text('scope_type').notNull(),
    scopeId: text('scope_id').notNull(),
    attemptNo: integer('attempt_no').notNull(),
    state: text('state').notNull(),
    runId: text('run_id'),
    fenceToken: text('fence_token'),
    verdictBlobHash: text('verdict_blob_hash'),
    resultHash: text('result_hash'),
    failureId: text('failure_id'),
    startedAtMs: integer('started_at_ms').notNull(),
    endedAtMs: integer('ended_at_ms')
  },
  (table) => [
    uniqueIndex('idx_control_verifications_unique').on(
      table.jobId,
      table.executionGeneration,
      table.planRevision,
      table.scopeType,
      table.scopeId,
      table.attemptNo
    )
  ]
)

export const controlPlanRevisions = sqliteTable('control_plan_revisions', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  planRevision: integer('plan_revision').notNull(),
  status: text('status').notNull(),
  contentHash: text('content_hash').notNull(),
  createdAtMs: integer('created_at_ms').notNull()
})

export const controlPlanMilestones = sqliteTable('control_plan_milestones', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  planRevision: integer('plan_revision').notNull(),
  milestoneId: text('milestone_id').notNull(),
  title: text('title').notNull(),
  sortOrder: integer('sort_order').notNull(),
  createdAtMs: integer('created_at_ms').notNull()
})

export const controlPlanSlices = sqliteTable('control_plan_slices', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  planRevision: integer('plan_revision').notNull(),
  milestoneId: text('milestone_id').notNull(),
  sliceId: text('slice_id').notNull(),
  title: text('title').notNull(),
  sortOrder: integer('sort_order').notNull(),
  createdAtMs: integer('created_at_ms').notNull()
})

export const controlPlanTasks = sqliteTable('control_plan_tasks', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  planRevision: integer('plan_revision').notNull(),
  taskId: text('task_id').notNull(),
  abilityCode: text('ability_code'),
  coreCode: text('core_code'),
  createdAtMs: integer('created_at_ms').notNull()
})

export const controlResourceSlots = sqliteTable(
  'control_resource_slots',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    runId: text('run_id').notNull(),
    pool: text('pool').notNull(),
    state: text('state').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    releasedAtMs: integer('released_at_ms')
  },
  (table) => [
    uniqueIndex('idx_control_resource_slots_run').on(table.runId),
    uniqueIndex('idx_control_resource_slots_active')
      .on(table.jobId)
      .where(sql`${table.state} != 'released'`)
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
    index('idx_control_outbox_dispatch').on(table.dispatchedAtMs, table.eventId),
    index('idx_control_outbox_topic').on(table.topic, table.eventId)
  ]
)

export const controlCommandDedup = sqliteTable('control_command_dedup', {
  actorUsername: text('actor_username').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  commandType: text('command_type').notNull(),
  requestHash: text('request_hash').notNull(),
  responseJson: text('response_json').notNull(),
  responseRevision: integer('response_revision').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
  expiresAtMs: integer('expires_at_ms').notNull()
})

export const controlJobFailures = sqliteTable('control_job_failures', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  code: text('code').notNull(),
  recoverability: text('recoverability').notNull(),
  reason: text('reason'),
  runKind: text('run_kind'),
  createdAtMs: integer('created_at_ms').notNull()
})

export const controlSchemaMeta = sqliteTable('control_schema_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull()
})

export const controlEvidenceBlobs = sqliteTable('control_evidence_blobs', {
  hash: text('hash').primaryKey(),
  contentJson: text('content_json').notNull(),
  bytes: integer('bytes').notNull(),
  createdAtMs: integer('created_at_ms').notNull()
})

export const controlPlaneSchema = {
  controlJobs,
  controlJobRuns,
  controlRuntimeInstances,
  controlJobTasks,
  controlTaskAttempts,
  controlVerifications,
  controlPlanRevisions,
  controlPlanMilestones,
  controlPlanSlices,
  controlPlanTasks,
  controlResourceSlots,
  controlOutboxEvents,
  controlCommandDedup,
  controlJobFailures,
  controlSchemaMeta,
  controlEvidenceBlobs
}
