import { ConversationError } from './conversation-error'

const MAX_TITLE_LENGTH = 160
const MAX_PROMPT_LENGTH = 128_000

export function validateConversationTitle(value: string): string {
  const title = value.trim().replace(/\s+/g, ' ')
  if (!title || title.length > MAX_TITLE_LENGTH) {
    throw new ConversationError('conversation.title_invalid', {
      maxLength: MAX_TITLE_LENGTH
    })
  }
  return title
}

export function validateConversationPrompt(value: string): string {
  const prompt = value.trim()
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
    throw new ConversationError('conversation.prompt_invalid', {
      maxLength: MAX_PROMPT_LENGTH
    })
  }
  return prompt
}

export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const value = firstLine || 'New conversation'
  return value.length <= MAX_TITLE_LENGTH ? value : `${value.slice(0, MAX_TITLE_LENGTH - 1)}…`
}
