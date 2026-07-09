import type { RetentionSettings } from '../../shared/contracts/retention.ts'
import { DEFAULT_RETENTION_SETTINGS } from '../../shared/contracts/retention.ts'
import type { SettingsStore } from '../context/settings-store'

export function readRetentionSettings(store: SettingsStore): RetentionSettings {
  const raw = store.read().retention
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_RETENTION_SETTINGS }
  }
  const input = raw as Partial<RetentionSettings>
  return {
    workingArtifactDays:
      typeof input.workingArtifactDays === 'number'
        ? input.workingArtifactDays
        : DEFAULT_RETENTION_SETTINGS.workingArtifactDays,
    archiveArtifactDays:
      typeof input.archiveArtifactDays === 'number'
        ? input.archiveArtifactDays
        : DEFAULT_RETENTION_SETTINGS.archiveArtifactDays,
    runtimePausedDays:
      typeof input.runtimePausedDays === 'number'
        ? input.runtimePausedDays
        : DEFAULT_RETENTION_SETTINGS.runtimePausedDays,
    runtimeTerminalImmediate:
      typeof input.runtimeTerminalImmediate === 'boolean'
        ? input.runtimeTerminalImmediate
        : DEFAULT_RETENTION_SETTINGS.runtimeTerminalImmediate,
    compactCountersOnTerminal:
      typeof input.compactCountersOnTerminal === 'boolean'
        ? input.compactCountersOnTerminal
        : DEFAULT_RETENTION_SETTINGS.compactCountersOnTerminal,
    artifactInlineMaxBytes:
      typeof input.artifactInlineMaxBytes === 'number'
        ? input.artifactInlineMaxBytes
        : DEFAULT_RETENTION_SETTINGS.artifactInlineMaxBytes,
    pruneIntervalHours:
      typeof input.pruneIntervalHours === 'number'
        ? input.pruneIntervalHours
        : DEFAULT_RETENTION_SETTINGS.pruneIntervalHours,
    sqliteMaintenanceIntervalHours:
      typeof input.sqliteMaintenanceIntervalHours === 'number'
        ? input.sqliteMaintenanceIntervalHours
        : DEFAULT_RETENTION_SETTINGS.sqliteMaintenanceIntervalHours,
    messagePayloadInlineMaxBytes:
      typeof input.messagePayloadInlineMaxBytes === 'number'
        ? input.messagePayloadInlineMaxBytes
        : DEFAULT_RETENTION_SETTINGS.messagePayloadInlineMaxBytes,
    runtimeMaxBytesPerJob:
      typeof input.runtimeMaxBytesPerJob === 'number'
        ? input.runtimeMaxBytesPerJob
        : DEFAULT_RETENTION_SETTINGS.runtimeMaxBytesPerJob,
    dataDirMaxBytes:
      typeof input.dataDirMaxBytes === 'number'
        ? input.dataDirMaxBytes
        : DEFAULT_RETENTION_SETTINGS.dataDirMaxBytes
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
