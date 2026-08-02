import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export type ExecutionDataMigration = {
  version: number
  name: string
  up: (db: Database.Database) => void
}

const EXECUTION_THREAD_STATUSES = [
  'pending',
  'running',
  'pausing',
  'paused',
  'failed',
  'cancelled',
  'completed',
  'succeeded'
] as const

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)
  )
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column)
  )
}

function recordFailure(
  db: Database.Database,
  sourceKey: string,
  reason: string,
  payload: unknown
): void {
  if (!tableExists(db, 'migration_failures')) return
  db.prepare(
    `INSERT INTO migration_failures (id, migration_name, source_key, reason, payload_json, created_at)
     VALUES (?, '046_execution_data_migrate', ?, ?, ?, ?)`
  ).run(randomUUID(), sourceKey, reason, JSON.stringify(payload), Date.now())
}

function toMs(value: string | number | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.trim()) {
    const asNum = Number(value)
    if (Number.isFinite(asNum)) {
      return asNum < 1_000_000_000_000 ? asNum * 1000 : asNum
    }
  }
  return Date.now()
}

function mapLegacyStatus(status: string): string {
  switch (status) {
    case 'pending':
      return 'queued'
    case 'running':
      return 'running'
    case 'pausing':
      return 'pausing'
    case 'paused':
      return 'paused'
    case 'completed':
    case 'succeeded':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'queued'
  }
}

function defaultExecutionProfile(raw: string | null | undefined): string {
  if (raw && raw.trim()) return raw
  return JSON.stringify({
    plannerCoreCode: 'opencode',
    sliceVerifierCoreCode: 'opencode',
    milestoneVerifierCoreCode: 'opencode'
  })
}

/** Migrate published/execution thread_jobs into Execution-owned tables (02 §M9). */
export const migration046ExecutionDataMigrate: ExecutionDataMigration = {
  version: 46,
  name: 'execution_data_migrate',
  up(db) {
    if (!tableExists(db, 'jobs') || !tableExists(db, 'thread_jobs')) {
      return
    }

    const placeholders = EXECUTION_THREAD_STATUSES.map(() => '?').join(', ')
    const rows = db
      .prepare(
        `SELECT tj.id, tj.thread_id, tj.username, tj.draft_message_id, tj.title, tj.summary,
                tj.status, tj.workspace_path, tj.design_session_id, tj.execution_profile_json,
                tj.reference_manifest_json, tj.active_run_id, tj.suspension_kind, tj.recovery_reason,
                tj.last_error, tj.terminal_at, tj.created_at, tj.updated_at,
                th.project_id
         FROM thread_jobs tj
         JOIN threads th ON th.id = tj.thread_id
         WHERE tj.status IN (${placeholders})
           AND (tj.phase IS NULL OR tj.phase NOT IN ('plan_generating', 'plan_editing', 'draft_review'))`
      )
      .all(...EXECUTION_THREAD_STATUSES) as Array<{
      id: string
      thread_id: string
      username: string
      draft_message_id: string
      title: string
      summary: string
      status: string
      workspace_path: string
      design_session_id: string | null
      execution_profile_json: string | null
      reference_manifest_json: string | null
      active_run_id: string | null
      suspension_kind: string | null
      recovery_reason: string | null
      last_error: string | null
      terminal_at: number | null
      created_at: number
      updated_at: number
      project_id: string
    }>

    const existsJob = db.prepare(`SELECT 1 AS ok FROM jobs WHERE id = ?`)
    const insertJob = db.prepare(
      `INSERT INTO jobs (
        id, submission_id, submission_hash, idempotency_key, actor_id, project_id,
        source_draft_id, source_planning_session_id, title, summary,
        workspace_root, canonical_workspace_root, state, state_revision, control_intent,
        execution_generation, current_run_id, suspension_kind, recovery_reason, last_error_json,
        queued_at, started_at, terminal_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertSnapshot = db.prepare(
      `INSERT OR IGNORE INTO job_snapshots (
        job_id, draft_snapshot_json, execution_profile_json, execution_settings_snapshot_json,
        reference_manifest_json, execution_tree_json, settings_hash, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertQueue = db.prepare(
      `INSERT OR IGNORE INTO execution_queue_entries (
        job_id, generation, status, priority, sequence, enqueued_at
      ) VALUES (?, 0, 'queued', 0, ?, ?)`
    )

    const hasPlanMilestones = tableExists(db, 'job_plan_milestones')
    const hasPlanSlices = tableExists(db, 'job_plan_slices')
    const hasPlanTasks = tableExists(db, 'job_plan_tasks')

    for (const row of rows) {
      if (existsJob.get(row.id)) continue

      try {
        const now = Date.now()
        const createdAt = toMs(row.created_at)
        const updatedAt = toMs(row.updated_at)
        const state = mapLegacyStatus(row.status)
        const submissionId = `migrated_sub_${row.id}`
        const idempotencyKey = `migrated_idem_${row.id}`
        const sourceDraftId = row.draft_message_id
        const sourcePlanningSessionId = row.design_session_id ?? row.id
        const canonicalRoot = row.workspace_path
        const queuedAt = state === 'queued' ? updatedAt : null
        const startedAt = ['running', 'pausing', 'paused'].includes(state) ? updatedAt : null
        const terminalAt =
          row.terminal_at != null
            ? toMs(row.terminal_at)
            : ['succeeded', 'failed', 'cancelled'].includes(state)
              ? updatedAt
              : null
        const lastErrorJson = row.last_error ? JSON.stringify({ message: row.last_error }) : null

        insertJob.run(
          row.id,
          submissionId,
          submissionId,
          idempotencyKey,
          row.username,
          row.project_id,
          sourceDraftId,
          sourcePlanningSessionId,
          row.title,
          row.summary ?? '',
          row.workspace_path,
          canonicalRoot,
          state,
          0,
          row.active_run_id,
          row.suspension_kind,
          row.recovery_reason,
          lastErrorJson,
          queuedAt,
          startedAt,
          terminalAt,
          createdAt,
          updatedAt
        )

        const draftSnapshot = JSON.stringify({
          draftId: sourceDraftId,
          actorId: row.username,
          projectId: row.project_id,
          title: row.title,
          summary: row.summary ?? '',
          migratedFrom: 'thread_jobs',
          threadId: row.thread_id
        })
        const executionProfile = defaultExecutionProfile(row.execution_profile_json)
        const referenceManifest =
          row.reference_manifest_json ??
          JSON.stringify({
            snapshotId: `migrated_${row.id}`,
            draftId: sourceDraftId,
            draftLockRevision: 0,
            contentHash: row.id,
            references: [],
            createdAt: new Date(createdAt).toISOString()
          })
        const executionTree = JSON.stringify({
          treeId: `migrated_tree_${row.id}`,
          planningSessionId: sourcePlanningSessionId,
          revision: 0,
          milestones: []
        })

        insertSnapshot.run(
          row.id,
          draftSnapshot,
          executionProfile,
          JSON.stringify({ settingsHash: row.id, capturedAt: new Date(now).toISOString(), payload: {} }),
          referenceManifest,
          executionTree,
          row.id,
          row.id,
          createdAt
        )

        if (state === 'queued') {
          const sequence = (
            db
              .prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM execution_queue_entries`)
              .get() as { next: number }
          ).next
          insertQueue.run(row.id, sequence, updatedAt)
        }

        if (hasPlanMilestones && hasPlanSlices && hasPlanTasks) {
          migratePlanTables(db, row.id, createdAt, updatedAt)
        }
      } catch (error) {
        recordFailure(db, row.id, error instanceof Error ? error.message : String(error), {
          jobId: row.id,
          status: row.status
        })
      }
    }
  }
}

function migratePlanTables(
  db: Database.Database,
  jobId: string,
  createdAt: number,
  updatedAt: number
): void {
  const milestones = db
    .prepare(
      `SELECT milestone_index, sort_order, title, description, success_criteria, confirmed
       FROM job_plan_milestones WHERE job_id = ? ORDER BY sort_order`
    )
    .all(jobId) as Array<{
    milestone_index: number
    sort_order: number
    title: string
    description: string
    success_criteria: string
    confirmed: number | null
  }>

  if (milestones.length === 0) return

  const insertMilestone = db.prepare(
    `INSERT OR IGNORE INTO job_milestones (
      id, job_id, generation, source_milestone_id, sort_order, title, description, success_criteria, state
    ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, 'pending')`
  )
  const insertSlice = db.prepare(
    `INSERT OR IGNORE INTO job_slices (
      id, job_id, generation, milestone_id, source_slice_id, sort_order,
      title, description, success_criteria, state, verification_state
    ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, 'pending', 'pending')`
  )
  const insertWork = db.prepare(
    `INSERT OR IGNORE INTO job_work_items (
      id, job_id, generation, source_task_id, parent_work_id, milestone_id, slice_id, kind,
      sort_order, title, description, context_markdown, ability_code, provider_code,
      success_criteria, can_run_in_parallel, state, state_revision, created_at, updated_at
    ) VALUES (?, ?, 0, ?, NULL, ?, ?, 'task', ?, ?, ?, ?, ?, ?, ?, 0, 'pending', 0, ?, ?)`
  )

  const milestoneIdByIndex = new Map<number, string>()

  for (const milestone of milestones) {
    const milestoneId = `jm_migrated_${jobId}_${milestone.milestone_index}`
    milestoneIdByIndex.set(milestone.milestone_index, milestoneId)
    insertMilestone.run(
      milestoneId,
      jobId,
      `milestone_${milestone.milestone_index}`,
      milestone.sort_order,
      milestone.title,
      milestone.description ?? '',
      milestone.success_criteria ?? ''
    )
  }

  const slices = db
    .prepare(
      `SELECT milestone_index, slice_index, sort_order, title, description, success_criteria
       FROM job_plan_slices WHERE job_id = ? ORDER BY sort_order`
    )
    .all(jobId) as Array<{
    milestone_index: number
    slice_index: number
    sort_order: number
    title: string
    description: string
    success_criteria: string
  }>

  const sliceIdByKey = new Map<string, string>()

  for (const slice of slices) {
    const milestoneId = milestoneIdByIndex.get(slice.milestone_index)
    if (!milestoneId) continue
    const sliceId = `js_migrated_${jobId}_${slice.milestone_index}_${slice.slice_index}`
    sliceIdByKey.set(`${slice.milestone_index}:${slice.slice_index}`, sliceId)
    insertSlice.run(
      sliceId,
      jobId,
      milestoneId,
      `slice_${slice.slice_index}`,
      slice.sort_order,
      slice.title,
      slice.description ?? '',
      slice.success_criteria ?? ''
    )
  }

  const tasks = db
    .prepare(
      `SELECT task_id, milestone_index, slice_index, sort_order, title, description, task_kind,
              ability_code, context_markdown, core_code, success_criteria, can_run_in_parallel
       FROM job_plan_tasks WHERE job_id = ? ORDER BY sort_order`
    )
    .all(jobId) as Array<{
    task_id: string
    milestone_index: number
    slice_index: number
    sort_order: number
    title: string
    description: string
    task_kind: string
    ability_code: string
    context_markdown: string
    core_code: string | null
    success_criteria: string
    can_run_in_parallel: number
  }>

  for (const task of tasks) {
    const milestoneId = milestoneIdByIndex.get(task.milestone_index)
    const sliceId = sliceIdByKey.get(`${task.milestone_index}:${task.slice_index}`)
    if (!milestoneId || !sliceId) continue
    const workId = `work_migrated_${task.task_id}`
    const provider = (task.core_code ?? 'opencode').toLowerCase()
    insertWork.run(
      workId,
      jobId,
      task.task_id,
      milestoneId,
      sliceId,
      task.sort_order,
      task.title,
      task.description ?? '',
      task.context_markdown ?? '',
      task.ability_code ?? 'general',
      provider,
      task.success_criteria ?? '',
      task.can_run_in_parallel ? 1 : 0,
      createdAt,
      updatedAt
    )
  }
}

export const executionDataMigrations: ExecutionDataMigration[] = [migration046ExecutionDataMigrate]
