/**
 * Idempotency helpers for command handlers (重构.md §6).
 * Same key + same payload hash → replay; same key + different hash → conflict.
 */

export class IdempotencyConflictError extends Error {
  readonly code = 'idempotency.conflict' as const
  readonly key: string

  constructor(key: string, message?: string) {
    super(message ?? `Idempotency key reused with different payload: ${key}`)
    this.name = 'IdempotencyConflictError'
    this.key = key
  }
}

export interface IdempotencyRecord {
  readonly payloadHash: string
  readonly resultJson: string
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | undefined>
  put(key: string, record: IdempotencyRecord): Promise<void>
}

/**
 * Throws {@link IdempotencyConflictError} when `key` was already used with a
 * different payload hash. No-op when there is no prior record or hashes match.
 */
export function assertIdempotency(
  existingPayloadHash: string | null | undefined,
  newPayloadHash: string,
  key: string
): void {
  if (existingPayloadHash == null || existingPayloadHash === '') {
    return
  }
  if (existingPayloadHash === newPayloadHash) {
    return
  }
  throw new IdempotencyConflictError(key)
}
