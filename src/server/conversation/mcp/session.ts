import type { ConversationMessageDto, MessageAttachment } from '../types'
import type { ThreadJobDto } from '@shared/contracts/jobs'
import type { WizardPhase } from '../../wizard/types'
import { verifyConversationMcpCapabilityToken } from './capability'

export type ConversationTurnRole = 'chat' | 'draft'

export interface ConversationMcpSessionContext {
  sessionId: string
  username: string
  threadId: string
  turnRole: ConversationTurnRole
  wizardStage: WizardPhase | null
  workspacePath: string
  userMessageId: string
  conversationId: string
  coreCode: string
  turnAttachments: MessageAttachment[]
  activeDraftId?: string | null
  activePlanId?: string | null
  onDraftCreated?: (message: ConversationMessageDto) => void
  onPlanUpdated?: (job: ThreadJobDto) => void
}
const sessions = new Map<string, ConversationMcpSessionContext>()

export function registerConversationMcpSession(context: ConversationMcpSessionContext): void {
  sessions.set(context.sessionId, context)
}

export function unregisterConversationMcpSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function getConversationMcpSession(sessionId: string): ConversationMcpSessionContext | null {
  return sessions.get(sessionId) ?? null
}

export function authorizeConversationMcpRequest(input: {
  sessionId: string
  role?: string | null
  wizardStage?: string | null
  threadId?: string | null
  capability?: string | null
}): boolean {
  if (input.role?.trim() !== 'conversation') return false
  const wizardStage = input.wizardStage?.trim()
  const threadId = input.threadId?.trim()
  if (!wizardStage || !threadId) return false

  const session = getConversationMcpSession(input.sessionId)
  if (!session) return false
  if (session.threadId !== threadId) return false

  const expectedStage = session.wizardStage ?? 'general'
  if (wizardStage !== expectedStage) return false

  return verifyConversationMcpCapabilityToken(
    input.capability,
    session.sessionId,
    session.threadId,
    wizardStage
  )
}
