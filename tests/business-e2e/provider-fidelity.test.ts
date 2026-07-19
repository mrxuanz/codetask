import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { PublicApiClient } from './api/client'
import { htmlFileNameForConversationCore } from './config/sdk-html'
import { TOOL_DEFS } from './mcp/tools'
import { runHttpStateOracle } from './oracles/http-state'

test('thread creation requires an explicit provider core', () => {
  const createThread = TOOL_DEFS.find((tool) => tool.name === 'codetask_create_thread')
  assert.ok(createThread)
  assert.ok(createThread.inputSchema.required?.includes('coreCode'))

  const fakeDriverPath = fileURLToPath(new URL('./drivers/fake.ts', import.meta.url))
  const fakeDriver = readFileSync(fakeDriverPath, 'utf8')
  const createThreadCalls =
    fakeDriver.match(/callTool\('codetask_create_thread',[\s\S]{0,300}?\}\)/g) ?? []
  assert.ok(createThreadCalls.length > 0)
  for (const call of createThreadCalls) {
    assert.doesNotMatch(
      call,
      /coreCode:\s*['"](?:opencode|codex|cursor|cursorcli|claude-code)['"]/,
      `SUT thread provider must come from conversationCore:\n${call}`
    )
  }
})

test('provider fidelity oracle rejects a mismatched persisted thread core', async () => {
  const client = {
    request: async () => ({
      status: 200,
      data: { id: 'thread-1', coreCode: 'opencode' },
      raw: {}
    })
  } as unknown as PublicApiClient

  const results = await runHttpStateOracle({
    client,
    expectations: {
      threadId: 'thread-1',
      expectedCoreCode: 'codex'
    }
  })

  assert.equal(results.find((result) => result.name === 'thread_exists')?.passed, true)
  assert.equal(
    results.find((result) => result.name === 'thread_core_matches_provider')?.passed,
    false
  )
})

test('SDK HTML naming does not silently fall back to OpenCode', () => {
  assert.equal(htmlFileNameForConversationCore('codex'), 'codex.html')
  assert.throws(() => htmlFileNameForConversationCore(''), /conversation_core_required/)
})
