import type { ConversationCursorKind } from './runtime-registry'

export type ConversationCursorBindingStatus = 'running' | 'stopped'

export interface ConversationCursorBinding {
  scopeId: string
  threadId: string
  kind: ConversationCursorKind
  status: ConversationCursorBindingStatus
  lastSeenAt: number
}

const bindings = new Map<string, ConversationCursorBinding>()

export function parseConversationCursorScope(
  scopeId: string
): { threadId: string; kind: ConversationCursorKind } | null {
  if (scopeId.startsWith('conversation:chat:')) {
    return { threadId: scopeId.slice('conversation:chat:'.length), kind: 'chat' }
  }
  if (scopeId.startsWith('conversation:create_task:')) {
    return {
      threadId: scopeId.slice('conversation:create_task:'.length),
      kind: 'create_task'
    }
  }
  if (/^conversation:[^:]+$/.test(scopeId)) {
    return { threadId: scopeId.slice('conversation:'.length), kind: 'chat' }
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
    threadId: parsed.threadId,
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
