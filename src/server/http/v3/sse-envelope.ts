import { Type, type Static } from '@sinclair/typebox'

export const SseEnvelopeSchema = Type.Object(
  {
    eventId: Type.Integer({ minimum: 1 }),
    topic: Type.String({ minLength: 1, maxLength: 256 }),
    type: Type.String({ minLength: 1, maxLength: 128 }),
    entityId: Type.String({ minLength: 1, maxLength: 128 }),
    revision: Type.Integer({ minimum: 1 }),
    payload: Type.Unknown()
  },
  { additionalProperties: false }
)

export type SseEnvelope = Static<typeof SseEnvelopeSchema>

export interface DurableCursor {
  readonly lastEventId: number
  readonly timestamp: number
}

export interface SseConnection {
  readonly connectionId: string
  send(event: SseEnvelope): void
  close(): void
}

export function formatSseEvent(event: SseEnvelope): string {
  return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

export function detectGap(currentRevision: number, incomingRevision: number): boolean {
  return incomingRevision > currentRevision + 1
}
