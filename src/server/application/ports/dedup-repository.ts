export interface DedupLookup {
  readonly actorUsername: string
  readonly commandType: string
  readonly idempotencyKey: string
}

export interface StoredCommandResult {
  readonly responseJson: string
  readonly responseRevision: number
  readonly requestHash: string
}

export interface StoreDedupInput {
  readonly actorUsername: string
  readonly commandType: string
  readonly idempotencyKey: string
  readonly requestHash: string
  readonly response: unknown
  readonly responseRevision: number
  readonly createdAtMs: number
  readonly expiresAtMs: number
}

export interface DedupRepository {
  getDedup(input: DedupLookup): StoredCommandResult | null

  storeDedup(input: StoreDedupInput): void
}
