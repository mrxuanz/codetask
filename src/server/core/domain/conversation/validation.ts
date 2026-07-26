import { ConversationError } from './conversation-error'

const MAX_TITLE_LENGTH = 160
const MAX_PROMPT_LENGTH = 128_000
const MAX_MODEL_LENGTH = 160

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

export function validateConversationModel(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null
  const model = value.trim()
  if (model.length > MAX_MODEL_LENGTH || /[\r\n\0]/.test(model)) {
    throw new ConversationError('conversation.model_invalid', {
      maxLength: MAX_MODEL_LENGTH
    })
  }
  return model
}

export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const value = firstLine || 'New conversation'
  return value.length <= MAX_TITLE_LENGTH ? value : `${value.slice(0, MAX_TITLE_LENGTH - 1)}…`
}
