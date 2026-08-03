import { getExecutionMcpBackendPort } from './backend-port.ts'
import { buildMilestoneVerifierMcpCapabilityToken } from './milestone-session.ts'

export function buildMilestoneVerifierMcpUrl(input: {
  sessionId: string
  jobId: string
  milestoneId: string
}): string | null {
  const port = getExecutionMcpBackendPort()
  if (!port) return null
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
