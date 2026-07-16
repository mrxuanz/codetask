import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentTurnChunk } from '../../src/server/agent-runtime/types'
import { readSandboxChunks, TURN_DONE_MARKER } from '../../src/server/sandbox/stdout-reader'

async function* lines(values: string[]): AsyncGenerator<string> {
  for (const value of values) yield value
}

test('persistent Cursor reader consumes turn marker before yielding completed', async () => {
  const completed: AgentTurnChunk = {
    type: 'completed',
    reply: 'done',
    runtimeSessionId: 'session-1'
  }
  const chunks: AgentTurnChunk[] = []
  for await (const chunk of readSandboxChunks(
    lines([
      JSON.stringify({ type: 'delta', content: 'hello' }),
      JSON.stringify(completed),
      TURN_DONE_MARKER
    ]),
    {
      stopOnDoneMarker: true,
      stopOnCompleted: false,
      bufferCompletedUntilDoneMarker: true
    }
  )) {
    chunks.push(chunk)
  }

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['delta', 'completed']
  )
  assert.deepEqual(chunks.at(-1), completed)
})
