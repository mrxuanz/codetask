import { authHeaders } from '@renderer/auth/token'
import { throwIfNotSseResponse } from '@renderer/api/sse'
import { ApiError, api } from '@renderer/api/client'
import type { HubEnvelope, HubTopic } from '@shared/contracts/job-event-hub'
import type { JobSseEvent } from '@shared/contracts/sse'
import { parseSseBlock, readSseWithTimeout } from '@shared/sse'

export function putHubSubscriptions(
  connectionId: string,
  topics: HubTopic[]
): Promise<{ data: { connectionId: string; topics: HubTopic[] } }> {
  return api<{ connectionId: string; topics: HubTopic[] }>('/api/realtime/subscriptions', {
    method: 'PUT',
    body: JSON.stringify({ connectionId, topics })
  })
}

/** @deprecated Prefer putHubSubscriptions */
export function putJobHubSubscriptions(
  connectionId: string,
  jobIds: string[]
): Promise<{ data: { connectionId: string; topics: HubTopic[] } }> {
  return putHubSubscriptions(
    connectionId,
    jobIds.map((id) => `job:${id}` as HubTopic)
  )
}

export async function connectHubStream(
  connectionId: string,
  onEnvelope: (envelope: HubEnvelope) => void,
  options?: { signal?: AbortSignal; lastEventId?: number | null }
): Promise<void> {
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'x-hub-connection-id': connectionId
  }
  const auth = authHeaders()
  if (auth && typeof auth === 'object' && !Array.isArray(auth) && 'Authorization' in auth) {
    headers.Authorization = String((auth as Record<string, string>).Authorization)
  }
  if (options?.lastEventId != null && options.lastEventId > 0) {
    headers['Last-Event-ID'] = String(options.lastEventId)
  }

  const url = `/api/realtime/stream?connectionId=${encodeURIComponent(connectionId)}`
  const res = await fetch(url, {
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
      if (parsed.event !== 'hub' && parsed.event !== 'job') continue
      const envelope = JSON.parse(parsed.data) as HubEnvelope
      if (parsed.id && envelope.seq == null) {
        envelope.seq = Number.parseInt(parsed.id, 10)
      }
      onEnvelope(envelope)
    }
  }
}

/** @deprecated Prefer connectHubStream */
export async function connectJobHubStream(
  onEnvelope: (envelope: HubEnvelope) => void,
  options?: { signal?: AbortSignal; connectionId?: string; lastEventId?: number | null }
): Promise<void> {
  const connectionId =
    options?.connectionId ?? `conn-${Math.random().toString(36).slice(2, 10)}`
  return connectHubStream(connectionId, onEnvelope, options)
}

export type { JobSseEvent, HubEnvelope, HubTopic }
