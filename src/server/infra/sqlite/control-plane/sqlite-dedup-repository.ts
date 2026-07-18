import { eq, and } from 'drizzle-orm'
import type { DedupRepository } from '../../../application/ports/dedup-repository'
import type { DbExecutor } from './db-executor'
import { controlCommandDedup } from './schema'

export class SqliteDedupRepository implements DedupRepository {
  constructor(private readonly db: DbExecutor) {}

  getDedup(input: Parameters<DedupRepository['getDedup']>[0]): ReturnType<DedupRepository['getDedup']> {
    const result = this.db
      .select({
        responseJson: controlCommandDedup.responseJson,
        responseRevision: controlCommandDedup.responseRevision,
        requestHash: controlCommandDedup.requestHash
      })
      .from(controlCommandDedup)
      .where(
        and(
          eq(controlCommandDedup.actorUsername, input.actorUsername),
          eq(controlCommandDedup.commandType, input.commandType),
          eq(controlCommandDedup.idempotencyKey, input.idempotencyKey)
        )
      )
      .get()

    return result ?? null
  }

  storeDedup(input: Parameters<DedupRepository['storeDedup']>[0]): void {
    const responseJson = JSON.stringify(input.response)
    this.db
      .insert(controlCommandDedup)
      .values({
        actorUsername: input.actorUsername,
        commandType: input.commandType,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        responseJson,
        responseRevision: input.responseRevision,
        createdAtMs: input.createdAtMs,
        expiresAtMs: input.expiresAtMs
      })
      .run()
  }
}
