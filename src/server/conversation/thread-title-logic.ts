import type { ConversationMessageDto } from './types'

/** Matches ConversationApplication DEFAULT_TITLE. */
export const DEFAULT_CONVERSATION_TITLE = 'New thread'
const TITLE_SOURCE_MANUAL = 'manual'
const THREAD_KIND_CHAT = 'chat'

export const MAX_THREAD_TITLE_CHARS = 48

export function isFirstUserMessage(messages: ConversationMessageDto[]): boolean {
  const userTextCount = messages.filter(
    (message) => message.kind === 'text' && message.role === 'user'
  ).length
  return userTextCount === 1
}

export function canReplaceThreadTitle(currentTitle: string, titleSeed?: string | null): boolean {
  const trimmedCurrent = currentTitle.trim()
  if (trimmedCurrent === DEFAULT_CONVERSATION_TITLE) {
    return true
  }
  const trimmedSeed = titleSeed?.trim()
  return Boolean(trimmedSeed) && trimmedCurrent === trimmedSeed
}

export function canSeedThreadTitle(thread: {
  title: string
  titleSource: string
  threadKind: string
}): boolean {
  return thread.threadKind === THREAD_KIND_CHAT && thread.titleSource !== TITLE_SOURCE_MANUAL
}

export function buildThreadTitleSeed(input: {
  userMessage: string
  imageAttachmentName?: string | null
}): string | null {
  let seed = input.userMessage.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (!seed && input.imageAttachmentName?.trim()) {
    seed = `Image: ${input.imageAttachmentName.trim()}`
  }
  return sanitizeThreadTitle(seed)
}

export function sanitizeThreadTitle(raw: string): string | null {
  let title = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!title || title === DEFAULT_CONVERSATION_TITLE) return null
  if (title.length > MAX_THREAD_TITLE_CHARS) {
    title = title.slice(0, MAX_THREAD_TITLE_CHARS).trim()
  }
  return title || null
}
