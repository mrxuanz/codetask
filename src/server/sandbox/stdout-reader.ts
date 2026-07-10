import type { AgentTurnChunk } from '../agent-runtime/types'
import { sandboxTurnDebug } from '../debug/sandbox-turn'
import { SandboxError } from './types'
import type { SpawnedSandboxWorker } from './launcher'

export const TURN_DONE_MARKER = '{"type":"_turn_done"}'

export interface SandboxChunkReaderOptions {
  signal?: AbortSignal
  stopOnDoneMarker?: boolean
  pollExit?: () => { code: number | null; status: string } | null
  debugPrefix?: string
}

export function sandboxErrorFromErrorChunk(
  chunk: Extract<AgentTurnChunk, { type: 'error' }>
): SandboxError {
  const code = chunk.error?.code ?? chunk.code
  if (typeof code === 'string' && code.length > 0) {
    return new SandboxError(chunk.message, code)
  }
  return new SandboxError(chunk.message, 'sandbox.sdk.error')
}

export function readStderrPreview(
  handle: SpawnedSandboxWorker['handle'],
  maxBytes = 64 * 1024
): string {
  let result = ''
  for (;;) {
    const tail = handle.readStderrChunk(maxBytes)
    if (tail.length === 0) break
    result += tail.toString('utf8')
    if (result.length > 4000) break
  }
  return result
}

export async function* readSandboxChunks(
  stdoutLines: AsyncGenerator<string>,
  options: SandboxChunkReaderOptions = {}
): AsyncGenerator<AgentTurnChunk> {
  const { signal, stopOnDoneMarker = false } = options
  let streamEnded = false
  let lineCount = 0

  try {
    for await (const line of stdoutLines) {
      if (signal?.aborted) break
      lineCount += 1

      if (lineCount <= 3) {
        sandboxTurnDebug(`${options.debugPrefix ?? 'stdout'}: line`, {
          lineCount,
          preview: line.slice(0, 120)
        })
      }

      if (stopOnDoneMarker && line === TURN_DONE_MARKER) {
        streamEnded = true
        break
      }

      const chunk = JSON.parse(line) as AgentTurnChunk
      if (chunk.type === 'error') {
        throw sandboxErrorFromErrorChunk(chunk)
      }
      yield chunk

      if (chunk.type === 'completed') {
        streamEnded = true
        break
      }
    }

    if (!streamEnded && lineCount === 0) {
      throw new SandboxError(
        'sandbox worker exited without output',
        'sandbox.sdk.error'
      )
    }
  } catch (error) {
    if (error instanceof SandboxError) throw error
    throw new SandboxError(
      error instanceof Error ? error.message : String(error),
      'sandbox.sdk.error'
    )
  }
}
