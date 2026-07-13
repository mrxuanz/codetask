import type { JobAggregate } from '@shared/contracts/control-plane'
import { isTerminal, isRunning, isQueued } from '@shared/contracts/control-plane'

export type InvariantViolation = {
  readonly code: string
  readonly detail: string
}

export interface ActiveRunSummary {
  readonly id: string
  readonly state: string
  readonly fenceToken: string
  readonly executionGeneration: number
  readonly currentRuntimeInstanceId: string | null
  readonly pendingAttemptId: string | null
  readonly lifecycleOperationId: string | null
}

export function validateJobInvariant(
  job: JobAggregate,
  activeRun: ActiveRunSummary | null
): readonly InvariantViolation[] {
  const violations: InvariantViolation[] = []

  if (job.state === 'pausing') {
    if (job.controlIntent !== 'pause') {
      violations.push({ code: 'job.pausing_without_intent', detail: job.id })
    }
    if (job.resumeTarget === null) {
      violations.push({ code: 'job.pausing_without_resume_target', detail: job.id })
    }
    if (activeRun === null || job.activeRunId !== activeRun.id) {
      violations.push({ code: 'job.pausing_without_active_run', detail: job.id })
    }
  }

  if (job.state === 'paused') {
    if (job.controlIntent !== 'none' || job.activeRunId !== null || job.resumeTarget === null) {
      violations.push({ code: 'job.invalid_paused_shape', detail: job.id })
    }
  }

  if (isTerminal(job.state)) {
    if (job.activeRunId !== null || job.controlIntent !== 'none') {
      violations.push({ code: 'job.terminal_has_control_state', detail: job.id })
    }
  }

  if (isRunning(job.state)) {
    if (job.activeRunId === null) {
      violations.push({ code: 'job.running_without_active_run', detail: job.id })
    }
    if (activeRun === null || job.activeRunId !== activeRun.id) {
      violations.push({ code: 'job.running_without_matching_run', detail: job.id })
    }
  }

  if (isQueued(job.state)) {
    if (job.activeRunId !== null) {
      violations.push({ code: 'job.queued_has_active_run', detail: job.id })
    }
  }

  return violations
}
