import { getConversationMcpBackendPort } from '../../conversation/mcp/url'
import { buildSliceVerifierMcpCapabilityToken } from './slice-session'

export function buildSliceVerifierMcpUrl(input: {
  sessionId: string
  jobId: string
  sliceId: string
}): string {
  const port = getConversationMcpBackendPort()
  if (!port) throw new Error('Slice verifier MCP backend port is not initialized')
  const capability = buildSliceVerifierMcpCapabilityToken(
    input.sessionId,
    input.jobId,
    input.sliceId
  )
  const params = new URLSearchParams({
    role: 'slice-verifier',
    jobId: input.jobId,
    sliceId: input.sliceId,
    cap: capability
  })
  return `http://127.0.0.1:${port}/api/mcp/slice-verifier/${encodeURIComponent(input.sessionId)}?${params}`
}
