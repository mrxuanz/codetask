/**
 * Maps new-core outbox-like events → legacy hub SSE shapes
 * (docs/refactor/fixtures/sse/*). Pure — no DB / EventHub access.
 */

/** Outbox / V3 SseEnvelope-like input (monotonic eventId). */
export type OutboxLikeEvent = {
  readonly eventId: number
  readonly topic: string
  readonly type: string
  readonly entityId: string
  readonly revision: number
  readonly payload?: unknown
}

/** Legacy hub envelope inside SSE `event: hub` data (reconnect.sample.json). */
export type LegacyHubEnvelope = {
  readonly topic: string
  readonly seq: number
  readonly event: string
  readonly data: unknown
}

export type LegacySseWireFrame = {
  readonly sseEventName: 'hub'
  readonly id: number
  readonly data: LegacyHubEnvelope
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hubEventNameForOutboxType(type: string, payload: unknown): string {
  if (type === 'resync' || type === 'resync_required' || type.endsWith('.resync')) {
    return 'resync'
  }
  if (type === 'job.done' || type === 'job.completed') {
    return 'job_done'
  }
  if (type === 'job.error' || type === 'error') {
    return 'error'
  }
  if (type === 'plan_progress' || type === 'job.plan_progress') {
    return 'plan_progress'
  }
  if (type === 'task_progress' || type === 'job.task_progress') {
    return 'task_progress'
  }
  if (type === 'thread_snapshot' || type === 'thread.changed' || type === 'thread.updated') {
    return isRecord(payload) && 'event' in payload && payload.event === 'thread_updated'
      ? 'thread_updated'
      : 'thread_snapshot'
  }
  if (type === 'turn_snapshot' || type === 'turn.changed') {
    return 'turn_snapshot'
  }
  if (type === 'draft_updated' || type === 'draft.changed') {
    return 'draft_updated'
  }
  // Primary control-plane outbox type → job snapshot for renderer reducers.
  if (type === 'job.changed' || type.startsWith('job.')) {
    return 'job_snapshot'
  }
  return type.includes('.') ? type.slice(type.indexOf('.') + 1) : type
}

function mapPayloadForHubEvent(
  hubEvent: string,
  entityId: string,
  payload: unknown
): unknown {
  if (hubEvent === 'resync') {
    const reason =
      isRecord(payload) && typeof payload.reason === 'string' ? payload.reason : 'gap'
    return { reason }
  }
  if (hubEvent === 'job_snapshot' || hubEvent === 'job_done') {
    if (isRecord(payload) && isRecord(payload.job)) {
      return { job: payload.job }
    }
    if (isRecord(payload) && typeof payload.jobId === 'string') {
      return {
        job: {
          id: payload.jobId,
          status: typeof payload.status === 'string' ? payload.status : 'running',
          ...(typeof payload.threadId === 'string' ? { threadId: payload.threadId } : {}),
          ...(typeof payload.projectId === 'string' ? { projectId: payload.projectId } : {})
        }
      }
    }
    return {
      job: {
        id: entityId,
        ...(isRecord(payload) ? payload : {})
      }
    }
  }
  if (hubEvent === 'plan_progress') {
    if (isRecord(payload) && 'planProgress' in payload) return payload
    return { planProgress: payload ?? {} }
  }
  if (hubEvent === 'task_progress') {
    if (isRecord(payload) && 'taskProgress' in payload) return payload
    return { taskProgress: payload ?? {} }
  }
  if (hubEvent === 'thread_snapshot' || hubEvent === 'thread_updated') {
    if (isRecord(payload) && 'thread' in payload) return payload
    return { thread: { id: entityId, ...(isRecord(payload) ? payload : {}) } }
  }
  if (hubEvent === 'turn_snapshot') {
    if (isRecord(payload) && 'turn' in payload) return payload
    return { turn: { id: entityId, ...(isRecord(payload) ? payload : {}) } }
  }
  if (hubEvent === 'draft_updated') {
    if (isRecord(payload) && 'message' in payload) return payload
    return { message: payload ?? {} }
  }
  if (hubEvent === 'error') {
    if (isRecord(payload) && ('message' in payload || 'error' in payload)) return payload
    return { message: typeof payload === 'string' ? payload : 'error' }
  }
  return payload ?? {}
}

/**
 * Map a single outbox-like event to a legacy hub envelope.
 */
export function mapOutboxEventToLegacyHub(event: OutboxLikeEvent): LegacyHubEnvelope {
  const hubEvent = hubEventNameForOutboxType(event.type, event.payload)
  return {
    topic: event.topic,
    seq: event.eventId,
    event: hubEvent,
    data: mapPayloadForHubEvent(hubEvent, event.entityId, event.payload)
  }
}

/**
 * Wire frame for SSE transport: `event: hub` + JSON hub envelope + id = seq.
 */
export function mapOutboxEventToLegacySseFrame(event: OutboxLikeEvent): LegacySseWireFrame {
  const data = mapOutboxEventToLegacyHub(event)
  return {
    sseEventName: 'hub',
    id: data.seq,
    data
  }
}

/** Format a hub frame as an SSE text chunk. */
export function formatLegacyHubSse(frame: LegacySseWireFrame): string {
  return `id: ${frame.id}\nevent: ${frame.sseEventName}\ndata: ${JSON.stringify(frame.data)}\n\n`
}

/**
 * Map gap / resync control onto the legacy `job:resync` sample shape.
 */
export function mapResyncToLegacyHub(input: {
  readonly seq: number
  readonly reason?: string
}): LegacyHubEnvelope {
  return {
    topic: 'job:resync',
    seq: input.seq,
    event: 'resync',
    data: { reason: input.reason ?? 'gap' }
  }
}
