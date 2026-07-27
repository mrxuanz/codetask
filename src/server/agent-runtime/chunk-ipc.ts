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
  // Job/planner roles do not need their incremental stream forwarded across
  // the sandbox boundary, but the terminal reply is their authoritative
  // result. Dropping it makes every verifier look like an empty turn even
  // after the provider produced a valid result.
  return chunk
}
