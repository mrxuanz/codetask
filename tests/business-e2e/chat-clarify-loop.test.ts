import assert from 'node:assert/strict'
import test from 'node:test'
import {
  latestAssistantText,
  looksLikeClarificationRequest,
  runChatWithClarificationLoop
} from './drivers/chat-clarify-loop'

test('clarification heuristic catches ask-for-details replies', () => {
  assert.equal(looksLikeClarificationRequest('请提供更多细节，文件名是什么？'), true)
  assert.equal(looksLikeClarificationRequest('Could you clarify which path to use?'), true)
  assert.equal(looksLikeClarificationRequest('2'), false)
  assert.equal(
    looksLikeClarificationRequest('已创建 claude.html，内容包含 BUSINESS_E2E_CHAT_HTML。'),
    false
  )
  assert.equal(looksLikeClarificationRequest('Dream of 1000 Cats'), false)
})

test('latestAssistantText reads trailing assistant content', () => {
  const text = latestAssistantText([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'first' },
    { role: 'assistant', content: 'need more details?' }
  ])
  assert.equal(text, 'need more details?')
})

test('clarify loop follows up once then stops when reply is final', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let turnCount = 0
  const mcp = {
    async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
      calls.push({ name, args })
      if (name === 'codetask_start_turn') {
        turnCount += 1
        return { turnId: `turn-${turnCount}` }
      }
      if (name === 'codetask_wait_turn') {
        return { status: 'completed' }
      }
      if (name === 'codetask_list_messages') {
        if (turnCount === 1) {
          return [
            { role: 'user', content: 'create file' },
            { role: 'assistant', content: '需要更多细节：文件名是什么？' }
          ]
        }
        return [
          { role: 'user', content: 'create file' },
          { role: 'assistant', content: '需要更多细节：文件名是什么？' },
          { role: 'user', content: 'clarify' },
          { role: 'assistant', content: '已创建 claude.html' }
        ]
      }
      throw new Error(`unexpected_tool:${name}`)
    }
  }

  const result = await runChatWithClarificationLoop(mcp, {
    threadId: 'thread-1',
    initialMessage: 'create file',
    clarifyMessage: '文件名就是 claude.html，不要再问，直接创建。',
    maxTurns: 4
  })

  assert.equal(result.turnsUsed, 2)
  assert.equal(result.clarified, true)
  assert.equal(result.turnIds.length, 2)
  assert.match(result.lastAssistantText, /已创建/)
  const startCalls = calls.filter((c) => c.name === 'codetask_start_turn')
  assert.equal(startCalls.length, 2)
  assert.equal(startCalls[1]?.args.message, '文件名就是 claude.html，不要再问，直接创建。')
})
