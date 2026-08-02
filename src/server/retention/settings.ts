import {
  DEFAULT_RETENTION_SETTINGS,
  type RetentionSettings
} from '../../shared/contracts/retention.ts'
import type { AppConfig } from '../config/app-config'

/** Retention is deploy/code config — not a user Settings namespace (05 §18). */
export function readRetentionSettings(config?: AppConfig | null): RetentionSettings {
  const fromConfig = config?.retention
  if (!fromConfig) {
    return { ...DEFAULT_RETENTION_SETTINGS }
  }
  return {
    workingArtifactDays: fromConfig.workingArtifactDays,
    archiveArtifactDays: fromConfig.archiveArtifactDays,
    runtimePausedDays: fromConfig.runtimePausedDays,
    runtimeTerminalImmediate: fromConfig.runtimeTerminalImmediate,
    compactCountersOnTerminal: fromConfig.compactCountersOnTerminal,
    artifactInlineMaxBytes: fromConfig.artifactInlineMaxBytes,
    pruneIntervalHours: fromConfig.pruneIntervalHours,
    sqliteMaintenanceIntervalHours: fromConfig.sqliteMaintenanceIntervalHours,
    messagePayloadInlineMaxBytes: fromConfig.messagePayloadInlineMaxBytes
  }
}

export function artifactExpirySec(
  settings: RetentionSettings,
  tier: 'working' | 'archive' = 'working'
): number | null {
  const days =
    tier === 'archive' && settings.archiveArtifactDays > 0
      ? settings.archiveArtifactDays
      : settings.workingArtifactDays
  if (days <= 0) return null
  return Math.floor(Date.now() / 1000) + days * 86_400
}
