function messageList(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
    )
  }
  if (!value || typeof value !== 'object') return []
  const record = value as { data?: unknown; messages?: unknown }
  return messageList(record.messages ?? record.data)
}

export function findAttachmentPermissionRefusal(messages: unknown): string | null {
  for (const message of messageList(messages).reverse()) {
    if (String(message.role ?? '') !== 'assistant') continue
    const content = String(message.content ?? '')
    if (
      /outside (?:the )?allowed directory permissions|outside.*allowed.*director|external_directory/i.test(
        content
      )
    ) {
      return content
    }
  }
  return null
}

export function findImageInputUnsupported(messages: unknown): string | null {
  for (const message of messageList(messages).reverse()) {
    if (String(message.role ?? '') !== 'assistant') continue
    const content = String(message.content ?? '')
    if (
      /(?:current |selected )?model (?:does not|doesn't|cannot|can't) support (?:image|vision)|model.*not support.*(?:image|vision)|当前模型不支持(?:图像|图片|视觉)|模型.*无法.*(?:图像|图片)/iu.test(
        content
      )
    ) {
      return content
    }
  }
  return null
}
