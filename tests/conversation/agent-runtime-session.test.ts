import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildConversationScopeId,
  createAgentRuntime,
  type AgentTurnEvent,
  type AgentTurnInput
} from '@codetask/agent-runtime'

async function consume(events: AsyncIterable<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const result: AgentTurnEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

function input(scopeId: string, turnId: string): AgentTurnInput {
  return {
    role: 'conversation',
    provider: 'opencode',
    capabilityProfile: 'chat-read',
    prompt: turnId,
    systemPrompt: 'test',
    scopeId,
    turnId,
    workspaceAccess: 'live-read'
  }
}

test('conversation runtime resumes one provider session and forgets it after scope close', async () => {
  const seenSessionIds: Array<string | null | undefined> = []
  const runtime = createAgentRuntime({
    async *streamTurn(turnInput) {
      seenSessionIds.push(turnInput.runtimeSessionId)
      yield {
        type: 'completed' as const,
        reply: `reply:${turnInput.turnId}`,
        runtimeSessionId: 'opencode-session-1'
      }
    }
  })
  const scopeId = buildConversationScopeId('conversation-1', 'opencode')

  await consume(runtime.runTurn(input(scopeId, 'turn-1')))
  await consume(runtime.runTurn(input(scopeId, 'turn-2')))
  assert.deepEqual(seenSessionIds, [null, 'opencode-session-1'])
  assert.equal(
    (await runtime.inspectScope(scopeId))?.binding?.providerSessionId,
    'opencode-session-1'
  )

  await runtime.closeScope(scopeId)
  assert.equal(await runtime.inspectScope(scopeId), null)

  await consume(runtime.runTurn(input(scopeId, 'turn-3')))
  assert.deepEqual(seenSessionIds, [null, 'opencode-session-1', null])
})
