import { getConversationMcpBackendPort } from '../../conversation/mcp/url'
import { buildPlannerMcpCapabilityToken } from './session'

export function buildPlannerMcpUrl(input: { sessionId: string; jobId: string }): string {
  const port = getConversationMcpBackendPort()
  if (!port) {
    throw new Error('Planner MCP backend port is not initialized')
  }
  const capability = buildPlannerMcpCapabilityToken(input.sessionId, input.jobId)
  const params = new URLSearchParams({
    role: 'planner',
    jobId: input.jobId,
    cap: capability
  })
  return `http://127.0.0.1:${port}/api/mcp/planner/${encodeURIComponent(input.sessionId)}?${params}`
}
