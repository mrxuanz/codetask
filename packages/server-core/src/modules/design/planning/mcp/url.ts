import { buildPlannerMcpCapabilityToken } from './capability.ts'

let backendPort = 0

export function initPlannerMcpBackend(port: number): void {
  backendPort = port
}

export function getPlannerMcpBackendPort(): number {
  return backendPort
}

export function buildPlannerMcpUrl(input: {
  sessionId: string
  planningSessionId: string
  port?: number
}): string {
  const port = input.port ?? backendPort
  if (!port) {
    throw new Error('Planner MCP backend port is not initialized')
  }
  const capability = buildPlannerMcpCapabilityToken(input.sessionId, input.planningSessionId)
  const params = new URLSearchParams({
    role: 'planner',
    planningSessionId: input.planningSessionId,
    cap: capability
  })
  return `http://127.0.0.1:${port}/api/mcp/planner/${encodeURIComponent(input.sessionId)}?${params}`
}
