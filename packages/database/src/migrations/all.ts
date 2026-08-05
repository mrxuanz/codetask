import type Database from 'better-sqlite3'
import type { Migration } from './v001_042/types.ts'
import { runMigrations } from './runner.ts'

import { migration001BaselineTables } from './v001_042/001_baseline_tables.ts'
import { migration002ConstraintsAndJobTasks } from './v001_042/002_constraints_and_job_tasks.ts'
import { migration003PlanAbilitiesEvents } from './v001_042/003_plan_abilities_events.ts'
import { migration004ThreadPointerCleanup } from './v001_042/004_thread_pointer_cleanup.ts'
import { migration005PlanMilestonesSlices } from './v001_042/005_plan_milestones_slices.ts'
import { migration006DropLegacyJobJson } from './v001_042/006_drop_legacy_job_json.ts'
import { migration007ExecutionLease } from './v001_042/007_execution_lease.ts'
import { migration008OrphanCleanup } from './v001_042/008_orphan_cleanup.ts'
import { migration009ReferenceManifest } from './v001_042/009_reference_manifest.ts'
import { migration010WizardHandoffMessageKind } from './v001_042/010_wizard_handoff_message_kind.ts'
import { migration011RepairThreadMessagesTable } from './v001_042/011_repair_thread_messages_table.ts'
import { migration012TaskEvidenceJson } from './v001_042/012_task_evidence_json.ts'
import { migration013DropJobEvents } from './v001_042/013_drop_job_events.ts'
import { migration014RetentionLayer } from './v001_042/014_retention_layer.ts'
import { migration015MessagePayloadRetention } from './v001_042/015_message_payload_retention.ts'
import { migration016DesignSessions } from './v001_042/016_design_sessions.ts'
import { migration017WizardPhasePhases } from './v001_042/017_wizard_phase_phases.ts'
import { migration018DraftReferences } from './v001_042/018_draft_references.ts'
import { migration019DesignPlanArtifacts } from './v001_042/019_design_plan_artifacts.ts'
import { migration020JobSnapshot } from './v001_042/020_job_snapshot.ts'
import { migration021CorpusRevision } from './v001_042/021_corpus_revision.ts'
import { migration023WorkloadSlots } from './v001_042/023_workload_slots.ts'
import { migration024JobPausingStatus } from './v001_042/024_job_pausing_status.ts'
import { migration025RuntimeBytes } from './v001_042/025_runtime_bytes.ts'
import { migration026UnifyThreadJobs } from './v001_042/026_unify_thread_jobs.ts'
import { migration027ControlPlaneSchema } from './v001_042/027_control_plane_schema.ts'
import { migration028ControlPlaneCorrectiveSchema } from './v001_042/028_control_plane_corrective_schema.ts'
import { migration029JobTaskAttempts } from './v001_042/029_job_task_attempts.ts'
import { migration030WorkspaceLeasesAndDeletion } from './v001_042/030_workspace_leases_and_deletion.ts'
import { migration031DeletionRequestPhases } from './v001_042/031_deletion_request_phases.ts'
import { migration032StorageSettings } from './v001_042/032_storage_settings.ts'
import { migration033DesignPlanRevisions } from './v001_042/033_design_plan_revisions.ts'
import { migration034JobArtifactBlob } from './v001_042/034_job_artifact_blob.ts'
import { migration035JobSuspensionRecovery } from './v001_042/035_job_suspension_recovery.ts'
import { migration036ConversationTurns } from './v001_042/036_conversation_turns.ts'
import { migration039PromoteRestartInterruptedPaused } from './v001_042/039_promote_restart_interrupted_paused.ts'
import { migration040DestructiveAuthCurrent } from './v001_042/040_destructive_auth_current.ts'
import { migration041AuthSecretSqlite } from './v001_042/041_auth_secret_sqlite.ts'
import { migration042ExecutionProfile } from './v001_042/042_execution_profile.ts'

import { migration043DesignModuleTables } from './index.ts'
import { migration044DesignDataBackfill } from './044_design_data_backfill.ts'
import { migration045ExecutionModuleTables } from './execution.ts'
import { migration046ExecutionDataMigrate } from './execution-data-migrate.ts'
import { migration047DropControlPlaneTables } from './drop-control-plane.ts'
import { migration048ConversationModuleTables } from './conversation.ts'
import { migration049ConversationDataMigrate } from './conversation-data.ts'
import { migration050ConversationCleanup } from './conversation-cleanup.ts'
import { migration051ActorIdRemap } from './auth-actor-remap.ts'
import { migration052ProjectsActorId } from './projects-actor-id.ts'
import { migration053SettingsNamespaces } from './settings-namespaces.ts'
import { migration054RealtimeEvents } from './realtime-events.ts'
import { migration055DropWizardColumns } from './drop-wizard-columns.ts'
import { migration056TightenLegacyThreadSchema } from './tighten-legacy-thread-schema.ts'
import { migration057LegacyOwnerActorId } from './legacy-owner-actor-id.ts'
import { migration058DeletionRequestsActorId } from './deletion-requests-actor-id.ts'
import { migration059DropLegacyJobShellTables } from './drop-legacy-job-shell-tables.ts'
import { migration060DropThreadJobsGraph } from './drop-thread-jobs-graph.ts'
import { migration061CanonicalProviderCodes } from './canonical-provider-codes.ts'
import { migration062AssetsAndDropDeadRuntimeTables } from './assets-and-drop-dead-runtime.ts'
import { migration063ProjectFkAndAssetStorageKeys } from './project-fk-and-asset-storage.ts'
import { migration064DropBackupAndMarkerTables } from './drop-backup-and-marker-tables.ts'
import { migration065DropLegacyThreadTables } from './drop-legacy-thread-tables.ts'

export type { Migration } from './v001_042/types.ts'
export { runMigrations } from './runner.ts'

export const allMigrations: Migration[] = [
  migration001BaselineTables,
  migration002ConstraintsAndJobTasks,
  migration003PlanAbilitiesEvents,
  migration004ThreadPointerCleanup,
  migration005PlanMilestonesSlices,
  migration006DropLegacyJobJson,
  migration007ExecutionLease,
  migration008OrphanCleanup,
  migration009ReferenceManifest,
  migration010WizardHandoffMessageKind,
  migration011RepairThreadMessagesTable,
  migration012TaskEvidenceJson,
  migration013DropJobEvents,
  migration014RetentionLayer,
  migration015MessagePayloadRetention,
  migration016DesignSessions,
  migration017WizardPhasePhases,
  migration018DraftReferences,
  migration019DesignPlanArtifacts,
  migration020JobSnapshot,
  migration021CorpusRevision,
  migration023WorkloadSlots,
  migration024JobPausingStatus,
  migration025RuntimeBytes,
  migration026UnifyThreadJobs,
  migration027ControlPlaneSchema,
  migration028ControlPlaneCorrectiveSchema,
  migration029JobTaskAttempts,
  migration030WorkspaceLeasesAndDeletion,
  migration031DeletionRequestPhases,
  migration032StorageSettings,
  migration033DesignPlanRevisions,
  migration034JobArtifactBlob,
  migration035JobSuspensionRecovery,
  migration036ConversationTurns,
  migration039PromoteRestartInterruptedPaused,
  migration040DestructiveAuthCurrent,
  migration041AuthSecretSqlite,
  migration042ExecutionProfile,
  migration043DesignModuleTables,
  migration044DesignDataBackfill,
  migration045ExecutionModuleTables,
  migration046ExecutionDataMigrate,
  migration047DropControlPlaneTables,
  migration048ConversationModuleTables,
  migration049ConversationDataMigrate,
  migration050ConversationCleanup,
  migration051ActorIdRemap,
  migration052ProjectsActorId,
  migration053SettingsNamespaces,
  migration054RealtimeEvents,
  migration055DropWizardColumns,
  migration056TightenLegacyThreadSchema,
  migration057LegacyOwnerActorId,
  migration058DeletionRequestsActorId,
  migration059DropLegacyJobShellTables,
  migration060DropThreadJobsGraph,
  migration061CanonicalProviderCodes,
  migration062AssetsAndDropDeadRuntimeTables,
  migration063ProjectFkAndAssetStorageKeys,
  migration064DropBackupAndMarkerTables,
  migration065DropLegacyThreadTables
]

export function applyMigrations(db: Database.Database): void {
  runMigrations(db, allMigrations)
  try {
    const failures = db.prepare(`SELECT COUNT(*) AS c FROM migration_failures`).get() as {
      c: number
    }
    if (failures.c > 0) {
      throw new Error(
        `Design migration recorded ${failures.c} failure(s); resolve migration_failures before starting`
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Design migration recorded')) {
      throw error
    }
  }
}
