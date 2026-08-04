import { buildTaskMcpCapabilityToken } from './task-session.ts'
import { getExecutionMcpBackendPort } from '../../verification/mcp/backend-port.ts'

export function buildTaskWorkerMcpUrl(input: {
  sessionId: string
  jobId: string
  taskId: string
  idempotencyKey: string
}): string {
  const backendPort = getExecutionMcpBackendPort()
  if (!backendPort) {
    throw new Error('Execution MCP backend port is not initialized')
  }
  const capability = buildTaskMcpCapabilityToken(
    input.sessionId,
    input.jobId,
    input.taskId,
    input.idempotencyKey
  )
  const params = new URLSearchParams({
    role: 'task-worker',
    jobId: input.jobId,
    taskId: input.taskId,
    idem: input.idempotencyKey,
    cap: capability
  })
  return `http://127.0.0.1:${backendPort}/api/mcp/task/${encodeURIComponent(input.sessionId)}?${params}`
}

export function tryBuildTaskWorkerMcpUrl(input: {
  sessionId: string
  jobId: string
  taskId: string
  idempotencyKey: string
}): string | null {
  if (!getExecutionMcpBackendPort()) return null
  return buildTaskWorkerMcpUrl(input)
}
