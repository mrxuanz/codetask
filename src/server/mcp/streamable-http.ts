import type { McpDispatchResult } from '../conversation/mcp/handler'
import { createBoundedBuffer, type BoundedBuffer } from '../shared/bounded-buffer.ts'

type JsonRpcId = string | number | null

export const MAX_MCP_SSE_QUEUE = 256

export interface McpJsonRpcBody {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

interface StreamSubscriber {
  lastEventId: number
  push: (eventId: number, body: McpJsonRpcBody) => void
  close: () => void
}

interface StreamableTransport {
  urlSessionId: string
  mcpSessionId: string | null
  subscribers: Set<StreamSubscriber>
  closed: boolean
  lastActivityAt: number
}

const transports = new Map<string, StreamableTransport>()
const IDLE_TRANSPORT_MS = 30 * 60 * 1000

function transportKey(urlSessionId: string, mcpSessionId: string | null): string {
  return mcpSessionId ? `${urlSessionId}::${mcpSessionId}` : urlSessionId
}

function pruneIdleTransports(): void {
  const cutoff = Date.now() - IDLE_TRANSPORT_MS
  for (const [key, transport] of transports.entries()) {
    if (
      transport.closed ||
      (transport.subscribers.size === 0 && transport.lastActivityAt < cutoff)
    ) {
      closeStreamableMcpTransport(transport.urlSessionId, transport.mcpSessionId)
      transports.delete(key)
    }
  }
}

function getOrCreateTransport(
  urlSessionId: string,
  mcpSessionId: string | null
): StreamableTransport {
  pruneIdleTransports()
  const key = transportKey(urlSessionId, mcpSessionId)
  let transport = transports.get(key)
  if (!transport) {
    transport = {
      urlSessionId,
      mcpSessionId,
      subscribers: new Set(),
      closed: false,
      lastActivityAt: Date.now()
    }
    transports.set(key, transport)
  } else {
    transport.lastActivityAt = Date.now()
  }
  return transport
}

function dispatchToJsonBody(result: McpDispatchResult): McpJsonRpcBody | null {
  if (result.kind === 'notification') return null
  return result.body as McpJsonRpcBody
}

function publishToTransport(
  transport: StreamableTransport,
  requestId: JsonRpcId,
  body: McpJsonRpcBody
): void {
  const eventId = Date.now()
  for (const subscriber of transport.subscribers) {
    subscriber.push(eventId, { ...body, id: body.id ?? requestId })
  }
}

export function publishMcpJsonRpcResponse(
  urlSessionId: string,
  mcpSessionId: string | null,
  requestId: JsonRpcId,
  result: McpDispatchResult
): void {
  const body = dispatchToJsonBody(result)
  if (!body) return
  const transport = transports.get(transportKey(urlSessionId, mcpSessionId))
  if (!transport || transport.closed) return
  transport.lastActivityAt = Date.now()
  publishToTransport(transport, requestId, body)
}

export function closeStreamableMcpTransport(
  urlSessionId: string,
  mcpSessionId: string | null
): void {
  const key = transportKey(urlSessionId, mcpSessionId)
  const transport = transports.get(key)
  if (!transport) return
  transport.closed = true
  for (const subscriber of transport.subscribers) {
    subscriber.close()
  }
  transport.subscribers.clear()
  transports.delete(key)
}

export function closeAllStreamableMcpTransportsForUrlSession(urlSessionId: string): void {
  for (const [key, transport] of transports.entries()) {
    if (transport.urlSessionId !== urlSessionId) continue
    closeStreamableMcpTransport(urlSessionId, transport.mcpSessionId)
    transports.delete(key)
  }
}

export interface StreamableMcpSseOptions {
  urlSessionId: string
  mcpSessionId: string | null
  lastEventIdHeader?: string | null
  signal?: AbortSignal
}

export async function* streamMcpSseEvents(
  options: StreamableMcpSseOptions
): AsyncGenerator<{ event: string; id: string; data: string }> {
  const transport = getOrCreateTransport(options.urlSessionId, options.mcpSessionId)
  if (transport.closed) return

  const queue: BoundedBuffer<{ event: string; id: string; data: string }> = createBoundedBuffer({
    max: MAX_MCP_SSE_QUEUE,
    policy: 'close'
  })
  let notify: (() => void) | undefined
  let closed = false

  const subscriber: StreamSubscriber = {
    lastEventId: Number.parseInt(options.lastEventIdHeader ?? '0', 10) || 0,
    push: (eventId, body) => {
      if (closed) return
      if (eventId <= subscriber.lastEventId) return
      subscriber.lastEventId = eventId
      const result = queue.push({
        event: 'message',
        id: String(eventId),
        data: JSON.stringify(body)
      })
      if (result === 'overflow') {
        closed = true
        notify?.()
        return
      }
      notify?.()
    },
    close: () => {
      closed = true
      notify?.()
    }
  }

  transport.subscribers.add(subscriber)

  const abort = (): void => {
    closed = true
    notify?.()
  }
  options.signal?.addEventListener('abort', abort, { once: true })

  try {
    yield { event: 'endpoint', id: '0', data: JSON.stringify({ sessionId: options.urlSessionId }) }

    while (!closed) {
      while (queue.size() > 0) {
        yield queue.shift()!
      }
      if (closed) break
      await new Promise<void>((resolve) => {
        notify = resolve
        setTimeout(resolve, 25_000)
      })
      if (!closed && queue.size() === 0) {
        yield { event: 'ping', id: String(Date.now()), data: '{}' }
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', abort)
    transport.subscribers.delete(subscriber)
    if (transport.subscribers.size === 0 && !transport.closed) {
      transports.delete(transportKey(options.urlSessionId, options.mcpSessionId))
    }
  }
}

export function acceptPrefersEventStream(acceptHeader: string | undefined): boolean {
  if (!acceptHeader) return false
  return acceptHeader.toLowerCase().includes('text/event-stream')
}

export function acceptAllowsJson(acceptHeader: string | undefined): boolean {
  if (!acceptHeader) return true
  return acceptHeader.toLowerCase().includes('application/json')
}

export async function dispatchStreamableMcpPost(input: {
  urlSessionId: string
  mcpSessionId: string | null
  acceptHeader: string | undefined
  body: unknown
  handle: (sessionId: string, body: unknown) => Promise<McpDispatchResult>
}): Promise<{ status: number; body: McpJsonRpcBody | null; contentType: string }> {
  const request = (input.body ?? {}) as McpJsonRpcBody
  const requestId = request.id ?? null
  const result = await input.handle(input.urlSessionId, input.body)

  publishMcpJsonRpcResponse(input.urlSessionId, input.mcpSessionId, requestId, result)

  if (result.kind === 'notification') {
    return { status: 202, body: null, contentType: 'application/json' }
  }

  const jsonBody = result.body as McpJsonRpcBody

  if (acceptPrefersEventStream(input.acceptHeader) && !acceptAllowsJson(input.acceptHeader)) {
    return { status: 202, body: null, contentType: 'text/event-stream' }
  }

  return { status: 200, body: jsonBody, contentType: 'application/json' }
}
