import { getConversationMcpBackendPort } from '../../conversation/mcp/url'
import { buildMilestoneVerifierMcpCapabilityToken } from './milestone-session'

export function buildMilestoneVerifierMcpUrl(input: {
  sessionId: string
  jobId: string
  milestoneId: string
}): string {
  const port = getConversationMcpBackendPort()
  if (!port) throw new Error('Milestone verifier MCP backend port is not initialized')
  const capability = buildMilestoneVerifierMcpCapabilityToken(
    input.sessionId,
    input.jobId,
    input.milestoneId
  )
  const params = new URLSearchParams({
    role: 'milestone-verifier',
    jobId: input.jobId,
    milestoneId: input.milestoneId,
    cap: capability
  })
  return `http://127.0.0.1:${port}/api/mcp/milestone-verifier/${encodeURIComponent(input.sessionId)}?${params}`
}
