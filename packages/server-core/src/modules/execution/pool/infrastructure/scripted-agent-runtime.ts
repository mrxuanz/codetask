import type {
  AgentRuntime,
  AgentTurnEvent,
  AgentTurnInput
} from '@codetask/agent-runtime'

export type ScriptedTurnHandler = (
  input: AgentTurnInput
) => AsyncIterable<AgentTurnEvent> | AgentTurnEvent[] | Promise<AgentTurnEvent[]>

/**
 * Deterministic AgentRuntime for Execution integration tests.
 * Exercises the real execute-work path (provider/role/prompt forwarding)
 * without calling an external Provider SDK (those land in architecture 03).
 */
export class ScriptedAgentRuntime implements AgentRuntime {
  readonly turns: AgentTurnInput[] = []

  constructor(private readonly handler: ScriptedTurnHandler) {}

  async *runTurn(input: AgentTurnInput): AsyncIterable<AgentTurnEvent> {
    this.turns.push(input)
    const result = await this.handler(input)
    if (Symbol.asyncIterator in Object(result)) {
      yield* result as AsyncIterable<AgentTurnEvent>
      return
    }
    for (const event of result as AgentTurnEvent[]) {
      yield event
    }
  }

  async abort(): Promise<void> {}
  async closeScope(): Promise<void> {}
  async inspectScope(): Promise<null> {
    return null
  }
}
