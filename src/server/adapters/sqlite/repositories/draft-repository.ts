import type Database from 'better-sqlite3'
import type {
  DraftAttachmentRecord,
  DraftExecutionTreeRecord,
  DraftGenerationRunRecord,
  DraftRecord,
  DraftRepository,
  DraftSettingsRecord,
  DraftStatus
} from '../../../core/application/ports'

type SettingsRow = {
  user_id: string
  provider_code: 'cursorcli'
  model: string | null
  planner_prompt: string | null
  skills_manual: string | null
  revision: number
  updated_at_ms: number
}
type DraftRow = {
  id: string
  user_id: string
  workspace_id: string
  source_thread_id: string | null
  title: string
  objective: string
  requirements: string
  constraints_text: string
  acceptance_criteria: string
  status: DraftStatus
  revision: number
  active_tree_id: string | null
  submitted_handoff_id: string | null
  created_at_ms: number
  updated_at_ms: number
  submitted_at_ms: number | null
}
type AttachmentRow = {
  id: string
  draft_id: string
  display_name: string
  media_type: string
  size_bytes: number
  sha256: string
  storage_relative_path: string
  created_at_ms: number
}
type GenerationRow = {
  id: string
  draft_id: string
  state: DraftGenerationRunRecord['state']
  source_draft_revision: number
  settings_revision: number
  provider_code: 'cursorcli'
  model: string | null
  error_code: string | null
  error_message: string | null
  started_at_ms: number
  finished_at_ms: number | null
}
type TreeRow = {
  id: string
  draft_id: string
  generation_run_id: string
  tree_revision: number
  source_draft_revision: number
  schema_version: 1
  tree_json: string
  planner_prompt_snapshot: string
  skills_manual_snapshot: string
  model: string | null
  created_at_ms: number
}

const DRAFT_COLUMNS = `id, user_id, workspace_id, source_thread_id, title, objective,
  requirements, constraints_text, acceptance_criteria, status, revision, active_tree_id,
  submitted_handoff_id, created_at_ms, updated_at_ms, submitted_at_ms`
const TREE_COLUMNS = `id, draft_id, generation_run_id, tree_revision, source_draft_revision,
  schema_version, tree_json, planner_prompt_snapshot, skills_manual_snapshot, model, created_at_ms`

function settings(row: SettingsRow | undefined): DraftSettingsRecord | null {
  return row
    ? {
        userId: row.user_id,
        provider: row.provider_code,
        model: row.model,
        plannerPrompt: row.planner_prompt,
        skillsManual: row.skills_manual,
        revision: row.revision,
        updatedAtMs: row.updated_at_ms
      }
    : null
}
function draft(row: DraftRow | undefined): DraftRecord | null {
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        workspaceId: row.workspace_id,
        sourceThreadId: row.source_thread_id,
        title: row.title,
        objective: row.objective,
        requirements: row.requirements,
        constraints: row.constraints_text,
        acceptanceCriteria: row.acceptance_criteria,
        status: row.status,
        revision: row.revision,
        activeTreeId: row.active_tree_id,
        submittedHandoffId: row.submitted_handoff_id,
        createdAtMs: row.created_at_ms,
        updatedAtMs: row.updated_at_ms,
        submittedAtMs: row.submitted_at_ms
      }
    : null
}
function attachment(row: AttachmentRow): DraftAttachmentRecord {
  return {
    id: row.id,
    draftId: row.draft_id,
    displayName: row.display_name,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    storageRelativePath: row.storage_relative_path,
    createdAtMs: row.created_at_ms
  }
}
function generation(row: GenerationRow | undefined): DraftGenerationRunRecord | null {
  return row
    ? {
        id: row.id,
        draftId: row.draft_id,
        state: row.state,
        sourceDraftRevision: row.source_draft_revision,
        settingsRevision: row.settings_revision,
        provider: row.provider_code,
        model: row.model,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        startedAtMs: row.started_at_ms,
        finishedAtMs: row.finished_at_ms
      }
    : null
}
function tree(row: TreeRow | undefined): DraftExecutionTreeRecord | null {
  return row
    ? {
        id: row.id,
        draftId: row.draft_id,
        generationRunId: row.generation_run_id,
        treeRevision: row.tree_revision,
        sourceDraftRevision: row.source_draft_revision,
        schemaVersion: row.schema_version,
        treeJson: row.tree_json,
        plannerPromptSnapshot: row.planner_prompt_snapshot,
        skillsManualSnapshot: row.skills_manual_snapshot,
        model: row.model,
        createdAtMs: row.created_at_ms
      }
    : null
}

export class SqliteDraftRepository implements DraftRepository {
  constructor(private readonly database: Database.Database) {}

  getSettings(userId: string): DraftSettingsRecord | null {
    return settings(
      this.database
        .prepare(
          `SELECT user_id, provider_code, model, planner_prompt, skills_manual, revision,
                  updated_at_ms FROM draft_settings WHERE user_id = ?`
        )
        .get(userId) as SettingsRow | undefined
    )
  }
  putSettings(record: DraftSettingsRecord): void {
    this.database
      .prepare(
        `INSERT INTO draft_settings
           (user_id, provider_code, model, planner_prompt, skills_manual, revision, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET provider_code = excluded.provider_code,
           model = excluded.model, planner_prompt = excluded.planner_prompt,
           skills_manual = excluded.skills_manual, revision = excluded.revision,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        record.userId,
        record.provider,
        record.model,
        record.plannerPrompt,
        record.skillsManual,
        record.revision,
        record.updatedAtMs
      )
  }
  listDrafts(userId: string, workspaceId?: string): DraftRecord[] {
    const rows = workspaceId
      ? (this.database
          .prepare(
            `SELECT ${DRAFT_COLUMNS} FROM drafts WHERE user_id = ? AND workspace_id = ?
             ORDER BY updated_at_ms DESC, id`
          )
          .all(userId, workspaceId) as DraftRow[])
      : (this.database
          .prepare(
            `SELECT ${DRAFT_COLUMNS} FROM drafts WHERE user_id = ?
             ORDER BY updated_at_ms DESC, id`
          )
          .all(userId) as DraftRow[])
    return rows.map((row) => draft(row) as DraftRecord)
  }
  getDraft(userId: string, draftId: string): DraftRecord | null {
    return draft(
      this.database
        .prepare(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE user_id = ? AND id = ?`)
        .get(userId, draftId) as DraftRow | undefined
    )
  }
  insertDraft(record: DraftRecord): void {
    this.database
      .prepare(
        `INSERT INTO drafts
           (id, user_id, workspace_id, source_thread_id, title, objective, requirements,
            constraints_text, acceptance_criteria, status, revision, active_tree_id,
            submitted_handoff_id, created_at_ms, updated_at_ms, submitted_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.userId,
        record.workspaceId,
        record.sourceThreadId,
        record.title,
        record.objective,
        record.requirements,
        record.constraints,
        record.acceptanceCriteria,
        record.status,
        record.revision,
        record.activeTreeId,
        record.submittedHandoffId,
        record.createdAtMs,
        record.updatedAtMs,
        record.submittedAtMs
      )
  }
  updateDraftContent(record: DraftRecord, expectedRevision: number): boolean {
    return (
      this.database
        .prepare(
          `UPDATE drafts SET title = ?, objective = ?, requirements = ?,
             constraints_text = ?, acceptance_criteria = ?, status = ?, revision = ?,
             active_tree_id = ?, submitted_handoff_id = ?, submitted_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND user_id = ? AND revision = ? AND status <> 'submitted'`
        )
        .run(
          record.title,
          record.objective,
          record.requirements,
          record.constraints,
          record.acceptanceCriteria,
          record.status,
          record.revision,
          record.activeTreeId,
          record.submittedHandoffId,
          record.submittedAtMs,
          record.updatedAtMs,
          record.id,
          record.userId,
          expectedRevision
        ).changes === 1
    )
  }
  updateDraftState(input: {
    readonly userId: string
    readonly draftId: string
    readonly expectedRevision: number
    readonly expectedStatus?: DraftStatus | undefined
    readonly status: DraftStatus
    readonly activeTreeId: string | null
    readonly submittedHandoffId?: string | null | undefined
    readonly submittedAtMs?: number | null | undefined
    readonly updatedAtMs: number
  }): boolean {
    const statusClause = input.expectedStatus ? ' AND status = ?' : ''
    const values: unknown[] = [
      input.status,
      input.activeTreeId,
      input.submittedHandoffId ?? null,
      input.submittedAtMs ?? null,
      input.updatedAtMs,
      input.draftId,
      input.userId,
      input.expectedRevision
    ]
    if (input.expectedStatus) values.push(input.expectedStatus)
    return (
      this.database
        .prepare(
          `UPDATE drafts SET status = ?, active_tree_id = ?, submitted_handoff_id = ?,
             submitted_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND user_id = ? AND revision = ?${statusClause}`
        )
        .run(...values).changes === 1
    )
  }
  deleteDraft(userId: string, draftId: string): boolean {
    return (
      this.database.prepare('DELETE FROM drafts WHERE user_id = ? AND id = ?').run(userId, draftId)
        .changes === 1
    )
  }
  listAttachments(userId: string, draftId: string): DraftAttachmentRecord[] {
    return (
      this.database
        .prepare(
          `SELECT a.id, a.draft_id, a.display_name, a.media_type, a.size_bytes, a.sha256,
                  a.storage_relative_path, a.created_at_ms
           FROM draft_attachments a JOIN drafts d ON d.id = a.draft_id
           WHERE d.user_id = ? AND a.draft_id = ? ORDER BY a.created_at_ms, a.id`
        )
        .all(userId, draftId) as AttachmentRow[]
    ).map(attachment)
  }
  getAttachment(
    userId: string,
    draftId: string,
    attachmentId: string
  ): DraftAttachmentRecord | null {
    const row = this.database
      .prepare(
        `SELECT a.id, a.draft_id, a.display_name, a.media_type, a.size_bytes, a.sha256,
                a.storage_relative_path, a.created_at_ms
         FROM draft_attachments a JOIN drafts d ON d.id = a.draft_id
         WHERE d.user_id = ? AND a.draft_id = ? AND a.id = ?`
      )
      .get(userId, draftId, attachmentId) as AttachmentRow | undefined
    return row ? attachment(row) : null
  }
  insertAttachment(record: DraftAttachmentRecord): void {
    this.database
      .prepare(
        `INSERT INTO draft_attachments
           (id, draft_id, display_name, media_type, size_bytes, sha256,
            storage_relative_path, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.draftId,
        record.displayName,
        record.mediaType,
        record.sizeBytes,
        record.sha256,
        record.storageRelativePath,
        record.createdAtMs
      )
  }
  deleteAttachment(draftId: string, attachmentId: string): boolean {
    return (
      this.database
        .prepare('DELETE FROM draft_attachments WHERE draft_id = ? AND id = ?')
        .run(draftId, attachmentId).changes === 1
    )
  }
  getRunningGeneration(draftId: string): DraftGenerationRunRecord | null {
    return generation(
      this.database
        .prepare(
          `SELECT id, draft_id, state, source_draft_revision, settings_revision, provider_code,
                  model, error_code, error_message, started_at_ms, finished_at_ms
           FROM draft_generation_runs WHERE draft_id = ? AND state = 'running'`
        )
        .get(draftId) as GenerationRow | undefined
    )
  }
  insertGeneration(record: DraftGenerationRunRecord): void {
    this.database
      .prepare(
        `INSERT INTO draft_generation_runs
           (id, draft_id, state, source_draft_revision, settings_revision, provider_code,
            model, error_code, error_message, started_at_ms, finished_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.draftId,
        record.state,
        record.sourceDraftRevision,
        record.settingsRevision,
        record.provider,
        record.model,
        record.errorCode,
        record.errorMessage,
        record.startedAtMs,
        record.finishedAtMs
      )
  }
  finishGeneration(input: {
    readonly runId: string
    readonly state: 'completed' | 'failed' | 'cancelled'
    readonly errorCode: string | null
    readonly errorMessage: string | null
    readonly finishedAtMs: number
  }): boolean {
    return (
      this.database
        .prepare(
          `UPDATE draft_generation_runs SET state = ?, error_code = ?, error_message = ?,
             finished_at_ms = ? WHERE id = ? AND state = 'running'`
        )
        .run(input.state, input.errorCode, input.errorMessage, input.finishedAtMs, input.runId)
        .changes === 1
    )
  }
  nextTreeRevision(draftId: string): number {
    return (
      this.database
        .prepare(
          `SELECT COALESCE(MAX(tree_revision), 0) + 1 AS value
           FROM draft_execution_trees WHERE draft_id = ?`
        )
        .get(draftId) as { value: number }
    ).value
  }
  insertExecutionTree(record: DraftExecutionTreeRecord): void {
    this.database
      .prepare(
        `INSERT INTO draft_execution_trees
           (id, draft_id, generation_run_id, tree_revision, source_draft_revision,
            schema_version, tree_json, planner_prompt_snapshot, skills_manual_snapshot,
            model, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.draftId,
        record.generationRunId,
        record.treeRevision,
        record.sourceDraftRevision,
        record.schemaVersion,
        record.treeJson,
        record.plannerPromptSnapshot,
        record.skillsManualSnapshot,
        record.model,
        record.createdAtMs
      )
  }
  getExecutionTree(
    userId: string,
    draftId: string,
    treeId: string
  ): DraftExecutionTreeRecord | null {
    return tree(
      this.database
        .prepare(
          `SELECT ${TREE_COLUMNS} FROM draft_execution_trees
           WHERE id = ? AND draft_id = ?
             AND draft_id IN (SELECT id FROM drafts WHERE user_id = ?)`
        )
        .get(treeId, draftId, userId) as TreeRow | undefined
    )
  }
  getActiveExecutionTree(userId: string, draftId: string): DraftExecutionTreeRecord | null {
    const row = this.database
      .prepare(
        `SELECT t.id, t.draft_id, t.generation_run_id, t.tree_revision,
                t.source_draft_revision, t.schema_version, t.tree_json,
                t.planner_prompt_snapshot, t.skills_manual_snapshot, t.model, t.created_at_ms
         FROM draft_execution_trees t
         JOIN drafts d ON d.active_tree_id = t.id AND d.id = t.draft_id
         WHERE d.user_id = ? AND d.id = ?`
      )
      .get(userId, draftId) as TreeRow | undefined
    return tree(row)
  }
}
