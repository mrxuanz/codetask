import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  conversationMcpToolDefinitions,
  allConversationMcpToolNames
} from '../../src/server/conversation/mcp/tools.ts'

describe('conversation MCP tools (03)', () => {
  it('exposes attachment read tool only', () => {
    const names = conversationMcpToolDefinitions().map((t) => String(t.name))
    assert.deepEqual(names, ['read_reference_attachment'])
    assert.deepEqual(allConversationMcpToolNames(), ['read_reference_attachment'])
  })
})
