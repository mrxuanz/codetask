import { buildConversationMcpCapabilityToken } from './capability'

let backendPort = 0

export function initConversationMcpBackend(port: number): void {
  backendPort = port
}

export function getConversationMcpBackendPort(): number {
  return backendPort
}

export function buildConversationMcpUrl(input: {
  sessionId: string
  threadId: string
}): string {
  if (!backendPort) {
    throw new Error('Conversation MCP backend port is not initialized')
  }
  const capability = buildConversationMcpCapabilityToken(input.sessionId, input.threadId)
  const params = new URLSearchParams({
    role: 'conversation',
    threadId: input.threadId,
    cap: capability
  })
  return `http://127.0.0.1:${backendPort}/api/mcp/conversation/${encodeURIComponent(input.sessionId)}?${params}`
}

