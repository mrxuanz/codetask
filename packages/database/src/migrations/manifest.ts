import { createHash } from 'node:crypto'

export type MigrationManifestEntry =
  | {
      kind: 'migration'
      version: number
      name: string
      checksum: string
    }
  | {
      kind: 'tombstone'
      version: number
      name: string
      reason: string
    }

/**
 * Stable checksum for a published migration identity (Batch G).
 * Changing version/name of an applied migration fails validation.
 */
export function migrationChecksum(version: number, name: string): string {
  return createHash('sha256').update(`${version}\0${name}`, 'utf8').digest('hex')
}

function migrationEntry(version: number, name: string): MigrationManifestEntry {
  return {
    kind: 'migration',
    version,
    name,
    checksum: migrationChecksum(version, name)
  }
}

function tombstone(version: number, name: string, reason: string): MigrationManifestEntry {
  return { kind: 'tombstone', version, name, reason }
}

/**
 * Canonical migration manifest — includes explicit tombstones for historical gaps
 * (versions 22, 37, 38 were never shipped).
 */
export const MIGRATION_MANIFEST: readonly MigrationManifestEntry[] = Object.freeze([
  migrationEntry(1, 'baseline_tables'),
  migrationEntry(2, 'constraints_and_job_tasks'),
  migrationEntry(3, 'plan_abilities_events'),
  migrationEntry(4, 'thread_pointer_cleanup'),
  migrationEntry(5, 'plan_milestones_slices'),
  migrationEntry(6, 'drop_legacy_job_json'),
  migrationEntry(7, 'execution_lease'),
  migrationEntry(8, 'orphan_cleanup'),
  migrationEntry(9, 'reference_manifest'),
  migrationEntry(10, 'wizard_handoff_message_kind'),
  migrationEntry(11, 'repair_thread_messages_table'),
  migrationEntry(12, 'task_evidence_json'),
  migrationEntry(13, 'drop_job_events'),
  migrationEntry(14, 'retention_layer'),
  migrationEntry(15, 'message_payload_retention'),
  migrationEntry(16, 'design_sessions'),
  migrationEntry(17, 'wizard_phase_phases'),
  migrationEntry(18, 'draft_references'),
  migrationEntry(19, 'design_plan_artifacts'),
  migrationEntry(20, 'job_snapshot'),
  migrationEntry(21, 'corpus_revision'),
  tombstone(22, 'skipped_22', 'Historical gap — never shipped'),
  migrationEntry(23, 'workload_slots'),
  migrationEntry(24, 'job_pausing_status'),
  migrationEntry(25, 'runtime_bytes'),
  migrationEntry(26, 'unify_thread_jobs'),
  migrationEntry(27, 'control_plane_schema'),
  migrationEntry(28, 'control_plane_corrective_schema'),
  migrationEntry(29, 'job_task_attempts'),
  migrationEntry(30, 'workspace_leases_and_deletion'),
  migrationEntry(31, 'deletion_request_phases'),
  migrationEntry(32, 'storage_settings'),
  migrationEntry(33, 'design_plan_revisions'),
  migrationEntry(34, 'job_artifact_blob'),
  migrationEntry(35, 'job_suspension_recovery'),
  migrationEntry(36, 'conversation_turns'),
  tombstone(37, 'skipped_37', 'Historical gap — never shipped'),
  tombstone(38, 'skipped_38', 'Historical gap — never shipped'),
  migrationEntry(39, 'promote_restart_interrupted_paused'),
  migrationEntry(40, 'destructive_auth_current'),
  migrationEntry(41, 'auth_secret_sqlite'),
  migrationEntry(42, 'execution_profile'),
  migrationEntry(43, 'design_module_tables'),
  migrationEntry(44, 'design_data_backfill'),
  migrationEntry(45, 'execution_module_tables'),
  migrationEntry(46, 'execution_data_migrate'),
  migrationEntry(47, 'drop_control_plane_tables'),
  migrationEntry(48, 'conversation_module_tables'),
  migrationEntry(49, 'conversation_data_migrate'),
  migrationEntry(50, 'conversation_cleanup'),
  migrationEntry(51, 'actor_id_username_to_user_id'),
  migrationEntry(52, 'projects_username_to_actor_id'),
  migrationEntry(53, 'settings_namespaces'),
  migrationEntry(54, 'realtime_events'),
  migrationEntry(55, 'drop_wizard_columns'),
  migrationEntry(56, 'tighten_legacy_thread_schema'),
  migrationEntry(57, 'legacy_owner_actor_id'),
  migrationEntry(58, 'deletion_requests_actor_id'),
  migrationEntry(59, 'drop_legacy_job_shell_tables'),
  migrationEntry(60, 'drop_thread_jobs_graph'),
  migrationEntry(61, 'canonical_provider_codes'),
  migrationEntry(62, 'assets_and_drop_dead_runtime_tables'),
  migrationEntry(63, 'project_fk_and_asset_storage_keys'),
  migrationEntry(64, 'drop_backup_and_marker_tables'),
  migrationEntry(65, 'drop_legacy_thread_tables')
])

export function listManifestMigrations(): Array<{
  version: number
  name: string
  checksum: string
}> {
  return MIGRATION_MANIFEST.filter(
    (entry): entry is Extract<MigrationManifestEntry, { kind: 'migration' }> =>
      entry.kind === 'migration'
  ).map((entry) => ({
    version: entry.version,
    name: entry.name,
    checksum: entry.checksum
  }))
}

export function findManifestEntry(version: number): MigrationManifestEntry | undefined {
  return MIGRATION_MANIFEST.find((entry) => entry.version === version)
}

export function assertManifestContiguous(): void {
  const versions = MIGRATION_MANIFEST.map((entry) => entry.version)
  for (let i = 0; i < versions.length; i++) {
    if (versions[i] !== i + 1) {
      throw new Error(
        `Migration manifest gap or disorder at index ${i}: expected ${i + 1}, got ${versions[i]}`
      )
    }
  }
}
