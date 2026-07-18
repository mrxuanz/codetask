import { and, sql, type SQL } from 'drizzle-orm'
import type { OutboxRepository } from '../../../application/ports/outbox-repository'
import type { ActorContext } from '../../../application/ports/job-repository'
import type { DbExecutor } from './db-executor'
import { controlJobs, controlOutboxEvents } from './schema'
import { projects, threads } from '../../../db/schema'

export class SqliteOutboxRepository implements OutboxRepository {
  constructor(private readonly db: DbExecutor) {}

  appendOutbox(input: Parameters<OutboxRepository['appendOutbox']>[0]): number {
    const payloadJson = JSON.stringify(input.payload)
    const result = this.db
      .insert(controlOutboxEvents)
      .values({
        topic: input.topic,
        eventType: input.eventType,
        entityId: input.entityId,
        aggregateRevision: input.aggregateRevision,
        payloadJson,
        payloadBytes: payloadJson.length,
        createdAtMs: input.createdAtMs
      })
      .run()

    return result.lastInsertRowid as number
  }

  getUndispatchedEvents(batchSize: number): ReturnType<OutboxRepository['getUndispatchedEvents']> {
    return this.db
      .select({
        eventId: controlOutboxEvents.eventId,
        topic: controlOutboxEvents.topic,
        eventType: controlOutboxEvents.eventType,
        entityId: controlOutboxEvents.entityId,
        aggregateRevision: controlOutboxEvents.aggregateRevision,
        payloadJson: controlOutboxEvents.payloadJson
      })
      .from(controlOutboxEvents)
      .where(sql`${controlOutboxEvents.dispatchedAtMs} IS NULL`)
      .orderBy(controlOutboxEvents.eventId)
      .limit(batchSize)
      .all()
  }

  listOwnedOutboxEvents(input: {
    readonly actor: ActorContext
    readonly afterEventId: number
    readonly limit: number
  }): ReturnType<OutboxRepository['listOwnedOutboxEvents']> {
    const predicates: SQL[] = [sql`${controlOutboxEvents.eventId} > ${input.afterEventId}`]
    predicates.push(sql`EXISTS (
      SELECT 1 FROM ${controlJobs}
      INNER JOIN ${threads} ON ${threads.id} = ${controlJobs.threadId}
      INNER JOIN ${projects} ON ${projects.id} = ${threads.projectId}
      WHERE ${controlJobs.id} = ${controlOutboxEvents.entityId}
        AND ${projects.id} = ${controlJobs.projectId}
        AND ${projects.username} = ${input.actor.username}
    )`)

    return this.db
      .select({
        eventId: controlOutboxEvents.eventId,
        topic: controlOutboxEvents.topic,
        eventType: controlOutboxEvents.eventType,
        entityId: controlOutboxEvents.entityId,
        aggregateRevision: controlOutboxEvents.aggregateRevision,
        payloadJson: controlOutboxEvents.payloadJson
      })
      .from(controlOutboxEvents)
      .where(and(...predicates))
      .orderBy(controlOutboxEvents.eventId)
      .limit(input.limit)
      .all()
  }

  getOwnedOutboxLatestEventId(input: { readonly actor: ActorContext }): number {
    const predicates: SQL[] = []
    predicates.push(sql`EXISTS (
      SELECT 1 FROM ${controlJobs}
      INNER JOIN ${threads} ON ${threads.id} = ${controlJobs.threadId}
      INNER JOIN ${projects} ON ${projects.id} = ${threads.projectId}
      WHERE ${controlJobs.id} = ${controlOutboxEvents.entityId}
        AND ${projects.id} = ${controlJobs.projectId}
        AND ${projects.username} = ${input.actor.username}
    )`)

    const query = this.db
      .select({
        eventId: sql<number>`COALESCE(MAX(${controlOutboxEvents.eventId}), 0)`
      })
      .from(controlOutboxEvents)

    const result =
      predicates.length > 0 ? query.where(and(...predicates)).get() : query.get()

    return result?.eventId ?? 0
  }

  markDispatched(input: { readonly eventIds: readonly number[]; readonly dispatchedAtMs: number }): void {
    if (input.eventIds.length === 0) return
    this.db
      .update(controlOutboxEvents)
      .set({ dispatchedAtMs: input.dispatchedAtMs })
      .where(
        sql`${controlOutboxEvents.eventId} IN (${sql.join(input.eventIds.map((id) => sql`${id}`), sql`, `)})`
      )
      .run()
  }
}
