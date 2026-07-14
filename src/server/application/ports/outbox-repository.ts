import type { ActorContext } from './job-repository'

export interface AppendOutboxInput {
  readonly topic: string
  readonly eventType: string
  readonly entityId: string
  readonly aggregateRevision: number
  readonly payload: unknown
  readonly createdAtMs: number
}

export interface OutboxEvent {
  readonly eventId: number
  readonly topic: string
  readonly eventType: string
  readonly entityId: string
  readonly aggregateRevision: number
  readonly payloadJson: string
}

export interface OutboxRepository {
  appendOutbox(input: AppendOutboxInput): number

  getUndispatchedEvents(batchSize: number): readonly OutboxEvent[]

  listOwnedOutboxEvents(input: {
    readonly actor: ActorContext
    readonly afterEventId: number
    readonly limit: number
  }): readonly OutboxEvent[]

  getOwnedOutboxLatestEventId(input: { readonly actor: ActorContext }): number

  markDispatched(input: { readonly eventIds: readonly number[]; readonly dispatchedAtMs: number }): void
}
