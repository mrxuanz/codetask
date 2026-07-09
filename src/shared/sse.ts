export interface SseBlock {
  event: string
  data: string
}

export function parseSseBlock(block: string): SseBlock | null {
  const lines = block.split('\n')
  let event = 'message'
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

export const SSE_IDLE_TIMEOUT_MS = 45_000

export class SseIdleTimeoutError extends Error {
  constructor() {
    super('SSE stream idle timeout')
    this.name = 'SseIdleTimeoutError'
  }
}

export async function readSseWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = SSE_IDLE_TIMEOUT_MS
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new SseIdleTimeoutError()), timeoutMs)
    )
  ])
  return result
}
