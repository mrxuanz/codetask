import { buildConversationMcpCapabilityToken } from './capability'
import type { WizardPhase } from '../../wizard/types'

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
  wizardStage: WizardPhase | 'general'
}): string {
  if (!backendPort) {
    throw new Error('Conversation MCP backend port is not initialized')
  }
  const capability = buildConversationMcpCapabilityToken(
    input.sessionId,
    input.threadId,
    input.wizardStage
  )
  const params = new URLSearchParams({
    role: 'conversation',
    wizardStage: input.wizardStage,
    threadId: input.threadId,
    cap: capability
  })
  return `http://127.0.0.1:${backendPort}/api/mcp/conversation/${encodeURIComponent(input.sessionId)}?${params}`
}

export function buildStubMcpUrl(role: string, sessionId: string): string {
  if (!backendPort) {
    throw new Error('Conversation MCP backend port is not initialized')
  }
  return `http://127.0.0.1:${backendPort}/api/mcp/${role}/${encodeURIComponent(sessionId)}?role=${encodeURIComponent(role)}&cap=local`
}
