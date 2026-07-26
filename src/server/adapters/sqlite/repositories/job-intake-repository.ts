import type Database from 'better-sqlite3'
import type {
  JobIntakeAttachmentRecord,
  JobIntakeHandoffRecord,
  JobIntakeRepository
} from '../../../core/application/ports'

type HandoffRow = {
  id: string
  source_draft_id: string
  source_user_id: string
  source_workspace_id: string
  source_tree_id: string
  source_draft_revision: number
  source_tree_revision: number
  state: JobIntakeHandoffRecord['state']
  draft_snapshot_json: string
  execution_tree_json: string
  created_at_ms: number
  accepted_at_ms: number | null
  rejected_at_ms: number | null
  rejection_code: string | null
}
type AttachmentRow = {
  id: string
  handoff_id: string
  source_attachment_id: string
  display_name: string
  media_type: string
  size_bytes: number
  sha256: string
  storage_relative_path: string
  created_at_ms: number
}

function handoff(row: HandoffRow | undefined): JobIntakeHandoffRecord | null {
  return row
    ? {
        id: row.id,
        sourceDraftId: row.source_draft_id,
        sourceUserId: row.source_user_id,
        sourceWorkspaceId: row.source_workspace_id,
        sourceTreeId: row.source_tree_id,
        sourceDraftRevision: row.source_draft_revision,
        sourceTreeRevision: row.source_tree_revision,
        state: row.state,
        draftSnapshotJson: row.draft_snapshot_json,
        executionTreeJson: row.execution_tree_json,
        createdAtMs: row.created_at_ms,
        acceptedAtMs: row.accepted_at_ms,
        rejectedAtMs: row.rejected_at_ms,
        rejectionCode: row.rejection_code
      }
    : null
}
function attachment(row: AttachmentRow): JobIntakeAttachmentRecord {
  return {
    id: row.id,
    handoffId: row.handoff_id,
    sourceAttachmentId: row.source_attachment_id,
    displayName: row.display_name,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    storageRelativePath: row.storage_relative_path,
    createdAtMs: row.created_at_ms
  }
}

export class SqliteJobIntakeRepository implements JobIntakeRepository {
  constructor(private readonly database: Database.Database) {}

  getBySourceDraftId(sourceDraftId: string): JobIntakeHandoffRecord | null {
    return handoff(
      this.database
        .prepare(
          `SELECT id, source_draft_id, source_user_id, source_workspace_id, source_tree_id,
                  source_draft_revision, source_tree_revision, state, draft_snapshot_json,
                  execution_tree_json, created_at_ms, accepted_at_ms, rejected_at_ms,
                  rejection_code
           FROM job_intake_handoffs WHERE source_draft_id = ?`
        )
        .get(sourceDraftId) as HandoffRow | undefined
    )
  }
  insertHandoff(record: JobIntakeHandoffRecord): void {
    this.database
      .prepare(
        `INSERT INTO job_intake_handoffs
           (id, source_draft_id, source_user_id, source_workspace_id, source_tree_id,
            source_draft_revision, source_tree_revision, state, draft_snapshot_json,
            execution_tree_json, created_at_ms, accepted_at_ms, rejected_at_ms, rejection_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.sourceDraftId,
        record.sourceUserId,
        record.sourceWorkspaceId,
        record.sourceTreeId,
        record.sourceDraftRevision,
        record.sourceTreeRevision,
        record.state,
        record.draftSnapshotJson,
        record.executionTreeJson,
        record.createdAtMs,
        record.acceptedAtMs,
        record.rejectedAtMs,
        record.rejectionCode
      )
  }
  insertAttachment(record: JobIntakeAttachmentRecord): void {
    this.database
      .prepare(
        `INSERT INTO job_intake_attachments
           (id, handoff_id, source_attachment_id, display_name, media_type, size_bytes,
            sha256, storage_relative_path, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.handoffId,
        record.sourceAttachmentId,
        record.displayName,
        record.mediaType,
        record.sizeBytes,
        record.sha256,
        record.storageRelativePath,
        record.createdAtMs
      )
  }
  listAttachments(handoffId: string): JobIntakeAttachmentRecord[] {
    return (
      this.database
        .prepare(
          `SELECT id, handoff_id, source_attachment_id, display_name, media_type, size_bytes,
                  sha256, storage_relative_path, created_at_ms
           FROM job_intake_attachments WHERE handoff_id = ? ORDER BY created_at_ms, id`
        )
        .all(handoffId) as AttachmentRow[]
    ).map(attachment)
  }
}
