export type JobProgressCode =
  | 'plan.pending'
  | 'plan.planning'
  | 'plan.planning_partial'
  | 'plan.plan_ready'
  | 'plan.planning_failed'
  | 'plan.needs_auth'
  | 'plan.cleanup_failed'
  | 'plan.draft_unlocked'
  | 'plan.tree_not_ready'
  | 'plan.regenerating'
  | 'plan.pausing'
  | 'execution.pending'
  | 'execution.interrupted_resume'
  | 'execution.pausing_exhausted'
  | 'execution.starting'
  | 'execution.resuming'
  | 'execution.stale_running'
  | 'execution.completed'
  | 'execution.failed'
  | 'execution.workflow_deadlock'
  | 'execution.workflow_failed_block'
  | 'execution.running_task'
  | 'execution.verifying_slice'
  | 'execution.verifying_milestone'
  | 'execution.slice_accepted'
  | 'execution.milestone_accepted'
  | 'execution.slice_blocked'
  | 'execution.milestone_blocked'
  | 'execution.slice_inconclusive_exhausted'
  | 'execution.milestone_inconclusive_exhausted'
  | 'execution.evidence_incomplete'
  | 'execution.evidence_missing'
  | 'execution.continuing_task'
  | 'execution.recovery_infra_retry'
  | 'execution.recovery_prep_injected'
  | 'execution.recovery_repair_injected'

export type JobProgressParams = Record<string, string | number | boolean>

export interface JobProgressDto {
  code: JobProgressCode
  params?: JobProgressParams
}
