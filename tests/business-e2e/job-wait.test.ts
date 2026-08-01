import assert from 'node:assert/strict'
import test from 'node:test'
import { isRetryableMcpJobWaitError, waitForJobTerminalViaMcp } from './drivers/job-wait'

test('job wait continues across bounded timeout and transient transport failure', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const retries: string[] = []
  const results: Array<unknown> = [
    new Error('mcp_tool_failed:codetask_wait_job:Error: timeout:job_job-1'),
    new TypeError('fetch failed'),
    { status: 'completed', id: 'job-1' }
  ]
  const mcp = {
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      calls.push({ name, args })
      const result = results.shift()
      if (result instanceof Error) throw result
      return result
    }
  }

  const terminal = await waitForJobTerminalViaMcp(mcp, {
    threadId: 'thread-1',
    jobId: 'job-1',
    sliceTimeoutMs: 25,
    retryDelayMs: 0,
    onRetry: ({ error }) => retries.push(error)
  })

  assert.equal(terminal.status, 'completed')
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0], {
    name: 'codetask_wait_job',
    args: { threadId: 'thread-1', jobId: 'job-1', timeoutMs: 25 }
  })
  assert.equal(retries.length, 2)
})

test('job wait does not retry non-transient MCP failures', async () => {
  const failure = new Error('mcp_tool_error:codetask_wait_job:job.get_failed:404')
  const mcp = {
    async callTool(): Promise<unknown> {
      throw failure
    }
  }

  await assert.rejects(
    waitForJobTerminalViaMcp(mcp, {
      threadId: 'thread-1',
      jobId: 'job-1',
      retryDelayMs: 0
    }),
    failure
  )
})

test('job wait retry classifier is narrow', () => {
  assert.equal(isRetryableMcpJobWaitError(new TypeError('fetch failed')), true)
  assert.equal(isRetryableMcpJobWaitError(new Error('timeout:job_job-1')), true)
  assert.equal(isRetryableMcpJobWaitError(new Error('job.get_failed:404')), false)
})
