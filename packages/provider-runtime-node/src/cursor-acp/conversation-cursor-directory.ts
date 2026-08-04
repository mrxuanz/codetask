import type { ConversationCursorKind } from './runtime-registry'

export type ConversationCursorBindingStatus = 'running' | 'stopped'

export interface ConversationCursorBinding {
  scopeId: string
  conversationId: string
  kind: ConversationCursorKind
  status: ConversationCursorBindingStatus
  lastSeenAt: number
}

const bindings = new Map<string, ConversationCursorBinding>()

/**
 * Parse conversation Cursor scopes.
 * Canonical (03): `conversation:{id}` or `conversation:{id}:provider:{code}`.
 * Legacy `conversation:chat:{id}` still accepted for residual sessions.
 */
export function parseConversationCursorScope(
  scopeId: string
): { conversationId: string; kind: ConversationCursorKind } | null {
  const providerScoped = /^conversation:([^:]+):provider:[^:]+$/.exec(scopeId)
  if (providerScoped) {
    return { conversationId: providerScoped[1]!, kind: 'chat' }
  }
  if (scopeId.startsWith('conversation:chat:')) {
    return { conversationId: scopeId.slice('conversation:chat:'.length), kind: 'chat' }
  }
  if (/^conversation:[^:]+$/.test(scopeId)) {
    return { conversationId: scopeId.slice('conversation:'.length), kind: 'chat' }
  }
  return null
}

export function upsertConversationCursorBinding(scopeId: string): ConversationCursorBinding | null {
  const parsed = parseConversationCursorScope(scopeId)
  if (!parsed) return null

  const now = Date.now()
  const existing = bindings.get(scopeId)
  const next: ConversationCursorBinding = {
    scopeId,
    conversationId: parsed.conversationId,
    kind: parsed.kind,
    status: 'running',
    lastSeenAt: now
  }
  bindings.set(scopeId, existing ? { ...next, lastSeenAt: now } : next)
  return bindings.get(scopeId) ?? null
}

export function touchConversationCursorBinding(scopeId: string): void {
  const binding = bindings.get(scopeId)
  if (!binding || binding.status === 'stopped') return
  binding.lastSeenAt = Date.now()
}

export function markConversationCursorBindingStopped(scopeId: string): void {
  const binding = bindings.get(scopeId)
  if (!binding) return
  binding.status = 'stopped'
}

export function listConversationCursorBindings(): ConversationCursorBinding[] {
  return [...bindings.values()]
}

export function resetConversationCursorDirectoryForTests(): void {
  bindings.clear()
}
