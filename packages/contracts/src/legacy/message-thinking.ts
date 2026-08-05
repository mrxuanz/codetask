export interface MessageThinkingPayload {
  thinking: string

  durationMs?: number
}

export function buildMessageThinkingPayload(
  thinking: string,
  durationMs?: number
): MessageThinkingPayload | undefined {
  const text = thinking.trim()
  if (!text) return undefined
  const payload: MessageThinkingPayload = { thinking: text }
  if (durationMs != null && durationMs > 0) {
    payload.durationMs = Math.round(durationMs)
  }
  return payload
}

export function extractMessageThinking(payload: unknown): {
  text: string | null
  durationMs: number | null
} {
  if (!payload || typeof payload !== 'object' || payload === null) {
    return { text: null, durationMs: null }
  }
  const record = payload as Partial<MessageThinkingPayload>
  const text = typeof record.thinking === 'string' ? record.thinking.trim() : ''
  const durationMs =
    typeof record.durationMs === 'number' && record.durationMs > 0
      ? Math.round(record.durationMs)
      : null
  return {
    text: text || null,
    durationMs
  }
}

export function thinkingDurationSeconds(durationMs: number | null | undefined): number | null {
  if (durationMs == null || durationMs <= 0) return null
  return Math.max(1, Math.round(durationMs / 1000))
}
