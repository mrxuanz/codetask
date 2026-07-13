import { formatSseEvent, type SseEnvelope } from './sse-envelope'

export interface SseEventsDependencies {
  readonly getEvents: (afterEventId: number, limit: number) => readonly SseEnvelope[]
  readonly subscribe: (connectionId: string, callback: (event: SseEnvelope) => void) => () => void
}

export function createEventsRoutes(deps: SseEventsDependencies) {
  return {
    async streamEvents(request: {
      readonly headers: Record<string, string | undefined>
    }): Promise<{
      readonly status: number
      readonly body: ReadableStream
      readonly headers: Record<string, string>
    }> {
      const lastEventId = request.headers['last-event-id']
        ? parseInt(request.headers['last-event-id'], 10)
        : 0

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()

          const initialEvents = deps.getEvents(lastEventId, 100)
          for (const event of initialEvents) {
            controller.enqueue(encoder.encode(formatSseEvent(event)))
          }

          const connectionId = crypto.randomUUID()
          const unsubscribe = deps.subscribe(connectionId, (event) => {
            try {
              controller.enqueue(encoder.encode(formatSseEvent(event)))
            } catch {
              unsubscribe()
            }
          })

          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(': heartbeat\n\n'))
            } catch {
              clearInterval(heartbeat)
            }
          }, 25000)
        }
      })

      return {
        status: 200,
        body: stream,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        }
      }
    }
  }
}
