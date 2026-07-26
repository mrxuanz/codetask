export type ConversationErrorCode =
  | 'conversation.workspace_not_found'
  | 'conversation.workspace_exists'
  | 'conversation.thread_not_found'
  | 'conversation.turn_in_progress'
  | 'conversation.turn_not_found'
  | 'conversation.title_invalid'
  | 'conversation.prompt_invalid'
  | 'conversation.model_invalid'
  | 'conversation.provider_unavailable'
  | 'conversation.provider_not_authenticated'

export class ConversationError extends Error {
  constructor(
    readonly code: ConversationErrorCode,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(code)
    this.name = 'ConversationError'
  }
}
