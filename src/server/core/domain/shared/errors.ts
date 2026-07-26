/**
 * Base domain error. Aggregate-specific errors may extend this or mirror the
 * `{ code, message, details? }` shape for stable business error codes.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message?: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message ?? code)
    this.name = 'DomainError'
  }
}

export type DomainResult<T, E = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }
