export interface ApiError {
  readonly code: string
  readonly message: string
  readonly details?: Record<string, unknown>
}

export function badRequest(code: string, message: string): ApiError {
  return { code, message }
}

export function notFound(message: string): ApiError {
  return { code: 'job.not_found', message }
}

export function conflict(code: string, message: string, details?: Record<string, unknown>): ApiError {
  return { code, message, details }
}

export function tooManyRequests(message: string): ApiError {
  return { code: 'app_draining', message }
}
