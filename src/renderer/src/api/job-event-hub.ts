import { authHeaders } from '@renderer/auth/token'
import { throwIfNotSseResponse } from '@renderer/api/sse'
import { ApiError, api } from '@renderer/api/client'
import type { JobHubEnvelope } from '@shared/contracts/job-event-hub'
import type { JobSseEvent } from '@shared/contracts/sse'
import { parseSseBlock, readSseWithTimeout } from '@shared/sse'

export function putJobHubSubscriptions(jobIds: string[]): Promise<{ data: { jobIds: string[] } }> {
  return api<{ jobIds: string[] }>('/api/events/jobs/subscriptions', {
    method: 'PUT',
    body: JSON.stringify({ jobIds })
  })
}

export async function connectJobHubStream(
  onEnvelope: (envelope: JobHubEnvelope) => void,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const res = await fetch('/api/events/jobs/stream', {
    headers: {
      Accept: 'text/event-stream',
      ...authHeaders()
    },
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
      if (!parsed || parsed.event !== 'job') continue
      onEnvelope(JSON.parse(parsed.data) as JobHubEnvelope)
    }
  }
}

export type { JobSseEvent }
