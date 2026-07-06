import type { ConversationMessageDto } from '@shared/contracts/conversation'

export function upsertStreamingAssistantMessage(
  messages: ConversationMessageDto[],
  messageId: string,
  content: string,
  coreCode: string,
  thinking?: string
): ConversationMessageDto[] {
  const existing = messages.find((message) => message.id === messageId)
  if (existing) {
    if (existing.content === content && (existing.thinking ?? '') === (thinking ?? ''))
      return messages
    return messages.map((message) =>
      message.id === messageId
        ? { ...message, content, thinking: thinking ?? message.thinking ?? null }
        : message
    )
  }

  return [
    ...messages,
    {
      id: messageId,
      role: 'assistant',
      kind: 'text',
      content,
      thinking: thinking ?? null,
      attachments: [],
      coreCode,
      createdAt: new Date().toISOString()
    }
  ]
}

export function finalizeStreamingAssistantMessage(
  messages: ConversationMessageDto[],
  finalMessage: ConversationMessageDto
): ConversationMessageDto[] {
  const existing = messages.find((message) => message.id === finalMessage.id)
  if (existing) {
    if (
      existing.content === finalMessage.content &&
      existing.role === finalMessage.role &&
      existing.kind === finalMessage.kind &&
      existing.coreCode === finalMessage.coreCode &&
      (existing.thinking ?? '') === (finalMessage.thinking ?? '') &&
      (existing.thinkingDurationMs ?? null) === (finalMessage.thinkingDurationMs ?? null)
    ) {
      return messages
    }
    return messages.map((message) => (message.id === finalMessage.id ? finalMessage : message))
  }
  return [...messages, finalMessage]
}

export function replaceOptimisticUserMessage(
  messages: ConversationMessageDto[],
  optimisticId: string | null,
  serverMessage: ConversationMessageDto
): ConversationMessageDto[] {
  if (optimisticId && messages.some((message) => message.id === optimisticId)) {
    return messages.map((message) => (message.id === optimisticId ? serverMessage : message))
  }
  if (messages.some((message) => message.id === serverMessage.id)) {
    return messages
  }
  return [...messages, serverMessage]
}

export function removeStreamingAssistantMessage(
  messages: ConversationMessageDto[],
  messageId: string | null | undefined
): ConversationMessageDto[] {
  if (!messageId) return messages
  return messages.filter((message) => message.id !== messageId)
}
