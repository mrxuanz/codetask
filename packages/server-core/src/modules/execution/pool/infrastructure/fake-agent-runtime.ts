import type {
  AgentRuntime,
  AgentTurnEvent,
  AgentTurnInput
} from '@codetask/agent-runtime'

/** Test/runtime helper that completes turns immediately without a real provider. */
export class FakeAgentRuntime implements AgentRuntime {
  async *runTurn(_input: AgentTurnInput): AsyncIterable<AgentTurnEvent> {
    yield { type: 'completed', reason: 'fake-runtime' }
  }

  async abort(): Promise<void> {}
  async closeScope(): Promise<void> {}
  async inspectScope(): Promise<null> {
    return null
  }
}
