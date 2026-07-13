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

export function formatSseJsonEvent(input: {
  readonly event: string
  readonly data: unknown
  readonly id?: number
}): string {
  const idPrefix = input.id !== undefined ? `id: ${input.id}\n` : ''
  return `${idPrefix}event: ${input.event}\ndata: ${JSON.stringify(input.data)}\n\n`
}

export function formatSseEvent(event: SseEnvelope): string {
  return formatSseJsonEvent({
    id: event.eventId,
    event: event.type,
    data: event
  })
}

export function detectGap(currentRevision: number, incomingRevision: number): boolean {
  return incomingRevision > currentRevision + 1
}
