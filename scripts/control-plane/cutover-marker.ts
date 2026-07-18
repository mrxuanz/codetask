/**
 * Cutover Marker
 *
 * Manages the migration state transitions:
 * - preparing: Legacy runtime still active
 * - copied: Data copied but not yet authoritative
 * - v3_authoritative: V3 is now the source of truth
 */

export type SchemaGeneration = 'preparing' | 'copied' | 'v3_authoritative'

export interface CutoverMarker {
  readonly key: 'control_schema_generation'
  readonly value: SchemaGeneration
  readonly sourceMigration: number
  readonly copyReportHash: string | null
  readonly backupId: string | null
  readonly updatedAtMs: number
}

export type CutoverUpgradeResult =
  | { readonly ok: true; readonly marker: CutoverMarker }
  | { readonly ok: false; readonly reason: string }

export function canUpgradeTo(marker: CutoverMarker, target: SchemaGeneration): boolean {
  switch (target) {
    case 'copied':
      return marker.value === 'preparing'
    case 'v3_authoritative':
      return marker.value === 'copied'
    default:
      return false
  }
}

export function upgradeMarker(
  marker: CutoverMarker,
  target: SchemaGeneration,
  options: { readonly hasConflicts: boolean; readonly copyReportHash?: string | null }
): CutoverUpgradeResult {
  if (options.hasConflicts) {
    return { ok: false, reason: 'migration.has_conflicts' }
  }

  if (!canUpgradeTo(marker, target)) {
    return { ok: false, reason: 'migration.invalid_transition' }
  }

  return {
    ok: true,
    marker: {
      ...marker,
      value: target,
      copyReportHash: options.copyReportHash ?? marker.copyReportHash,
      updatedAtMs: Date.now()
    }
  }
}

export function isAuthoritative(marker: CutoverMarker): boolean {
  return marker.value === 'v3_authoritative'
}

export function createInitialMarker(): CutoverMarker {
  return {
    key: 'control_schema_generation',
    value: 'preparing',
    sourceMigration: 26,
    copyReportHash: null,
    backupId: null,
    updatedAtMs: Date.now()
  }
}
