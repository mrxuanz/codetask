import type Database from 'better-sqlite3'
import type {
  JobAttachmentRecord,
  JobEventRecord,
  JobRecord,
  JobRepository,
  JobSettingsRecord,
  JobStateRecord,
  JobWorkItemRecord,
  JobWorkspaceLeaseRecord
} from '../../../core/application/ports'

type Row = Record<string, unknown>

const JOB_COLUMNS = `id, user_id, source_handoff_id, workspace_id, title, summary, state,
  revision, queue_order, active_item_id, source_snapshot_json, execution_tree_json,
  last_error_code, last_error_message, created_at_ms, updated_at_ms, started_at_ms,
  finished_at_ms, deleted_at_ms`
const ITEM_COLUMNS = `id, job_id, sequence, kind, tree_task_id, scope_id, parent_item_id,
  title, objective, files_json, acceptance_criteria_json, attachment_ids_json, state,
  attempt, repair_generation, provider_code, model, prompt_snapshot, skills_manual_snapshot,
  result_json, error_code, error_message, started_at_ms, finished_at_ms, created_at_ms,
  updated_at_ms`

function toJob(row: Row | undefined): JobRecord | null {
  if (!row) return null
  return {
    id: row.id as string,
    userId: row.user_id as string,
    sourceHandoffId: row.source_handoff_id as string,
    workspaceId: row.workspace_id as string,
    title: row.title as string,
    summary: row.summary as string,
    state: row.state as JobStateRecord,
    revision: row.revision as number,
    queueOrder: row.queue_order as number,
    activeItemId: (row.active_item_id as string | null) ?? null,
    sourceSnapshotJson: row.source_snapshot_json as string,
    executionTreeJson: row.execution_tree_json as string,
    lastErrorCode: (row.last_error_code as string | null) ?? null,
    lastErrorMessage: (row.last_error_message as string | null) ?? null,
    createdAtMs: row.created_at_ms as number,
    updatedAtMs: row.updated_at_ms as number,
    startedAtMs: (row.started_at_ms as number | null) ?? null,
    finishedAtMs: (row.finished_at_ms as number | null) ?? null,
    deletedAtMs: (row.deleted_at_ms as number | null) ?? null
  }
}

function toItem(row: Row | undefined): JobWorkItemRecord | null {
  if (!row) return null
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    sequence: row.sequence as number,
    kind: row.kind as JobWorkItemRecord['kind'],
    treeTaskId: (row.tree_task_id as string | null) ?? null,
    scopeId: row.scope_id as string,
    parentItemId: (row.parent_item_id as string | null) ?? null,
    title: row.title as string,
    objective: row.objective as string,
    filesJson: row.files_json as string,
    acceptanceCriteriaJson: row.acceptance_criteria_json as string,
    attachmentIdsJson: row.attachment_ids_json as string,
    state: row.state as JobWorkItemRecord['state'],
    attempt: row.attempt as number,
    repairGeneration: row.repair_generation as number,
    providerCode: row.provider_code as JobWorkItemRecord['providerCode'],
    promptSnapshot: row.prompt_snapshot as string,
    skillsManualSnapshot: row.skills_manual_snapshot as string,
    resultJson: (row.result_json as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    startedAtMs: (row.started_at_ms as number | null) ?? null,
    finishedAtMs: (row.finished_at_ms as number | null) ?? null,
    createdAtMs: row.created_at_ms as number,
    updatedAtMs: row.updated_at_ms as number
  }
}

function toSettings(row: Row | undefined): JobSettingsRecord | null {
  if (!row) return null
  return {
    userId: row.user_id as string,
    maxConcurrentJobs: row.max_concurrent_jobs as 1 | 2,
    workProvider: row.work_provider as JobSettingsRecord['workProvider'],
    workPrompt: (row.work_prompt as string | null) ?? null,
    workSkillsManual: (row.work_skills_manual as string | null) ?? null,
    workValidationEnabled: row.work_validation_enabled === 1,
    workValidationProvider:
      row.work_validation_provider as JobSettingsRecord['workValidationProvider'],
    workValidationPrompt: (row.work_validation_prompt as string | null) ?? null,
    workValidationSkillsManual: (row.work_validation_skills_manual as string | null) ?? null,
    sliceValidationEnabled: row.slice_validation_enabled === 1,
    sliceValidationProvider:
      row.slice_validation_provider as JobSettingsRecord['sliceValidationProvider'],
    sliceValidationPrompt: (row.slice_validation_prompt as string | null) ?? null,
    sliceValidationSkillsManual: (row.slice_validation_skills_manual as string | null) ?? null,
    milestoneValidationEnabled: row.milestone_validation_enabled === 1,
    milestoneValidationProvider:
      row.milestone_validation_provider as JobSettingsRecord['milestoneValidationProvider'],
    milestoneValidationPrompt: (row.milestone_validation_prompt as string | null) ?? null,
    milestoneValidationSkillsManual:
      (row.milestone_validation_skills_manual as string | null) ?? null,
    revision: row.revision as number,
    updatedAtMs: row.updated_at_ms as number
  }
}

export class SqliteJobRepository implements JobRepository {
  constructor(private readonly database: Database.Database) {}

  getSettings(userId: string): JobSettingsRecord | null {
    return toSettings(
      this.database.prepare(`SELECT * FROM job_settings WHERE user_id = ?`).get(userId) as
        | Row
        | undefined
    )
  }

  putSettings(record: JobSettingsRecord, expectedRevision: number | null): boolean {
    const values = [
      record.maxConcurrentJobs,
      record.workProvider,
      null,
      record.workPrompt,
      record.workSkillsManual,
      record.workValidationEnabled ? 1 : 0,
      record.workValidationProvider,
      null,
      record.workValidationPrompt,
      record.workValidationSkillsManual,
      record.sliceValidationEnabled ? 1 : 0,
      record.sliceValidationProvider,
      null,
      record.sliceValidationPrompt,
      record.sliceValidationSkillsManual,
      record.milestoneValidationEnabled ? 1 : 0,
      record.milestoneValidationProvider,
      null,
      record.milestoneValidationPrompt,
      record.milestoneValidationSkillsManual,
      record.revision,
      record.updatedAtMs
    ]
    if (expectedRevision === null) {
      return (
        this.database
          .prepare(
            `INSERT OR IGNORE INTO job_settings (
               user_id, max_concurrent_jobs, work_provider, work_model, work_prompt,
               work_skills_manual, work_validation_enabled, work_validation_provider,
               work_validation_model, work_validation_prompt, work_validation_skills_manual,
               slice_validation_enabled, slice_validation_provider, slice_validation_model,
               slice_validation_prompt, slice_validation_skills_manual,
               milestone_validation_enabled, milestone_validation_provider,
               milestone_validation_model, milestone_validation_prompt,
               milestone_validation_skills_manual, revision, updated_at_ms
             ) VALUES (${Array(23).fill('?').join(', ')})`
          )
          .run(record.userId, ...values).changes === 1
      )
    }
    return (
      this.database
        .prepare(
          `UPDATE job_settings SET
             max_concurrent_jobs = ?, work_provider = ?, work_model = ?, work_prompt = ?,
             work_skills_manual = ?, work_validation_enabled = ?,
             work_validation_provider = ?, work_validation_model = ?,
             work_validation_prompt = ?, work_validation_skills_manual = ?,
             slice_validation_enabled = ?, slice_validation_provider = ?,
             slice_validation_model = ?, slice_validation_prompt = ?,
             slice_validation_skills_manual = ?, milestone_validation_enabled = ?,
             milestone_validation_provider = ?, milestone_validation_model = ?,
             milestone_validation_prompt = ?, milestone_validation_skills_manual = ?,
             revision = ?, updated_at_ms = ?
           WHERE user_id = ? AND revision = ?`
        )
        .run(...values, record.userId, expectedRevision).changes === 1
    )
  }

  nextQueueOrder(): number {
    return (
      this.database
        .prepare(`SELECT COALESCE(MAX(queue_order), 0) + 1 AS value FROM jobs`)
        .get() as {
        value: number
      }
    ).value
  }

  insertJob(record: JobRecord): void {
    this.database
      .prepare(
        `INSERT INTO jobs (${JOB_COLUMNS})
         VALUES (${Array(19).fill('?').join(', ')})`
      )
      .run(
        record.id,
        record.userId,
        record.sourceHandoffId,
        record.workspaceId,
        record.title,
        record.summary,
        record.state,
        record.revision,
        record.queueOrder,
        record.activeItemId,
        record.sourceSnapshotJson,
        record.executionTreeJson,
        record.lastErrorCode,
        record.lastErrorMessage,
        record.createdAtMs,
        record.updatedAtMs,
        record.startedAtMs,
        record.finishedAtMs,
        record.deletedAtMs
      )
  }

  getJob(userId: string, jobId: string): JobRecord | null {
    return toJob(
      this.database
        .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ? AND user_id = ?`)
        .get(jobId, userId) as Row | undefined
    )
  }

  getJobByHandoff(handoffId: string): JobRecord | null {
    return toJob(
      this.database
        .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE source_handoff_id = ?`)
        .get(handoffId) as Row | undefined
    )
  }

  listJobs(userId: string, includeDeleted = false): JobRecord[] {
    const deletedFilter = includeDeleted ? '' : `AND state <> 'deleted'`
    return (
      this.database
        .prepare(
          `SELECT ${JOB_COLUMNS} FROM jobs
           WHERE user_id = ? ${deletedFilter}
           ORDER BY created_at_ms DESC, id DESC`
        )
        .all(userId) as Row[]
    ).map((row) => toJob(row)!)
  }

  listRunnableJobs(limit: number): JobRecord[] {
    return (
      this.database
        .prepare(
          `SELECT ${JOB_COLUMNS} FROM jobs
           WHERE state = 'queued'
           ORDER BY queue_order, created_at_ms, id LIMIT ?`
        )
        .all(limit) as Row[]
    ).map((row) => toJob(row)!)
  }

  updateJob(input: {
    readonly jobId: string
    readonly expectedRevision: number
    readonly expectedStates: readonly JobStateRecord[]
    readonly state: JobStateRecord
    readonly activeItemId: string | null
    readonly queueOrder?: number
    readonly lastErrorCode?: string | null
    readonly lastErrorMessage?: string | null
    readonly startedAtMs?: number | null
    readonly finishedAtMs?: number | null
    readonly deletedAtMs?: number | null
    readonly updatedAtMs: number
  }): boolean {
    if (input.expectedStates.length === 0) return false
    const current = toJob(
      this.database.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(input.jobId) as
        | Row
        | undefined
    )
    if (!current || current.revision !== input.expectedRevision) return false
    const states = input.expectedStates.map(() => '?').join(', ')
    return (
      this.database
        .prepare(
          `UPDATE jobs SET state = ?, revision = revision + 1, active_item_id = ?,
             queue_order = ?, last_error_code = ?, last_error_message = ?,
             started_at_ms = ?, finished_at_ms = ?, deleted_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND revision = ? AND state IN (${states})`
        )
        .run(
          input.state,
          input.activeItemId,
          input.queueOrder ?? current.queueOrder,
          input.lastErrorCode === undefined ? current.lastErrorCode : input.lastErrorCode,
          input.lastErrorMessage === undefined ? current.lastErrorMessage : input.lastErrorMessage,
          input.startedAtMs === undefined ? current.startedAtMs : input.startedAtMs,
          input.finishedAtMs === undefined ? current.finishedAtMs : input.finishedAtMs,
          input.deletedAtMs === undefined ? current.deletedAtMs : input.deletedAtMs,
          input.updatedAtMs,
          input.jobId,
          input.expectedRevision,
          ...input.expectedStates
        ).changes === 1
    )
  }

  insertWorkItems(records: readonly JobWorkItemRecord[]): void {
    for (const record of records) this.insertWorkItem(record)
  }

  private insertWorkItem(record: JobWorkItemRecord): void {
    this.database
      .prepare(
        `INSERT INTO job_work_items (${ITEM_COLUMNS})
         VALUES (${Array(26).fill('?').join(', ')})`
      )
      .run(
        record.id,
        record.jobId,
        record.sequence,
        record.kind,
        record.treeTaskId,
        record.scopeId,
        record.parentItemId,
        record.title,
        record.objective,
        record.filesJson,
        record.acceptanceCriteriaJson,
        record.attachmentIdsJson,
        record.state,
        record.attempt,
        record.repairGeneration,
        record.providerCode,
        null,
        record.promptSnapshot,
        record.skillsManualSnapshot,
        record.resultJson,
        record.errorCode,
        record.errorMessage,
        record.startedAtMs,
        record.finishedAtMs,
        record.createdAtMs,
        record.updatedAtMs
      )
  }

  listWorkItems(jobId: string): JobWorkItemRecord[] {
    return (
      this.database
        .prepare(
          `SELECT ${ITEM_COLUMNS} FROM job_work_items WHERE job_id = ? ORDER BY sequence, id`
        )
        .all(jobId) as Row[]
    ).map((row) => toItem(row)!)
  }

  getWorkItem(jobId: string, itemId: string): JobWorkItemRecord | null {
    return toItem(
      this.database
        .prepare(`SELECT ${ITEM_COLUMNS} FROM job_work_items WHERE job_id = ? AND id = ?`)
        .get(jobId, itemId) as Row | undefined
    )
  }

  getNextQueuedWorkItem(jobId: string): JobWorkItemRecord | null {
    return toItem(
      this.database
        .prepare(
          `SELECT ${ITEM_COLUMNS} FROM job_work_items
           WHERE job_id = ? AND state = 'queued' ORDER BY sequence, id LIMIT 1`
        )
        .get(jobId) as Row | undefined
    )
  }

  updateWorkItem(input: {
    readonly jobId: string
    readonly itemId: string
    readonly expectedStates: readonly JobWorkItemRecord['state'][]
    readonly state: JobWorkItemRecord['state']
    readonly attempt?: number
    readonly repairGeneration?: number
    readonly resultJson?: string | null
    readonly errorCode?: string | null
    readonly errorMessage?: string | null
    readonly startedAtMs?: number | null
    readonly finishedAtMs?: number | null
    readonly updatedAtMs: number
  }): boolean {
    if (input.expectedStates.length === 0) return false
    const current = this.getWorkItem(input.jobId, input.itemId)
    if (!current) return false
    const states = input.expectedStates.map(() => '?').join(', ')
    return (
      this.database
        .prepare(
          `UPDATE job_work_items SET state = ?, attempt = ?, repair_generation = ?,
             result_json = ?, error_code = ?, error_message = ?, started_at_ms = ?,
             finished_at_ms = ?, updated_at_ms = ?
           WHERE job_id = ? AND id = ? AND state IN (${states})`
        )
        .run(
          input.state,
          input.attempt ?? current.attempt,
          input.repairGeneration ?? current.repairGeneration,
          input.resultJson === undefined ? current.resultJson : input.resultJson,
          input.errorCode === undefined ? current.errorCode : input.errorCode,
          input.errorMessage === undefined ? current.errorMessage : input.errorMessage,
          input.startedAtMs === undefined ? current.startedAtMs : input.startedAtMs,
          input.finishedAtMs === undefined ? current.finishedAtMs : input.finishedAtMs,
          input.updatedAtMs,
          input.jobId,
          input.itemId,
          ...input.expectedStates
        ).changes === 1
    )
  }

  insertWorkItemsBefore(
    jobId: string,
    beforeSequence: number,
    records: readonly JobWorkItemRecord[]
  ): void {
    if (records.length === 0) return
    const offset = 1_000_000
    this.database
      .prepare(
        `UPDATE job_work_items SET sequence = sequence + ? WHERE job_id = ? AND sequence >= ?`
      )
      .run(offset, jobId, beforeSequence)
    this.database
      .prepare(
        `UPDATE job_work_items SET sequence = sequence - ? + ?
         WHERE job_id = ? AND sequence >= ?`
      )
      .run(offset, records.length, jobId, beforeSequence + offset)
    records.forEach((record, index) =>
      this.insertWorkItem({ ...record, sequence: beforeSequence + index })
    )
  }

  resetInterrupted(nowMs: number): number {
    this.database
      .prepare(
        `UPDATE job_work_items
         SET state = 'queued', error_code = 'job.interrupted',
             error_message = 'Application restarted while this item was running.',
             started_at_ms = NULL, finished_at_ms = NULL, updated_at_ms = ?
         WHERE state = 'running'`
      )
      .run(nowMs)
    const changed = this.database
      .prepare(
        `UPDATE jobs
         SET state = 'paused', revision = revision + 1, active_item_id = NULL,
             last_error_code = 'job.interrupted',
             last_error_message = 'Application restarted; continue resumes the same item.',
             updated_at_ms = ?
         WHERE state IN ('running', 'pause_requested')`
      )
      .run(nowMs).changes
    this.releaseAllLeases()
    return changed
  }

  insertAttachment(record: JobAttachmentRecord): void {
    this.database
      .prepare(
        `INSERT INTO job_attachments (
           id, job_id, source_attachment_id, display_name, media_type, size_bytes,
           sha256, storage_relative_path, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.jobId,
        record.sourceAttachmentId,
        record.displayName,
        record.mediaType,
        record.sizeBytes,
        record.sha256,
        record.storageRelativePath,
        record.createdAtMs
      )
  }

  listAttachments(jobId: string): JobAttachmentRecord[] {
    return (
      this.database
        .prepare(
          `SELECT id, job_id, source_attachment_id, display_name, media_type, size_bytes,
                  sha256, storage_relative_path, created_at_ms
           FROM job_attachments WHERE job_id = ? ORDER BY created_at_ms, id`
        )
        .all(jobId) as Row[]
    ).map((row) => ({
      id: row.id as string,
      jobId: row.job_id as string,
      sourceAttachmentId: row.source_attachment_id as string,
      displayName: row.display_name as string,
      mediaType: row.media_type as string,
      sizeBytes: row.size_bytes as number,
      sha256: row.sha256 as string,
      storageRelativePath: row.storage_relative_path as string,
      createdAtMs: row.created_at_ms as number
    }))
  }

  tryAcquireLease(record: JobWorkspaceLeaseRecord): boolean {
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO job_workspace_leases
             (workspace_id, job_id, lease_id, acquired_at_ms, heartbeat_at_ms)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          record.workspaceId,
          record.jobId,
          record.leaseId,
          record.acquiredAtMs,
          record.heartbeatAtMs
        ).changes === 1
    )
  }

  getLeaseByWorkspace(workspaceId: string): JobWorkspaceLeaseRecord | null {
    return this.toLease(
      this.database
        .prepare(`SELECT * FROM job_workspace_leases WHERE workspace_id = ?`)
        .get(workspaceId) as Row | undefined
    )
  }

  getLeaseByJob(jobId: string): JobWorkspaceLeaseRecord | null {
    return this.toLease(
      this.database.prepare(`SELECT * FROM job_workspace_leases WHERE job_id = ?`).get(jobId) as
        | Row
        | undefined
    )
  }

  private toLease(row: Row | undefined): JobWorkspaceLeaseRecord | null {
    return row
      ? {
          workspaceId: row.workspace_id as string,
          jobId: row.job_id as string,
          leaseId: row.lease_id as string,
          acquiredAtMs: row.acquired_at_ms as number,
          heartbeatAtMs: row.heartbeat_at_ms as number
        }
      : null
  }

  heartbeatLease(jobId: string, heartbeatAtMs: number): boolean {
    return (
      this.database
        .prepare(`UPDATE job_workspace_leases SET heartbeat_at_ms = ? WHERE job_id = ?`)
        .run(heartbeatAtMs, jobId).changes === 1
    )
  }

  releaseLease(jobId: string): boolean {
    return (
      this.database.prepare(`DELETE FROM job_workspace_leases WHERE job_id = ?`).run(jobId)
        .changes === 1
    )
  }

  releaseAllLeases(): number {
    return this.database.prepare(`DELETE FROM job_workspace_leases`).run().changes
  }

  appendEvent(record: Omit<JobEventRecord, 'id'>): number {
    return Number(
      this.database
        .prepare(
          `INSERT INTO job_events (user_id, job_id, event_type, payload_json, created_at_ms)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(record.userId, record.jobId, record.eventType, record.payloadJson, record.createdAtMs)
        .lastInsertRowid
    )
  }

  listEvents(userId: string, afterId: number, limit: number): JobEventRecord[] {
    return (
      this.database
        .prepare(
          `SELECT id, user_id, job_id, event_type, payload_json, created_at_ms
           FROM job_events WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?`
        )
        .all(userId, afterId, limit) as Row[]
    ).map((row) => ({
      id: row.id as number,
      userId: row.user_id as string,
      jobId: (row.job_id as string | null) ?? null,
      eventType: row.event_type as string,
      payloadJson: row.payload_json as string,
      createdAtMs: row.created_at_ms as number
    }))
  }
}
