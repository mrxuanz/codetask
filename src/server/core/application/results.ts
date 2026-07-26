export type ApplicationError = {
  readonly code: string
  readonly message: string
}

export type CommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApplicationError }

export type QueryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApplicationError }

export function ok<T>(value: T): CommandResult<T> {
  return { ok: true, value }
}

export function fail<T = never>(code: string, message: string): CommandResult<T> {
  return { ok: false, error: { code, message } }
}
