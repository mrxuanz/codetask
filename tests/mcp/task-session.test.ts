import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authorizeTaskMcpRequest,
  buildTaskMcpCapabilityToken,
  registerTaskMcpSession,
  unregisterTaskMcpSession
} from '../../src/server/legacy-control-plane/mcp/task-session'

test('task MCP capability is bound to the stable logical-task idempotency key', () => {
  const sessionId = 'task-mcp-test'
  const jobId = 'job-1'
  const taskId = 'task-1'
  const idempotencyKey = 'logical-task-key'
  registerTaskMcpSession({
    sessionId,
    jobId,
    taskId,
    idempotencyKey,
    resolve: () => {},
    reject: () => {}
  })

  try {
    const capability = buildTaskMcpCapabilityToken(sessionId, jobId, taskId, idempotencyKey)
    assert.equal(
      authorizeTaskMcpRequest({
        sessionId,
        role: 'task-worker',
        jobId,
        taskId,
        idempotencyKey,
        capability
      }),
      true
    )
    assert.equal(
      authorizeTaskMcpRequest({
        sessionId,
        role: 'task-worker',
        jobId,
        taskId,
        idempotencyKey: 'wrong-attempt-key',
        capability
      }),
      false
    )
  } finally {
    unregisterTaskMcpSession(sessionId)
  }
})
