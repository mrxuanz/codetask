export function extractCodexReasoningText(item: {
  type?: string
  text?: string
  summary_text?: string[]
  summaryText?: string[]
  raw_content?: string[]
  rawContent?: string[]
  summary?: Array<{ type?: string; text?: string }>
}): string | null {
  if (item.type !== 'reasoning') return null

  const direct = item.text?.trim()
  if (direct) return direct

  const summaryLines = item.summary_text ?? item.summaryText ?? []
  if (summaryLines.length > 0) {
    const joined = summaryLines
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
    if (joined) return joined
  }

  if (Array.isArray(item.summary)) {
    const joined = item.summary
      .map((entry) => entry.text?.trim() ?? '')
      .filter(Boolean)
      .join('\n')
    if (joined) return joined
  }

  const rawLines = item.raw_content ?? item.rawContent ?? []
  if (rawLines.length > 0) {
    const joined = rawLines
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
    if (joined) return joined
  }

  return null
}

export function extractLooseReasoningText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (!['reasoning', 'thought', 'thinking'].includes(type)) return null

  if (typeof record.text === 'string' && record.text.trim()) return record.text.trim()
  if (typeof record.thinking === 'string' && record.thinking.trim()) return record.thinking.trim()
  if (typeof record.content === 'string' && record.content.trim()) return record.content.trim()
  return null
}
