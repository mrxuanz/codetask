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
import { migration022AuthGuard } from './022_auth_guard'
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
import { migration037ChangeSets } from './037_change_sets'
import { migration038WorkspaceLeaseChangeSetOwner } from './038_workspace_lease_change_set_owner'
import { migration039PromoteRestartInterruptedPaused } from './039_promote_restart_interrupted_paused'
import { migration040ConversationTurnChangeSets } from './040_conversation_turn_change_sets'
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
  migration022AuthGuard,
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
  migration037ChangeSets,
  migration038WorkspaceLeaseChangeSetOwner,
  migration039PromoteRestartInterruptedPaused,
  migration040ConversationTurnChangeSets
]

export function applyMigrations(db: Database.Database): void {
  runMigrations(db, allMigrations)
}
