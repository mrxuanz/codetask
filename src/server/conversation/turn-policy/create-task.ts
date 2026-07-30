import { providerSupportsCapability } from '../../agent-runtime/capabilities'
import type { SupportedCoreCode } from '../cores'
import { buildConversationSystemPrompt, buildDraftTurnSystemPrompt } from '../prompts'
import {
  appendBusinessSkillSnapshot,
  resolveBusinessSkillSnapshot
} from '../../settings/business-skills'
import type { ConversationTurnRole } from '../mcp/session'
import type { ConversationAccessDecision, CreateTaskAccessInput } from './types'

/**
 * Create-task / draft module access policy.
 * Always read-only — independent of ordinary chat write leases.
 */
export function resolveCreateTaskAccess(input: CreateTaskAccessInput): ConversationAccessDecision {
  if (!providerSupportsCapability(input.coreCode as SupportedCoreCode, 'create-task-read')) {
    throw new Error(`Selected CLI (${input.coreCode}) cannot enforce create-task-read`)
  }

  return {
    workspaceAccess: input.workspacePath.trim() ? 'live-read' : 'metadata',
    capabilityProfile: 'create-task-read',
    workspaceLease: null
  }
}

export function resolveCreateTaskSystemPrompt(input: {
  turnRole: ConversationTurnRole
  mcpToolsAvailable: boolean
  phasePromptSection?: string
}): string {
  const basePrompt = buildConversationSystemPrompt('CodeTask Conversation', {
    mode: 'create_task',
    mcpToolsAvailable: input.mcpToolsAvailable,
    customBody: null
  })
  const systemPromptBase =
    input.turnRole === 'draft' ? buildDraftTurnSystemPrompt(basePrompt) : basePrompt
  const withPhase =
    input.phasePromptSection && input.phasePromptSection.trim()
      ? `${systemPromptBase}\n\n${input.phasePromptSection.trim()}`
      : systemPromptBase

  return appendBusinessSkillSnapshot(
    withPhase,
    resolveBusinessSkillSnapshot(input.turnRole === 'draft' ? 'draft' : 'conversation')
  )
}
