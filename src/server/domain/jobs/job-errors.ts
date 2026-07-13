import type { JobState, JobAction, JobCommandType } from '../../../shared/contracts/control-plane/primitives'

export type TransitionCommand = JobAction | Extract<JobCommandType, 'acknowledge_pause'>

export type TransitionError = {
  readonly code: 'job.action_not_allowed' | 'job.invalid_resume_target'
  readonly state: JobState
  readonly command: TransitionCommand
}

export type DomainResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }
