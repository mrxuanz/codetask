export type JobErrorCode =
  | 'job.illegal_transition'
  | 'job.already_terminal'
  | 'job.invalid_status'

export class JobDomainError extends Error {
  readonly code: JobErrorCode
  readonly status: string
  readonly command: string

  constructor(code: JobErrorCode, status: string, command: string, message?: string) {
    super(message ?? `${code}: cannot ${command} from status=${status}`)
    this.name = 'JobDomainError'
    this.code = code
    this.status = status
    this.command = command
  }
}

export function illegalJobTransition(status: string, command: string): JobDomainError {
  return new JobDomainError('job.illegal_transition', status, command)
}
