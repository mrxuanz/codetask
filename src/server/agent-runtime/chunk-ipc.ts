import type { ConversationRole } from './roles'
import type { AgentTurnChunk } from './types'

export function roleNeedsStreamingChunks(role: ConversationRole): boolean {
  return role === 'conversation'
}

export function compactTurnChunkForIpc(
  role: ConversationRole,
  chunk: AgentTurnChunk
): AgentTurnChunk | null {
  if (roleNeedsStreamingChunks(role)) return chunk
  if (chunk.type === 'delta' || chunk.type === 'thinking_delta') return null
  if (chunk.type === 'completed') {
    return { type: 'completed', reply: '', runtimeSessionId: chunk.runtimeSessionId }
  }
  return chunk
}
