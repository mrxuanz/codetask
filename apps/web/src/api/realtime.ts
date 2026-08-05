import { api, ApiError } from '@renderer/api/client'
import type { ApiSuccess } from '@renderer/api/types'
import { throwIfNotSseResponse } from '@renderer/api/sse'
import { parseSseBlock, readSseWithTimeout } from '@codetask/contracts/sse'
import {
  REALTIME_CONNECTION_ID_HEADER,
  RealtimeEnvelopeSchema,
  type RealtimeEnvelope,
  type RealtimeTopic
} from '@codetask/contracts'
import { Value } from '@sinclair/typebox/value'
import { authHeaders } from '@renderer/auth/token'

/** Idle slightly above server 25s heartbeat (06 §11). */
export const REALTIME_IDLE_TIMEOUT_MS = 60_000

export function putRealtimeSubscriptions(
  connectionId: string,
  topics: RealtimeTopic[]
): Promise<ApiSuccess<{ connectionId: string; topics: RealtimeTopic[] }>> {
  return api<{ connectionId: string; topics: RealtimeTopic[] }>('/api/realtime/subscriptions', {
    method: 'PUT',
    headers: {
      [REALTIME_CONNECTION_ID_HEADER]: connectionId
    },
    body: JSON.stringify({ topics })
  })
}

function authorizationHeader(): string | null {
  const headers = authHeaders()
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null
  if (!('Authorization' in headers)) return null
  const value = Reflect.get(headers, 'Authorization')
  return typeof value === 'string' && value.length > 0 ? value : null
}

export async function connectRealtimeStream(
  connectionId: string,
  onEnvelope: (envelope: RealtimeEnvelope) => void,
  options?: { signal?: AbortSignal; lastEventId?: number | null }
): Promise<void> {
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    [REALTIME_CONNECTION_ID_HEADER]: connectionId
  }
  const authorization = authorizationHeader()
  if (authorization) headers.Authorization = authorization
  if (options?.lastEventId != null && options.lastEventId > 0) {
    headers['Last-Event-ID'] = String(options.lastEventId)
  }

  const res = await fetch('/api/realtime/stream', {
    headers,
    credentials: 'same-origin',
    signal: options?.signal
  })

  if (res.status === 401) {
    throw new ApiError('Unauthorized', 401, null, 'auth.unauthorized')
  }

  await throwIfNotSseResponse(res)

  const reader = res.body?.getReader()
  if (!reader) throw new ApiError('SSE 响应无 body', res.status, null)

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await readSseWithTimeout(reader, REALTIME_IDLE_TIMEOUT_MS)
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const parsed = parseSseBlock(part)
      if (!parsed) continue
      if (parsed.event === 'ping' || parsed.data === '') continue
      let envelope: unknown
      try {
        envelope = JSON.parse(parsed.data)
      } catch {
        continue
      }
      // DoD §12: schema-check only — never cast invalid envelopes through.
      if (!isRealtimeEnvelope(envelope)) continue
      onEnvelope(envelope)
    }
  }
}

function isRealtimeEnvelope(value: unknown): value is RealtimeEnvelope {
  return Value.Check(RealtimeEnvelopeSchema, value)
}
