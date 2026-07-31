import type { AgentTurnInput, AgentTurnChunk } from '../types'
import {
  streamCursorSessionTurn,
  type StreamCursorSessionTurnOptions
} from '../cursor-acp/stream-session-turn'

export type { StreamCursorSessionTurnOptions }

export async function* streamCursorAcpTurn(
  input: AgentTurnInput,
  options?: StreamCursorSessionTurnOptions
): AsyncGenerator<AgentTurnChunk> {
  yield* streamCursorSessionTurn(input, options)
}
