export type JobArtifactKind =
  | 'task_evidence'
  | 'slice_verdict'
  | 'verifier_bundle'
  | 'message_payload'

export type JobArtifactTier = 'working' | 'archive'

export interface RetentionSettings {
  workingArtifactDays: number

  archiveArtifactDays: number

  runtimePausedDays: number

  runtimeTerminalImmediate: boolean

  compactCountersOnTerminal: boolean

  artifactInlineMaxBytes: number

  pruneIntervalHours: number

  sqliteMaintenanceIntervalHours: number

  messagePayloadInlineMaxBytes: number

  runtimeMaxBytesPerJob: number

  dataDirMaxBytes: number
}

export const DEFAULT_RETENTION_SETTINGS: RetentionSettings = {
  workingArtifactDays: 14,
  archiveArtifactDays: 0,
  runtimePausedDays: 7,
  runtimeTerminalImmediate: true,
  compactCountersOnTerminal: true,
  artifactInlineMaxBytes: 8192,
  pruneIntervalHours: 24,
  sqliteMaintenanceIntervalHours: 24,
  messagePayloadInlineMaxBytes: 8192,
  runtimeMaxBytesPerJob: 5 * 1024 * 1024 * 1024,
  dataDirMaxBytes: 20 * 1024 * 1024 * 1024
}

export const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'cancelled'] as const
export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number]

export function isTerminalJobStatus(status: string): status is TerminalJobStatus {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status)
}
