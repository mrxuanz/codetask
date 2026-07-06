import { createHash } from 'crypto'

export function buildConversationMcpCapabilityToken(
  sessionId: string,
  threadId: string,
  wizardStage: string
): string {
  const primary = createHash('sha256')
    .update(['main-agent', '1', sessionId, threadId, wizardStage].join('\0'))
    .digest('hex')
    .slice(0, 16)
  const secondary = createHash('sha256')
    .update(['main-agent', '2', sessionId, threadId, wizardStage].join('\0'))
    .digest('hex')
    .slice(0, 16)
  return `${primary}${secondary}`
}

export function verifyConversationMcpCapabilityToken(
  capability: string | null | undefined,
  sessionId: string,
  threadId: string,
  wizardStage: string
): boolean {
  if (!capability?.trim()) return false
  return buildConversationMcpCapabilityToken(sessionId, threadId, wizardStage) === capability.trim()
}
