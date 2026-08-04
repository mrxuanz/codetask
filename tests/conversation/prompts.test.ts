import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { buildConversationSystemPrompt } from '../../src/server/conversation/prompts.ts'
import { conversationMcpToolDefinitions } from '../../src/server/conversation/mcp/tools.ts'
import { buildPlannerSystemPrompt } from '../../src/server/planner/prompts.ts'

const root = join(import.meta.dirname, '../..')

describe('conversation prompts (03 pure chat)', () => {
  it('ordinary chat system prompt does not advertise propose_task_draft', () => {
    const body = buildConversationSystemPrompt('CodeTask Conversation', {
      mode: 'chat',
      mcpToolsAvailable: true,
      customBody: null
    })
    assert.doesNotMatch(body, /propose_task_draft/)
  })

  it('conversation MCP tools are chat-only', () => {
    const names = conversationMcpToolDefinitions().map((t) => String(t.name))
    assert.ok(names.includes('read_reference_attachment'))
    assert.ok(!names.includes('propose_task_draft'))
  })

  it('planner default prompt advertises staged MCP protocol tools', () => {
    const body = buildPlannerSystemPrompt()
    assert.match(body, /register_plan_outline/)
    assert.match(body, /register_task_context/)
    assert.match(body, /finalize_plan/)
    assert.match(body, /update_task_context/)
  })

  it('create-task turn-policy and legacy wizard/draft stubs are removed', () => {
    for (const rel of [
      'src/server/conversation/turn-policy/create-task.ts',
      'src/server/legacy-wizard',
      'src/server/legacy-draft',
      'src/server/threads',
      'src/shared/design-session.ts',
      'scripts/lib/seed-cli-benchmark-shared.ts',
      'scripts/simulate-confirm-b-test.mjs',
      'scripts/reset-jobs-to-plan-edit.mjs'
    ]) {
      let exists = true
      try {
        const st = statSync(join(root, rel))
        exists = st.isFile() || st.isDirectory()
      } catch {
        exists = false
      }
      assert.equal(exists, false, rel)
    }
  })
})
