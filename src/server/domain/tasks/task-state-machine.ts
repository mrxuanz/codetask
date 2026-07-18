export type TaskState = 'queued' | 'running' | 'completed' | 'blocked' | 'failed' | 'skipped'

export interface TaskTransition {
  readonly nextState: TaskState
}

export interface TaskTransitionError {
  readonly code: 'task.action_not_allowed'
  readonly state: TaskState
  readonly command: string
}

export type DomainResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export function startTask(state: TaskState): DomainResult<TaskTransition, TaskTransitionError> {
  if (state === 'queued') {
    return { ok: true, value: { nextState: 'running' } }
  }
  return { ok: false, error: { code: 'task.action_not_allowed', state, command: 'start' } }
}

export function completeTask(state: TaskState): DomainResult<TaskTransition, TaskTransitionError> {
  if (state === 'running') {
    return { ok: true, value: { nextState: 'completed' } }
  }
  return { ok: false, error: { code: 'task.action_not_allowed', state, command: 'complete' } }
}

export function failTask(state: TaskState): DomainResult<TaskTransition, TaskTransitionError> {
  if (state === 'running') {
    return { ok: true, value: { nextState: 'failed' } }
  }
  return { ok: false, error: { code: 'task.action_not_allowed', state, command: 'fail' } }
}

export function blockTask(state: TaskState): DomainResult<TaskTransition, TaskTransitionError> {
  if (state === 'running') {
    return { ok: true, value: { nextState: 'blocked' } }
  }
  return { ok: false, error: { code: 'task.action_not_allowed', state, command: 'block' } }
}

export function skipTask(state: TaskState): DomainResult<TaskTransition, TaskTransitionError> {
  if (state === 'queued' || state === 'blocked') {
    return { ok: true, value: { nextState: 'skipped' } }
  }
  return { ok: false, error: { code: 'task.action_not_allowed', state, command: 'skip' } }
}

export function requeueTask(state: TaskState): DomainResult<TaskTransition, TaskTransitionError> {
  if (state === 'running' || state === 'blocked' || state === 'failed') {
    return { ok: true, value: { nextState: 'queued' } }
  }
  return { ok: false, error: { code: 'task.action_not_allowed', state, command: 'requeue' } }
}
