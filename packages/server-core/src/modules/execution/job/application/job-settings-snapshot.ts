import type Database from 'better-sqlite3'
import type { ExecutionSettingsSnapshot } from '@codetask/contracts'

export type JobExecutionSettingsRecord = {
  settingsHash: string
  capturedAt: string
  /** Frozen ExecutionSettingsSnapshot (or legacy payload shape). */
  snapshot: ExecutionSettingsSnapshot | Record<string, unknown>
}

/**
 * Read frozen execution settings from job_snapshots (05: never re-read live Settings).
 * Stored shape is `{ settingsHash, capturedAt, payload }` from JobSubmission.
 */
export function readJobExecutionSettings(
  db: Database.Database,
  jobId: string
): JobExecutionSettingsRecord | null {
  try {
    const row = db
      .prepare(`SELECT execution_settings_snapshot_json FROM job_snapshots WHERE job_id = ?`)
      .get(jobId) as { execution_settings_snapshot_json?: string } | undefined
    if (!row?.execution_settings_snapshot_json) return null
    const wrapper = JSON.parse(row.execution_settings_snapshot_json) as {
      settingsHash?: string
      capturedAt?: string
      payload?: ExecutionSettingsSnapshot | Record<string, unknown>
      taskMcpServers?: Record<string, unknown>
      verificationMcpServers?: Record<string, unknown>
      sliceVerifierPromptBody?: string
      milestoneVerifierPromptBody?: string
      sourceRevisions?: unknown
    }
    const snapshot =
      (wrapper.payload as ExecutionSettingsSnapshot | undefined) ??
      ({
        taskMcpServers: wrapper.taskMcpServers ?? {},
        verificationMcpServers: wrapper.verificationMcpServers ?? {},
        sliceVerifierPromptBody: wrapper.sliceVerifierPromptBody ?? '',
        milestoneVerifierPromptBody: wrapper.milestoneVerifierPromptBody ?? '',
        sourceRevisions: Array.isArray(wrapper.sourceRevisions) ? wrapper.sourceRevisions : []
      } as ExecutionSettingsSnapshot)
    return {
      settingsHash: typeof wrapper.settingsHash === 'string' ? wrapper.settingsHash : '',
      capturedAt: typeof wrapper.capturedAt === 'string' ? wrapper.capturedAt : '',
      snapshot
    }
  } catch {
    // Missing column / malformed JSON in partial test DBs — treat as no frozen settings.
    return null
  }
}

export function taskMcpFromJobSettings(
  record: JobExecutionSettingsRecord | null
): Record<string, unknown> {
  if (!record) return {}
  const snap = record.snapshot as Partial<ExecutionSettingsSnapshot>
  return snap.taskMcpServers && typeof snap.taskMcpServers === 'object'
    ? snap.taskMcpServers
    : {}
}

export function verificationMcpFromJobSettings(
  record: JobExecutionSettingsRecord | null
): Record<string, unknown> {
  if (!record) return {}
  const snap = record.snapshot as Partial<ExecutionSettingsSnapshot>
  return snap.verificationMcpServers && typeof snap.verificationMcpServers === 'object'
    ? snap.verificationMcpServers
    : {}
}

export function verifierPromptFromJobSettings(
  record: JobExecutionSettingsRecord | null,
  kind: 'slice' | 'milestone'
): string {
  if (!record) return ''
  const snap = record.snapshot as Partial<ExecutionSettingsSnapshot>
  if (kind === 'milestone') {
    return typeof snap.milestoneVerifierPromptBody === 'string'
      ? snap.milestoneVerifierPromptBody
      : ''
  }
  return typeof snap.sliceVerifierPromptBody === 'string' ? snap.sliceVerifierPromptBody : ''
}
