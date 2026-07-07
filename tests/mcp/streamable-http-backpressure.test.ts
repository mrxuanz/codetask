import assert from 'node:assert/strict'
import test from 'node:test'
import type { McpDispatchResult } from '../../src/server/conversation/mcp/handler'
import {
  streamMcpSseEvents,
  publishMcpJsonRpcResponse,
  closeStreamableMcpTransport,
  MAX_MCP_SSE_QUEUE
} from '../../src/server/mcp/streamable-http.ts'

test('streamMcpSseEvents closes when queue overflows backlog', async () => {
  const urlSessionId = `test-backpressure-${Date.now()}`
  const mcpSessionId = null
  const abortController = new AbortController()

  const gen = streamMcpSseEvents({
    urlSessionId,
    mcpSessionId,
    signal: abortController.signal
  })

  const first = await gen.next()
  assert.equal(first.value?.event, 'endpoint')
  assert.equal(first.done, false)

  // Fast-forward Date.now so every publish gets a unique eventId without
  // real time delays.  We restore the original after the test so that
  // nothing else in the process is affected.
  const _DateNow = Date.now
  let tick = 0
  Object.defineProperty(Date, 'now', { value: () => ++tick * 1000 })

  try {
    for (let i = 0; i < MAX_MCP_SSE_QUEUE + 20; i++) {
      publishMcpJsonRpcResponse(urlSessionId, mcpSessionId, i, {
        kind: 'response',
        body: { jsonrpc: '2.0', id: i, result: { i } }
      } as unknown as McpDispatchResult)
    }
  } finally {
    Object.defineProperty(Date, 'now', { value: _DateNow })
  }

  // After overflow the generator must exit without waiting for the 25s ping.
  const result = await gen.next()
  assert.equal(result.done, true, 'generator should be done after queue overflow')

  abortController.abort()
  closeStreamableMcpTransport(urlSessionId, mcpSessionId)
})
