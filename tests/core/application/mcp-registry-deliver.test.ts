import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { TaskExecutionRegistry } from '../../../src/server/application/task-execution-registry.ts'
import {
  deliverMcpCompletionToRegistry,
  setTaskExecutionRegistryForTests
} from '../../../src/server/control-plane/mcp/registry-deliver.ts'
import { handleTaskMcpJsonRpc } from '../../../src/server/control-plane/mcp/task-handler.ts'
import {
  registerTaskMcpSession,
  unregisterTaskMcpSession
} from '../../../src/server/control-plane/mcp/task-session.ts'

describe('MCP TaskExecutionRegistry deliver hop', () => {
  afterEach(() => {
    setTaskExecutionRegistryForTests(undefined)
    unregisterTaskMcpSession('mcp-session-1')
  })

  it('deliverMcpCompletionToRegistry wakes a waiter', async () => {
    const registry = new TaskExecutionRegistry()
    const ac = new AbortController()
    const wait = registry.waitFor('attempt-1', ac.signal)
    const woke = deliverMcpCompletionToRegistry(
      registry,
      ['attempt-1'],
      { kind: 'result', raw: { ok: true } }
    )
    assert.equal(woke, true)
    await wait
    const pending = registry.takePending('attempt-1')
    assert.deepEqual(pending, { kind: 'result', raw: { ok: true } })
  })

  it('report_task_result delivers into registry when waiter present', async () => {
    const registry = new TaskExecutionRegistry()
    setTaskExecutionRegistryForTests(registry)

    let resolved: unknown = null
    registerTaskMcpSession({
      sessionId: 'mcp-session-1',
      jobId: 'job-1',
      taskId: 'task-1',
      idempotencyKey: 'attempt-key-1',
      resolve: (packet) => {
        resolved = packet
      },
      reject: () => {}
    })

    const ac = new AbortController()
    const wait = registry.waitFor('attempt-key-1', ac.signal)

    const result = await handleTaskMcpJsonRpc('mcp-session-1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'report_task_result',
        arguments: {
          status: 'completed',
          summary: 'done',
          changedFiles: [],
          evidence: ['ok'],
          validation: { ran: false, outcome: 'not-applicable' }
        }
      }
    })

    assert.equal(result.kind, 'json')
    await wait
    assert.ok(resolved)
    const pending = registry.takePending('attempt-key-1')
    assert.equal(pending?.kind, 'result')
  })
})
