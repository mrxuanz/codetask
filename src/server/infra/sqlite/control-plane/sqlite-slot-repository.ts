import { eq, and, sql } from 'drizzle-orm'
import type { ResourceSlotRepository } from '../../../application/ports/resource-slot-repository'
import type { DbExecutor } from './db-executor'
import { controlResourceSlots } from './schema'

export class SqliteResourceSlotRepository implements ResourceSlotRepository {
  constructor(private readonly db: DbExecutor) {}

  createSlot(input: Parameters<ResourceSlotRepository['createSlot']>[0]): void {
    this.db
      .insert(controlResourceSlots)
      .values({
        id: input.id,
        jobId: input.jobId,
        runId: input.runId,
        pool: input.pool,
        state: 'active',
        createdAtMs: input.createdAtMs
      })
      .run()
  }

  releaseSlot(input: { readonly runId: string; readonly releasedAtMs: number }): void {
    this.db
      .update(controlResourceSlots)
      .set({
        state: 'released',
        releasedAtMs: input.releasedAtMs
      })
      .where(
        and(eq(controlResourceSlots.runId, input.runId), sql`${controlResourceSlots.state} != 'released'`)
      )
      .run()
  }

  countActiveSlots(pool: string): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(controlResourceSlots)
      .where(and(eq(controlResourceSlots.pool, pool), eq(controlResourceSlots.state, 'active')))
      .get()
    return row?.count ?? 0
  }

  hasActiveSlotForRun(runId: string): boolean {
    const row = this.db
      .select({ id: controlResourceSlots.id })
      .from(controlResourceSlots)
      .where(and(eq(controlResourceSlots.runId, runId), eq(controlResourceSlots.state, 'active')))
      .get()
    return row !== undefined
  }

  assertCapacityAvailable(pool: string, maxConcurrentJobs: number): void {
    if (this.countActiveSlots(pool) >= maxConcurrentJobs) {
      throw new Error('slot.capacity_exhausted')
    }
  }
}
