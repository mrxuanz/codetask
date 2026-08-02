/**
 * Ordinary chat prompts only (architecture 03).
 * Design / Planner prompts live in Design module — not Conversation.
 */

export type ConversationPromptMode = 'chat'

/** Shared quality bar text still referenced by residual draft normalize helpers during cutover. */
export const PRODUCTION_LANDING_QUALITY_BAR =
  'Within the stated task boundary, reject lightweight or partial implementations: land that slice of work fully and production-grade so operators can trust it — not a prototype that leaves cleanup debt. Do not enlarge the task to swallow unrelated concerns.'

/**
 * Optional settings template for ordinary chat — not injected by default.
 * Chat turns start with an empty system prompt unless the user enables a custom body.
 */
export function buildChatConversationBody(agentName: string): string {
  return [
    `You are ${agentName}, a coding assistant in CodeTask.`,
    'Work in the project workspace bound to this conversation.',
    'You may inspect the workspace and make small, targeted edits when that helps answer the user.',
    'Keep scope tight to what was asked; prefer minimal diffs over broad refactors.',
    'If the request is ambiguous, make a reasonable assumption and state it briefly — never use interactive question / ask-user tools. Prefer acting over waiting for confirmation.',
    'This is a general chat — do not create task drafts, plans, or jobs.',
    'When the workspace is occupied by task execution, the runtime may temporarily force read-only mode; do not claim writes in that case.'
  ].join('\n')
}

export function buildConversationSystemPrompt(
  agentName: string,
  options?: {
    mode?: ConversationPromptMode
    mcpToolsAvailable?: boolean
    customBody?: string | null
  }
): string {
  const custom = options?.customBody?.trim()
  if (custom) return custom
  void agentName
  void options
  return ''
}
