import type { JobAggregate } from './job-state-machine'
import { isTerminal } from './job-action-rules'

export type InvariantViolation = {
  readonly code: string
  readonly detail: string
}

export interface ActiveRunSummary {
  readonly id: string
  readonly state: string
  readonly fenceToken: string
}

export function validateJobInvariant(
  job: JobAggregate,
  activeRun: ActiveRunSummary | null
): readonly InvariantViolation[] {
  const violations: InvariantViolation[] = []

  // Global numeric invariants
  if (job.executionGeneration < 0) {
    violations.push({
      code: 'job.negative_execution_generation',
      detail: `job=${job.id} generation=${job.executionGeneration}`
    })
  }

  if (job.stateRevision < 1) {
    violations.push({
      code: 'job.invalid_state_revision',
      detail: `job=${job.id} revision=${job.stateRevision}`
    })
  }

  // resumeTarget must be a valid value when non-null
  if (job.resumeTarget !== null && job.resumeTarget !== 'planning_queued' && job.resumeTarget !== 'execution_queued') {
    violations.push({
      code: 'job.invalid_resume_target_value',
      detail: `job=${job.id} resumeTarget=${job.resumeTarget}`
    })
  }

  // pausing: requires controlIntent='pause', resumeTarget!=null, activeRun matching
  if (job.state === 'pausing') {
    if (job.controlIntent !== 'pause') {
      violations.push({
        code: 'job.pausing_without_intent',
        detail: `job=${job.id} controlIntent=${job.controlIntent}`
      })
    }
    if (job.resumeTarget === null) {
      violations.push({
        code: 'job.pausing_without_resume_target',
        detail: `job=${job.id}`
      })
    }
    if (job.activeRunId === null || activeRun === null || job.activeRunId !== activeRun.id) {
      violations.push({
        code: 'job.pausing_without_active_run',
        detail: `job=${job.id} activeRunId=${job.activeRunId} runSummaryId=${activeRun?.id ?? 'null'}`
      })
    }
  }

  // paused: requires controlIntent='none', activeRunId=null, resumeTarget!=null
  if (job.state === 'paused') {
    if (job.controlIntent !== 'none') {
      violations.push({
        code: 'job.paused_has_control_intent',
        detail: `job=${job.id} controlIntent=${job.controlIntent}`
      })
    }
    if (job.activeRunId !== null) {
      violations.push({
        code: 'job.paused_has_active_run',
        detail: `job=${job.id} activeRunId=${job.activeRunId}`
      })
    }
    if (job.resumeTarget === null) {
      violations.push({
        code: 'job.paused_without_resume_target',
        detail: `job=${job.id}`
      })
    }
  }

  // terminal (succeeded, failed, cancelled): requires activeRunId=null, controlIntent='none'
  if (isTerminal(job.state)) {
    if (job.activeRunId !== null) {
      violations.push({
        code: 'job.terminal_has_active_run',
        detail: `job=${job.id} state=${job.state} activeRunId=${job.activeRunId}`
      })
    }
    if (job.controlIntent !== 'none') {
      violations.push({
        code: 'job.terminal_has_control_intent',
        detail: `job=${job.id} state=${job.state} controlIntent=${job.controlIntent}`
      })
    }
  }

  // execution_running: requires activeRunId!=null
  if (job.state === 'execution_running' && job.activeRunId === null) {
    violations.push({
      code: 'job.execution_running_without_active_run',
      detail: `job=${job.id}`
    })
  }

  // planning_running: requires activeRunId!=null
  if (job.state === 'planning_running' && job.activeRunId === null) {
    violations.push({
      code: 'job.planning_running_without_active_run',
      detail: `job=${job.id}`
    })
  }

  // queued states: requires activeRunId=null
  if ((job.state === 'planning_queued' || job.state === 'execution_queued') && job.activeRunId !== null) {
    violations.push({
      code: 'job.queued_has_active_run',
      detail: `job=${job.id} state=${job.state} activeRunId=${job.activeRunId}`
    })
  }

  return violations
}

export function hasInvariantViolations(violations: readonly InvariantViolation[]): boolean {
  return violations.length > 0
}
