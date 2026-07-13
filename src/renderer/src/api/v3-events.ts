import { Value } from '@sinclair/typebox/value'
import { parseSseBlock, readSseWithTimeout } from '@shared/sse'
import {
  JobChangedEventSchema,
  ResyncRequiredEventSchema,
  type ResyncRequiredEvent,
  type ResyncRequiredReason,
  type ChangedField,
  type JobChangedEvent
} from '@shared/contracts/control-plane'

export interface ControlPlaneJobChangedEnvelope {
  readonly eventId: number
  readonly topic: string
  readonly type: 'job.changed'
  readonly entityId: string
  readonly revision: number
  readonly payload: JobChangedEvent
  readonly changed: readonly ChangedField[]
}

export class ControlPlaneEventsResyncRequiredError extends Error {
  readonly reason: ResyncRequiredReason
  readonly restartFromEventId: number

  constructor(input: ResyncRequiredEvent) {
    super(`Control-plane stream requires resync: ${input.reason}`)
    this.name = 'ControlPlaneEventsResyncRequiredError'
    this.reason = input.reason
    this.restartFromEventId = input.restartFromEventId
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function parseControlPlaneJobChangedEnvelope(
  input: unknown
): ControlPlaneJobChangedEnvelope | null {
  if (input === null || typeof input !== 'object') {
    return null
  }

  const raw = input as Record<string, unknown>
  if (
    !isPositiveInteger(raw.eventId) ||
    !isNonEmptyString(raw.topic) ||
    raw.type !== 'job.changed' ||
    !isNonEmptyString(raw.entityId) ||
    !isPositiveInteger(raw.revision)
  ) {
    return null
  }

  const payload = raw.payload
  if (!Value.Check(JobChangedEventSchema, payload)) {
    return null
  }

  if (
    payload.eventId !== raw.eventId ||
    payload.topic !== raw.topic ||
    payload.type !== raw.type ||
    payload.entityId !== raw.entityId ||
    payload.revision !== raw.revision
  ) {
    return null
  }

  return {
    eventId: raw.eventId,
    topic: raw.topic,
    type: 'job.changed',
    entityId: raw.entityId,
    revision: raw.revision,
    payload,
    changed: payload.changed
  }
}

export function parseControlPlaneResyncRequiredEvent(input: unknown): ResyncRequiredEvent | null {
  return Value.Check(ResyncRequiredEventSchema, input) ? (input as ResyncRequiredEvent) : null
}

export async function connectControlPlaneEventsStream(
  onEvent: (event: ControlPlaneJobChangedEnvelope) => void,
  options?: { signal?: AbortSignal; lastEventId?: number | null }
): Promise<void> {
  const [{ authHeaders }, { ApiError }, { throwIfNotSseResponse }] = await Promise.all([
    import('../auth/token'),
    import('./client'),
    import('./sse')
  ])

  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    ...authHeaders()
  }
  if (options?.lastEventId != null && options.lastEventId > 0) {
    headers['Last-Event-ID'] = String(options.lastEventId)
  }

  const res = await fetch('/api/v3/events', {
    headers,
    signal: options?.signal
  })

  await throwIfNotSseResponse(res)

  const reader = res.body?.getReader()
  if (!reader) throw new ApiError('SSE 响应无 body', res.status, null)

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await readSseWithTimeout(reader)
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      const parsed = parseSseBlock(part)
      if (!parsed) continue
      let body: unknown
      try {
        body = JSON.parse(parsed.data)
      } catch {
        throw new ApiError('Invalid control-plane SSE payload', res.status, { raw: parsed.data })
      }

      if (parsed.event === 'resync_required') {
        const resync = parseControlPlaneResyncRequiredEvent(body)
        if (resync === null) {
          throw new ApiError('Invalid control-plane resync payload', res.status, body)
        }
        throw new ControlPlaneEventsResyncRequiredError(resync)
      }

      if (parsed.event !== 'job.changed') continue

      const envelope = parseControlPlaneJobChangedEnvelope(body)
      if (envelope === null) {
        throw new ApiError('Invalid control-plane SSE envelope', res.status, body)
      }

      onEvent(envelope)
    }
  }
}
