import assert from 'node:assert/strict'
import test from 'node:test'
import { isRetryableMcpTurnWaitError, waitForTurnTerminalViaMcp } from './drivers/turn-wait'

test('turn wait continues across bounded timeout and transient transport failure', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const retries: string[] = []
  const results: Array<unknown> = [
    new Error('mcp_tool_failed:codetask_wait_turn:Error: timeout:turn_turn-1'),
    new TypeError('fetch failed'),
    { status: 'completed', id: 'turn-1' }
  ]
  const mcp = {
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      calls.push({ name, args })
      const result = results.shift()
      if (result instanceof Error) throw result
      return result
    }
  }

  const terminal = await waitForTurnTerminalViaMcp(mcp, {
    threadId: 'thread-1',
    turnId: 'turn-1',
    sliceTimeoutMs: 25,
    retryDelayMs: 0,
    onRetry: ({ error }) => retries.push(error)
  })

  assert.equal(terminal.status, 'completed')
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0], {
    name: 'codetask_wait_turn',
    args: { threadId: 'thread-1', turnId: 'turn-1', timeoutMs: 25 }
  })
  assert.equal(retries.length, 2)
})

test('turn wait does not retry non-transient MCP failures', async () => {
  const failure = new Error('mcp_tool_error:codetask_wait_turn:turn.get_failed:404')
  const mcp = {
    async callTool(): Promise<unknown> {
      throw failure
    }
  }

  await assert.rejects(
    waitForTurnTerminalViaMcp(mcp, {
      threadId: 'thread-1',
      turnId: 'turn-1',
      retryDelayMs: 0
    }),
    failure
  )
})

test('turn wait retry classifier is narrow', () => {
  assert.equal(isRetryableMcpTurnWaitError(new TypeError('fetch failed')), true)
  assert.equal(isRetryableMcpTurnWaitError(new Error('timeout:turn_turn-1')), true)
  assert.equal(isRetryableMcpTurnWaitError(new Error('timeout:job_job-1')), true)
  assert.equal(isRetryableMcpTurnWaitError(new Error('turn.get_failed:404')), false)
})
