import { randomUUID } from 'node:crypto'
import type {
  DurableRealtimeEnvelope,
  EphemeralRealtimeEnvelope,
  RealtimeEnvelope,
  RealtimeTopic
} from '@codetask/contracts'
import type { RealtimeEventLog } from './event-log.ts'
import type { LiveFanout } from './live-fanout.ts'

export type PublishDurableInput = {
  actorId: string
  sourceModule: string
  /** When omitted, a synthetic id is generated (Settings / direct publish). */
  sourceOutboxId?: string
  topic: RealtimeTopic | string
  type: string
  entityId: string
  entityRevision: number
  payload: unknown
  occurredAt?: number
}

export type PublishEphemeralInput = {
  actorId: string
  topic: RealtimeTopic | string
  type: string
  entityId: string
  payload: unknown
  occurredAt?: number
}

/**
 * Idempotent bridge: module outbox → realtime_events → live fanout.
 */
export class RealtimeDispatcher {
  constructor(
    private readonly log: RealtimeEventLog,
    private readonly fanout: LiveFanout
  ) {}

  publishDurable(input: PublishDurableInput): DurableRealtimeEnvelope {
    const envelope = this.log.append({
      actorId: input.actorId,
      sourceModule: input.sourceModule,
      sourceOutboxId: input.sourceOutboxId ?? `direct:${randomUUID()}`,
      topic: input.topic,
      eventType: input.type,
      entityId: input.entityId,
      entityRevision: input.entityRevision,
      payload: input.payload,
      occurredAt: input.occurredAt
    })
    this.fanout.publish(input.actorId, envelope)
    return envelope
  }

  publishEphemeral(input: PublishEphemeralInput): EphemeralRealtimeEnvelope {
    const envelope: EphemeralRealtimeEnvelope = {
      eventId: null,
      ephemeral: true,
      topic: input.topic,
      type: input.type,
      entityId: input.entityId,
      occurredAt: input.occurredAt ?? Date.now(),
      payload: input.payload
    }
    this.fanout.publish(input.actorId, envelope)
    return envelope
  }

  /** Convenience: durable for terminal/state, ephemeral for deltas. */
  publish(input: PublishDurableInput & { ephemeral?: boolean }): RealtimeEnvelope {
    if (input.ephemeral) {
      return this.publishEphemeral(input)
    }
    return this.publishDurable(input)
  }
}
