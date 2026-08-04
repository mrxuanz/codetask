import type { UiConversationMessage } from '@codetask/contracts'

export function upsertStreamingAssistantMessage(
  messages: UiConversationMessage[],
  messageId: string,
  content: string,
  providerCode: string,
  thinking?: string
): UiConversationMessage[] {
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
      providerCode,
      createdAt: new Date().toISOString()
    }
  ]
}

export function finalizeStreamingAssistantMessage(
  messages: UiConversationMessage[],
  finalMessage: UiConversationMessage
): UiConversationMessage[] {
  const existing = messages.find((message) => message.id === finalMessage.id)
  if (existing) {
    if (
      existing.content === finalMessage.content &&
      existing.role === finalMessage.role &&
      existing.kind === finalMessage.kind &&
      existing.providerCode === finalMessage.providerCode &&
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
  messages: UiConversationMessage[],
  optimisticId: string | null,
  serverMessage: UiConversationMessage
): UiConversationMessage[] {
  if (optimisticId && messages.some((message) => message.id === optimisticId)) {
    return messages.map((message) => (message.id === optimisticId ? serverMessage : message))
  }
  if (messages.some((message) => message.id === serverMessage.id)) {
    return messages
  }
  return [...messages, serverMessage]
}

export function removeStreamingAssistantMessage(
  messages: UiConversationMessage[],
  messageId: string | null | undefined
): UiConversationMessage[] {
  if (!messageId) return messages
  return messages.filter((message) => message.id !== messageId)
}
