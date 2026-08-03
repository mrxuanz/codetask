import { getExecutionMcpBackendPort } from './backend-port.ts'
import { buildSliceVerifierMcpCapabilityToken } from './slice-session.ts'

export function buildSliceVerifierMcpUrl(input: {
  sessionId: string
  jobId: string
  sliceId: string
}): string | null {
  const port = getExecutionMcpBackendPort()
  if (!port) return null
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
