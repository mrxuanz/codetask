import type { JobAggregate, JobState, ControlIntent, ResumeTarget } from '@shared/contracts/control-plane'

export type JobTransition = {
  readonly nextState: JobState
  readonly controlIntent: ControlIntent
  readonly resumeTarget: ResumeTarget | null
  readonly clearActiveRun: boolean
}

export type TransitionError = {
  readonly code: 'job.action_not_allowed' | 'job.invalid_resume_target'
  readonly state: JobState
  readonly command: string
}

export type DomainResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export function requestPause(job: JobAggregate): DomainResult<JobTransition, TransitionError> {
  if (job.state === 'planning_queued') {
    return {
      ok: true,
      value: {
        nextState: 'paused',
        controlIntent: 'none',
        resumeTarget: 'planning_queued',
        clearActiveRun: true
      }
    }
  }
  if (job.state === 'execution_queued') {
    return {
      ok: true,
      value: {
        nextState: 'paused',
        controlIntent: 'none',
        resumeTarget: 'execution_queued',
        clearActiveRun: true
      }
    }
  }
  if (job.state === 'planning_running' || job.state === 'execution_running') {
    return {
      ok: true,
      value: {
        nextState: 'pausing',
        controlIntent: 'pause',
        resumeTarget:
          job.state === 'planning_running' ? 'planning_queued' : 'execution_queued',
        clearActiveRun: false
      }
    }
  }
  return {
    ok: false,
    error: { code: 'job.action_not_allowed', state: job.state, command: 'request_pause' }
  }
}

export function continueJob(job: JobAggregate): DomainResult<JobTransition, TransitionError> {
  if (job.state === 'paused') {
    if (job.resumeTarget === null) {
      return {
        ok: false,
        error: { code: 'job.invalid_resume_target', state: job.state, command: 'continue' }
      }
    }
    return {
      ok: true,
      value: {
        nextState: job.resumeTarget,
        controlIntent: 'none',
        resumeTarget: null,
        clearActiveRun: true
      }
    }
  }
  if (job.state === 'failed') {
    return {
      ok: true,
      value: {
        nextState: 'execution_queued',
        controlIntent: 'none',
        resumeTarget: null,
        clearActiveRun: true
      }
    }
  }
  return {
    ok: false,
    error: { code: 'job.action_not_allowed', state: job.state, command: 'continue' }
  }
}

export function cancelJob(job: JobAggregate): DomainResult<JobTransition, TransitionError> {
  if (
    job.state === 'planning_queued' ||
    job.state === 'planning_running' ||
    job.state === 'plan_review' ||
    job.state === 'execution_queued' ||
    job.state === 'execution_running' ||
    job.state === 'paused' ||
    job.state === 'failed'
  ) {
    return {
      ok: true,
      value: {
        nextState: 'cancelled',
        controlIntent: 'none',
        resumeTarget: null,
        clearActiveRun: true
      }
    }
  }
  return {
    ok: false,
    error: { code: 'job.action_not_allowed', state: job.state, command: 'cancel' }
  }
}

export function restartExecution(job: JobAggregate): DomainResult<JobTransition, TransitionError> {
  if (job.state === 'failed') {
    return {
      ok: true,
      value: {
        nextState: 'execution_queued',
        controlIntent: 'none',
        resumeTarget: null,
        clearActiveRun: true
      }
    }
  }
  if (job.state === 'cancelled') {
    return {
      ok: true,
      value: {
        nextState: 'execution_queued',
        controlIntent: 'none',
        resumeTarget: null,
        clearActiveRun: true
      }
    }
  }
  return {
    ok: false,
    error: { code: 'job.action_not_allowed', state: job.state, command: 'restart_execution' }
  }
}

export function confirmPlan(job: JobAggregate): DomainResult<JobTransition, TransitionError> {
  if (job.state === 'plan_review') {
    return {
      ok: true,
      value: {
        nextState: 'execution_queued',
        controlIntent: 'none',
        resumeTarget: null,
        clearActiveRun: true
      }
    }
  }
  return {
    ok: false,
    error: { code: 'job.action_not_allowed', state: job.state, command: 'confirm_plan' }
  }
}

export function replan(job: JobAggregate): DomainResult<JobTransition, TransitionError> {
  if (job.state === 'plan_review') {
    return {
      ok: true,
      value: {
        nextState: 'planning_queued',
        controlIntent: 'none',
        resumeTarget: null,
        clearActiveRun: true
      }
    }
  }
  return {
    ok: false,
    error: { code: 'job.action_not_allowed', state: job.state, command: 'replan' }
  }
}
