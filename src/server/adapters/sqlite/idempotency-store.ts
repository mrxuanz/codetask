import type { IdempotencyRecord, IdempotencyStore } from '../../core/application/idempotency'
import type { SqliteDatabase } from './migrate-core'

type IdempotencyRow = {
  key: string
  payload_hash: string
  result_json: string
  created_at_ms: number
}

/**
 * Persistent idempotency store backed by `core_idempotency`.
 */
export class SqliteIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: SqliteDatabase) {}

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT key, payload_hash, result_json, created_at_ms
         FROM core_idempotency WHERE key = ?`
      )
      .get(key) as IdempotencyRow | undefined
    if (!row) return undefined
    return {
      payloadHash: row.payload_hash,
      resultJson: row.result_json
    }
  }

  async put(key: string, record: IdempotencyRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO core_idempotency(key, payload_hash, result_json, created_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           payload_hash = excluded.payload_hash,
           result_json = excluded.result_json`
      )
      .run(key, record.payloadHash, record.resultJson, Date.now())
  }
}
