import type {
  JobState,
  ControlIntent,
  ResumeTarget
} from '../../../shared/contracts/control-plane/primitives'
import type { TransitionError, TransitionCommand, DomainResult } from './job-errors'

export interface JobAggregate {
  readonly id: string
  readonly threadId: string
  readonly projectId: string
  readonly state: JobState
  readonly stateRevision: number
  readonly controlIntent: ControlIntent
  readonly resumeTarget: ResumeTarget | null
  readonly currentPlanRevision: number | null
  readonly executionGeneration: number
  readonly activeRunId: string | null
  readonly lastFailureId: string | null
}

export type JobTransition = {
  readonly nextState: JobState
  readonly controlIntent: ControlIntent
  readonly resumeTarget: ResumeTarget | null
  readonly clearActiveRun: boolean
}

function error(
  code: TransitionError['code'],
  state: JobState,
  command: TransitionCommand
): DomainResult<JobTransition, TransitionError> {
  return { ok: false, error: { code, state, command } }
}

function success(
  transition: JobTransition
): DomainResult<JobTransition, TransitionError> {
  return { ok: true, value: transition }
}

export function requestPause(
  job: JobAggregate
): DomainResult<JobTransition, TransitionError> {
  if (job.state === 'planning_queued') {
    return success({
      nextState: 'paused',
      controlIntent: 'none',
      resumeTarget: 'planning_queued',
      clearActiveRun: true
    })
  }
  if (job.state === 'execution_queued') {
    return success({
      nextState: 'paused',
      controlIntent: 'none',
      resumeTarget: 'execution_queued',
      clearActiveRun: true
    })
  }
  if (job.state === 'planning_running' || job.state === 'execution_running') {
    return success({
      nextState: 'pausing',
      controlIntent: 'pause',
      resumeTarget: job.state === 'planning_running' ? 'planning_queued' : 'execution_queued',
      clearActiveRun: false
    })
  }
  return error('job.action_not_allowed', job.state, 'pause')
}

export function continueJob(
  job: JobAggregate
): DomainResult<JobTransition, TransitionError> {
  if (job.state === 'paused') {
    if (job.resumeTarget === null) {
      return error('job.invalid_resume_target', job.state, 'continue')
    }
    return success({
      nextState: job.resumeTarget,
      controlIntent: 'none',
      resumeTarget: null,
      clearActiveRun: true
    })
  }
  if (job.state === 'failed') {
    const resumeTarget: ResumeTarget = job.resumeTarget ?? 'execution_queued'
    return success({
      nextState: resumeTarget,
      controlIntent: 'none',
      resumeTarget: null,
      clearActiveRun: true
    })
  }
  return error('job.action_not_allowed', job.state, 'continue')
}

export function cancelJob(
  job: JobAggregate
): DomainResult<JobTransition, TransitionError> {
  switch (job.state) {
    case 'planning_queued':
    case 'planning_running':
    case 'plan_review':
    case 'execution_queued':
    case 'execution_running':
    case 'paused':
      return success({
        nextState: 'cancelled',
        controlIntent: 'none',
        resumeTarget: null,
        clearActiveRun: true
      })
    case 'pausing':
    case 'applying_changes':
    case 'succeeded':
    case 'failed':
    case 'cancelled':
      return error('job.action_not_allowed', job.state, 'cancel')
  }
}

export function restartExecution(
  job: JobAggregate
): DomainResult<JobTransition, TransitionError> {
  if (job.state === 'failed') {
    return success({
      nextState: 'execution_queued',
      controlIntent: 'none',
      resumeTarget: null,
      clearActiveRun: true
    })
  }
  if (job.state === 'cancelled' && job.currentPlanRevision !== null) {
    return success({
      nextState: 'execution_queued',
      controlIntent: 'none',
      resumeTarget: null,
      clearActiveRun: true
    })
  }
  return error('job.action_not_allowed', job.state, 'restart_execution')
}

export function acknowledgePause(
  job: JobAggregate
): DomainResult<JobTransition, TransitionError> {
  if (job.state === 'pausing' && job.controlIntent === 'pause') {
    return success({
      nextState: 'paused',
      controlIntent: 'none',
      resumeTarget: job.resumeTarget,
      clearActiveRun: true
    })
  }
  return error('job.action_not_allowed', job.state, 'acknowledge_pause')
}

export function confirmPlan(
  job: JobAggregate
): DomainResult<JobTransition, TransitionError> {
  if (job.state === 'plan_review') {
    return success({
      nextState: 'execution_queued',
      controlIntent: 'none',
      resumeTarget: null,
      clearActiveRun: true
    })
  }
  return error('job.action_not_allowed', job.state, 'confirm_plan')
}

export function editPlan(
  job: JobAggregate
): DomainResult<JobTransition, TransitionError> {
  if (job.state === 'plan_review') {
    return success({
      nextState: 'plan_review',
      controlIntent: 'none',
      resumeTarget: null,
      clearActiveRun: false
    })
  }
  return error('job.action_not_allowed', job.state, 'edit_plan')
}

export function deleteJob(
  job: JobAggregate
): DomainResult<JobTransition, TransitionError> {
  switch (job.state) {
    case 'succeeded':
    case 'failed':
    case 'cancelled':
      return success({
        nextState: job.state,
        controlIntent: 'none',
        resumeTarget: null,
        clearActiveRun: false
      })
    case 'planning_queued':
    case 'planning_running':
    case 'plan_review':
    case 'execution_queued':
    case 'execution_running':
    case 'pausing':
    case 'paused':
    case 'applying_changes':
      return error('job.action_not_allowed', job.state, 'delete')
  }
}
