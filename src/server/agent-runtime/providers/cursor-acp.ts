import type { AgentTurnInput, AgentTurnChunk, AgentTurnOptions } from '../types'
import { streamCursorSessionTurn } from '../cursor-acp/stream-session-turn'

export async function* streamCursorAcpTurn(
  input: AgentTurnInput,
  options?: AgentTurnOptions
): AsyncGenerator<AgentTurnChunk> {
  yield* streamCursorSessionTurn(input, options)
}
