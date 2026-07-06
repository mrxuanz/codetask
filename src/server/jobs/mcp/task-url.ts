import { getConversationMcpBackendPort } from '../../conversation/mcp/url'
import { buildTaskMcpCapabilityToken } from './task-session'

export function buildTaskWorkerMcpUrl(input: {
  sessionId: string
  jobId: string
  taskId: string
}): string {
  const port = getConversationMcpBackendPort()
  if (!port) {
    throw new Error('Task MCP backend port is not initialized')
  }
  const capability = buildTaskMcpCapabilityToken(input.sessionId, input.jobId, input.taskId)
  const params = new URLSearchParams({
    role: 'task-worker',
    jobId: input.jobId,
    taskId: input.taskId,
    cap: capability
  })
  return `http://127.0.0.1:${port}/api/mcp/task/${encodeURIComponent(input.sessionId)}?${params}`
}
