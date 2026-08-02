import { createHash } from 'crypto'

export function buildConversationMcpCapabilityToken(
  sessionId: string,
  threadId: string
): string {
  const primary = createHash('sha256')
    .update(['conversation-mcp', '1', sessionId, threadId].join('\0'))
    .digest('hex')
    .slice(0, 16)
  const secondary = createHash('sha256')
    .update(['conversation-mcp', '2', sessionId, threadId].join('\0'))
    .digest('hex')
    .slice(0, 16)
  return `${primary}${secondary}`
}

export function verifyConversationMcpCapabilityToken(
  capability: string | null | undefined,
  sessionId: string,
  threadId: string
): boolean {
  if (!capability?.trim()) return false
  return buildConversationMcpCapabilityToken(sessionId, threadId) === capability.trim()
}
