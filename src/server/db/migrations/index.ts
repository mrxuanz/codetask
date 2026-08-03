import { migration001BaselineTables } from './001_baseline_tables'
import { migration002ConstraintsAndJobTasks } from './002_constraints_and_job_tasks'
import { migration003PlanAbilitiesEvents } from './003_plan_abilities_events'
import { migration004ThreadPointerCleanup } from './004_thread_pointer_cleanup'
import { migration005PlanMilestonesSlices } from './005_plan_milestones_slices'
import { migration006DropLegacyJobJson } from './006_drop_legacy_job_json'
import { migration007ExecutionLease } from './007_execution_lease'
import { migration008OrphanCleanup } from './008_orphan_cleanup'
import { migration009ReferenceManifest } from './009_reference_manifest'
import { migration010WizardHandoffMessageKind } from './010_wizard_handoff_message_kind'
import { migration011RepairThreadMessagesTable } from './011_repair_thread_messages_table'
import { migration012TaskEvidenceJson } from './012_task_evidence_json'
import { migration013DropJobEvents } from './013_drop_job_events'
import { migration014RetentionLayer } from './014_retention_layer'
import { migration015MessagePayloadRetention } from './015_message_payload_retention'
import { migration016DesignSessions } from './016_design_sessions'
import { migration017WizardPhasePhases } from './017_wizard_phase_phases'
import { migration018DraftReferences } from './018_draft_references'
import { migration019DesignPlanArtifacts } from './019_design_plan_artifacts'
import { migration020JobSnapshot } from './020_job_snapshot'
import { migration021CorpusRevision } from './021_corpus_revision'
import { migration023WorkloadSlots } from './023_workload_slots'
import { migration024JobPausingStatus } from './024_job_pausing_status'
import { migration025RuntimeBytes } from './025_runtime_bytes'
import { migration026UnifyThreadJobs } from './026_unify_thread_jobs'
import { migration027ControlPlaneSchema } from './027_control_plane_schema'
import { migration028ControlPlaneCorrectiveSchema } from './028_control_plane_corrective_schema'
import { migration029JobTaskAttempts } from './029_job_task_attempts'
import { migration030WorkspaceLeasesAndDeletion } from './030_workspace_leases_and_deletion'
import { migration031DeletionRequestPhases } from './031_deletion_request_phases'
import { migration032StorageSettings } from './032_storage_settings'
import { migration033DesignPlanRevisions } from './033_design_plan_revisions'
import { migration034JobArtifactBlob } from './034_job_artifact_blob'
import { migration035JobSuspensionRecovery } from './035_job_suspension_recovery'
import { migration036ConversationTurns } from './036_conversation_turns'
import { migration039PromoteRestartInterruptedPaused } from './039_promote_restart_interrupted_paused'
import { migration040DestructiveAuthCurrent } from './040_destructive_auth_current'
import { migration041AuthSecretSqlite } from './041_auth_secret_sqlite'
import { migration042ExecutionProfile } from './042_execution_profile'
import { migration043DesignModule } from './043_design_module_tables'
import { migration044DesignDataBackfill } from './044_design_data_backfill'
import { migration045ExecutionModule } from './045_execution_module_tables'
import { migration046ExecutionData } from './046_execution_data_migrate'
import { migration047DropControlPlane } from './047_drop_control_plane_tables'
import { migration048ConversationModule } from './048_conversation_module_tables'
import { migration049ConversationData } from './049_conversation_data_migrate'
import { migration050ConversationCleanupTables } from './050_conversation_cleanup'
import { migration051ActorIdUsernameToUserId } from './051_actor_id_username_to_user_id'
import { migration052ProjectsUsernameToActorId } from './052_projects_username_to_actor_id'
import { migration053SettingsNamespaces } from './053_settings_namespaces'
import { migration054RealtimeEvents } from './054_realtime_events'
import { migration055DropWizardColumnsTables } from './055_drop_wizard_columns'
import { migration056TightenLegacyThreadSchemaTables } from './056_tighten_legacy_thread_schema'
import { migration057LegacyOwnerActorIdTables } from './057_legacy_owner_actor_id'
import { migration058DeletionRequestsActorIdTables } from './058_deletion_requests_actor_id'
import { migration059DropLegacyJobShellTablesHost } from './059_drop_legacy_job_shell_tables'
import { migration060DropThreadJobsGraphHost } from './060_drop_thread_jobs_graph'
import { runMigrations } from './runner'
import type Database from 'better-sqlite3'

export const allMigrations = [
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
  migration043DesignModule,
  migration044DesignDataBackfill,
  migration045ExecutionModule,
  migration046ExecutionData,
  migration047DropControlPlane,
  migration048ConversationModule,
  migration049ConversationData,
  migration050ConversationCleanupTables,
  migration051ActorIdUsernameToUserId,
  migration052ProjectsUsernameToActorId,
  migration053SettingsNamespaces,
  migration054RealtimeEvents,
  migration055DropWizardColumnsTables,
  migration056TightenLegacyThreadSchemaTables,
  migration057LegacyOwnerActorIdTables,
  migration058DeletionRequestsActorIdTables,
  migration059DropLegacyJobShellTablesHost,
  migration060DropThreadJobsGraphHost
]

export function applyMigrations(db: Database.Database): void {
  runMigrations(db, allMigrations)
  try {
    const failures = db
      .prepare(`SELECT COUNT(*) AS c FROM migration_failures`)
      .get() as { c: number }
    if (failures.c > 0) {
      throw new Error(
        `Design migration recorded ${failures.c} failure(s); resolve migration_failures before starting`
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Design migration recorded')) {
      throw error
    }
    // Table may not exist on unexpected partial upgrade paths.
  }
}
